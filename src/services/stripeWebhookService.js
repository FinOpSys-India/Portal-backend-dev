'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const { getStripe } = require('../config/stripe');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const money = require('../utils/money');
const { logEvent } = require('../utils/auditLog');
const repo = require('../repositories/billingRepository');
const companyRepo = require('../repositories/companyRepository');
const adminEvents = require('./adminEventService');

/**
 * Stripe webhook processing — the ONLY place a service is ever activated.
 *
 * Nothing about a payment is believed because the browser said so. The success
 * page is a redirect the customer can reach by editing a URL; the truth arrives
 * here, signed by Stripe, and is verified before a single row is written.
 *
 * Three properties this file has to hold:
 *
 *   Authentic — every event is signature-verified against the raw request body
 *               (see billingWebhookRoutes: express.raw, never express.json,
 *               because JSON.parse + re-serialise changes the bytes the
 *               signature covers).
 *   Idempotent — Stripe retries until it gets a 2xx, so the same event WILL
 *               arrive more than once. The event id is claimed in stripe_events
 *               first; a duplicate is acknowledged and dropped.
 *   Ordered-safe — retries and network reordering mean an older event can land
 *               after a newer one. Cancellation is treated as terminal so a
 *               late "active" cannot resurrect a cancelled subscription.
 */

/* ------------------------------ status mapping ---------------------------- */

/**
 * Stripe subscription.status -> our SubscriptionStatus enum.
 *
 * `paused` has no exact counterpart. It maps to PAST_DUE — the closest
 * "not billing, needs attention" state — rather than to ACTIVE, so a paused
 * subscription can never read as a live entitlement.
 */
const SUBSCRIPTION_STATUS = {
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE',
  trialing: 'ACTIVE',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  paused: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
};

function mapSubscriptionStatus(stripeStatus) {
  return SUBSCRIPTION_STATUS[stripeStatus] ?? 'INCOMPLETE';
}

/**
 * Statuses that mean the company has stopped paying and is not about to resume
 * on its own.
 *
 * PAST_DUE is deliberately absent. Stripe is still retrying the card during
 * dunning and most of these recover within days, so suspending on the first
 * failed attempt would take a customer's portal away over a temporary decline.
 * UNPAID is where Stripe gives up, and CANCELED is the end of the road; those
 * are the two that mean it.
 */
const LAPSED_SUBSCRIPTION_STATUSES = new Set(['UNPAID', 'CANCELED']);

/**
 * Keep `companies.status` honest about whether the company is being paid for.
 * Call this after any write that changes a subscription's status.
 *
 * Both directions matter, and each was broken in its own way before:
 *
 *   ACTIVE   — company onboarding creates the row as ONBOARDING and stops there,
 *              so THIS is what makes a company live. The old code activated it
 *              the moment its details were submitted, which left an abandoned
 *              checkout looking exactly like a paying customer.
 *   SUSPENDED — a cancelled or unpaid subscription used to leave the company
 *              reading ACTIVE forever. The owner was locked out by
 *              requirePaidAccount, but every internal screen — the admin table,
 *              the pickers, every `status` filter — still called the account
 *              live. The same lie as the first case, pointing the other way.
 *
 * Called from several handlers on purpose. Stripe has more than one event that
 * can be the first to report a subscription live — checkout.session.completed
 * normally, but an invoice or payment_intent can arrive first, and after a lapse
 * a renewal is what recovers it — so whichever lands first must be enough. Both
 * repository calls are status-guarded `updateMany`s, so duplicates cost nothing
 * and neither can touch an ARCHIVED company.
 *
 * WHY A PAYMENT MAY UN-SUSPEND. Reactivation accepts SUSPENDED as well as
 * ONBOARDING, which means an account an admin suspended by hand comes back if a
 * renewal succeeds. That is the lesser of two wrongs: the alternative leaves
 * every customer who recovers from a failed card permanently suspended with no
 * path back, which is the common case, against an admin suspension that is rare
 * and re-appliable. If the two ever need telling apart, it takes a separate
 * column recording WHO suspended the account — not a subtler status check.
 *
 * Never throws into the caller: the payment has already been recorded by the
 * time this runs, and failing the webhook here would have Stripe retry an event
 * whose financial half already succeeded. A company left on the wrong status is
 * visibly wrong and recoverable; a re-delivered payment is neither.
 */
async function syncCompanyOnSubscriptionStatus({ companyId, status, requestId, event }) {
  if (!companyId || !status) return;

  const activating = status === 'ACTIVE';
  const lapsing = LAPSED_SUBSCRIPTION_STATUSES.has(status);
  if (!activating && !lapsing) return;

  try {
    const { count } = activating
      ? await companyRepo.activateCompanyOnPayment(prisma, companyId)
      : await companyRepo.suspendCompanyOnLapse(prisma, companyId);

    // Zero means the company was not in a state this transition applies to —
    // already live, already suspended, or archived. All are correct outcomes,
    // and none is worth an event.
    if (!count) return;

    logEvent({
      event: activating ? 'company.activated' : 'company.suspended',
      status: 'success',
      requestId,
      companyId,
      stripeEventId: event?.id,
      stripeEventType: event?.type,
      detail: activating ? 'payment_confirmed' : `subscription_${status.toLowerCase()}`,
    });
  } catch (err) {
    logger.error(`Webhook: could not sync company ${companyId} status after ${status}: ${err.message}`);
  }
}

/** Unix seconds -> Date, tolerating null. */
function toDate(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

/**
 * The current billing period of a Stripe subscription.
 *
 * Recent Stripe API versions moved `current_period_start`/`current_period_end`
 * off the subscription and onto its items (an item can now have its own
 * schedule). Both shapes are read here — the subscription-level fields when
 * present, otherwise the widest window across the items — so the handler works
 * whether or not STRIPE_API_VERSION pins an older version.
 */
function periodsOf(subscription) {
  if (subscription?.current_period_start || subscription?.current_period_end) {
    return {
      currentPeriodStart: toDate(subscription.current_period_start),
      currentPeriodEnd: toDate(subscription.current_period_end),
    };
  }
  const items = subscription?.items?.data ?? [];
  const starts = items.map((i) => i.current_period_start).filter((v) => typeof v === 'number');
  const ends = items.map((i) => i.current_period_end).filter((v) => typeof v === 'number');
  return {
    currentPeriodStart: starts.length ? toDate(Math.min(...starts)) : null,
    currentPeriodEnd: ends.length ? toDate(Math.max(...ends)) : null,
  };
}

/** The subscription id carried by an invoice, across API-version shapes. */
function subscriptionIdOfInvoice(invoice) {
  if (typeof invoice?.subscription === 'string') return invoice.subscription;
  if (invoice?.subscription?.id) return invoice.subscription.id;
  const details = invoice?.parent?.subscription_details;
  if (typeof details?.subscription === 'string') return details.subscription;
  if (details?.subscription?.id) return details.subscription.id;
  return null;
}

/** A Stripe field that may be an id string or an expanded object. */
function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

/**
 * The PaymentIntent that settled an invoice.
 *
 * `invoice.payment_intent` was removed in API 2025-09-30; the id now lives on the
 * invoice's `payments` sub-list, which webhook payloads do NOT include — so on a
 * current API version reading the old field alone silently yields null on every
 * receipt, leaving nothing to join a refund or a dispute back to. Both shapes are
 * read here, and only when neither is present is the invoice re-fetched with the
 * sub-list expanded.
 *
 * Best-effort by design: the receipt itself matters more than the cross-reference
 * on it, so a failed fetch logs and returns null rather than failing the event and
 * asking Stripe to redeliver a payment we have already recorded.
 */
async function paymentIntentIdOfInvoice(invoice) {
  const fromPayload = idOf(invoice?.payment_intent) ?? fromPaymentsList(invoice);
  if (fromPayload || !invoice?.id) return fromPayload;

  try {
    const expanded = await getStripe().invoices.retrieve(invoice.id, { expand: ['payments'] });
    return idOf(expanded?.payment_intent) ?? fromPaymentsList(expanded);
  } catch (err) {
    logger.warn(`Webhook: could not resolve payment intent for invoice ${invoice.id}: ${err.message}`);
    return null;
  }
}

/** The first PaymentIntent on an invoice's expanded `payments` sub-list. */
function fromPaymentsList(invoice) {
  for (const entry of invoice?.payments?.data ?? []) {
    const id = idOf(entry?.payment?.payment_intent);
    if (id) return id;
  }
  return null;
}

/* ------------------------- subscription resolution ------------------------ */

/**
 * Read one of our own ids back out of Stripe metadata.
 *
 * Two shapes, because recent API versions moved a subscription invoice's context
 * under `parent.subscription_details`: the metadata is on the object itself for a
 * subscription, and nested for an invoice. Metadata values are always strings, so
 * anything non-numeric is treated as absent rather than coerced.
 */
function metadataIdOf(source, key) {
  const raw = source?.metadata?.[key] ?? source?.parent?.subscription_details?.metadata?.[key];
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Resolve the local subscription for an event, whatever order it arrives in.
 *
 * `stripe_subscription_id` is claimed by whichever event lands FIRST, not only by
 * checkout.session.completed. Stripe does not guarantee delivery order and in
 * practice sends invoice.paid and customer.subscription.created ahead of it, so a
 * lookup by stripe id alone finds nothing that early — which silently dropped the
 * first invoice receipt of every subscription, permanently, because the handler
 * still answered 200 and Stripe never redelivers.
 *
 * The metadata fallback is what makes the handlers order-independent: checkout
 * copies `company_subscription_id` onto subscription_data, so every subscription
 * and invoice event carries our own row id. Linking on first sight puts all later
 * events back on the fast path.
 */
async function resolveSubscription({ stripeSubscriptionId, source }) {
  if (stripeSubscriptionId) {
    const bySub = await repo.findSubscriptionByStripeId(prisma, stripeSubscriptionId);
    if (bySub) return bySub;
  }

  const localId = metadataIdOf(source, 'company_subscription_id');
  if (!localId) return null;

  const row = await repo.findSubscriptionById(prisma, localId);
  if (!row) return null;

  /*
   * Metadata is semi-public — visible to anyone with dashboard access and echoed
   * back in webhooks — so it is never accepted as proof of ownership on its own.
   * Same cross-check handleCheckoutCompleted already performs on the session.
   */
  const metaCompanyId = metadataIdOf(source, 'company_id');
  if (metaCompanyId && metaCompanyId !== row.companyId) {
    logger.error(
      `Webhook: metadata company ${metaCompanyId} != subscription ${row.id} company ${row.companyId}; refusing to link.`
    );
    return null;
  }

  if (!stripeSubscriptionId || row.stripeSubscriptionId) return row;

  /*
   * Two early events can race to claim the link. The column is unique, so the
   * loser takes P2002 — its write is redundant by definition, since the winner
   * stored the same id, so it re-reads instead of failing the event.
   */
  try {
    await repo.updateSubscription(prisma, row.id, { stripeSubscriptionId });
    return { ...row, stripeSubscriptionId };
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    return (await repo.findSubscriptionByStripeId(prisma, stripeSubscriptionId)) ?? row;
  }
}

/* --------------------------- event ordering ------------------------------- */

/**
 * When this event was created, per Stripe. Second resolution, which is why the
 * comparison below is strict: events created in the same second (a checkout
 * completing and its subscription being created, say) must all be applied.
 */
function eventCreatedAt(event) {
  return toDate(event?.created) ?? new Date();
}

/**
 * Has this row already been advanced past this event?
 *
 * `company_subscriptions.last_stripe_event_at` is a high-water mark of the newest
 * event whose STATE has been applied. Stripe retries and network reordering mean
 * an older event can genuinely arrive after a newer one; applying it would move
 * the subscription backwards — a stale `past_due` landing after `active` marks a
 * paying company unpaid, and nothing would ever correct it, because the correct
 * event has already been delivered and acknowledged.
 *
 * Deliberately NOT consulted for writing invoice receipts: skipping one of those
 * would lose a payment record. Receipts are idempotent on their own, through the
 * unique on `stripe_invoice_id`.
 */
function isStaleEvent(subscription, event) {
  const mark = subscription?.lastStripeEventAt;
  if (!mark) return false;
  return eventCreatedAt(event).getTime() < new Date(mark).getTime();
}

/** Log and count an event dropped for being out of order. */
function logStale(event, subscription, requestId, detail) {
  logger.warn(
    `Webhook: ignoring out-of-order ${event.type} (${event.id}) for subscription ${subscription.id}; ` +
      `event is older than ${new Date(subscription.lastStripeEventAt).toISOString()}.`
  );
  logEvent({
    event: 'billing.webhook.out_of_order_ignored',
    status: 'skipped',
    requestId,
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    detail,
  });
}

/* ---------------------------- signature + intake -------------------------- */

/**
 * Verify the signature and return the parsed event.
 *
 * `rawBody` must be the exact bytes Stripe sent. A verification failure is a 400
 * with WEBHOOK_SIGNATURE_INVALID and is never retried usefully — either the
 * signing secret is wrong or the request is forged, and both need a human.
 */
function constructEvent({ rawBody, signature }) {
  if (!config.stripe.webhookSecret) {
    logger.error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set; refusing to process.');
    throw new ApiError(503, 'Billing is not available right now.', { code: 'STRIPE_NOT_CONFIGURED' });
  }
  if (!signature) {
    throw new ApiError(400, 'Missing Stripe signature.', { code: 'WEBHOOK_SIGNATURE_INVALID' });
  }
  try {
    return getStripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch (err) {
    logger.error(`Stripe webhook signature verification failed: ${err.message}`);
    throw new ApiError(400, 'Invalid webhook signature.', { code: 'WEBHOOK_SIGNATURE_INVALID' });
  }
}

/**
 * Claim an event id, or report that it has already been handled.
 *
 * The row is inserted BEFORE the event is processed and stamped `processed_at`
 * only on success. That distinction matters: a duplicate delivery of a completed
 * event is dropped, but a redelivery of one that crashed mid-processing is
 * allowed to run again, so a transient database failure does not silently lose a
 * payment.
 */
async function claimEvent(event) {
  const existing = await repo.findStripeEvent(prisma, event.id);
  if (existing) {
    if (existing.processedAt) return { duplicate: true, record: existing };
    return { duplicate: false, record: existing };
  }
  try {
    const record = await repo.createStripeEvent(prisma, {
      stripeEventId: event.id,
      eventType: event.type,
    });
    return { duplicate: false, record };
  } catch (err) {
    // Lost the race with a concurrent delivery of the same event.
    if (err.code === 'P2002') {
      const winner = await repo.findStripeEvent(prisma, event.id);
      return { duplicate: Boolean(winner?.processedAt), record: winner };
    }
    throw err;
  }
}

/* --------------------------- catalog reconciliation ----------------------- */

/**
 * Re-verify what Stripe says was bought against our own catalog.
 *
 * The checkout path already proved every price belonged to its product before
 * the redirect; this is the second, independent check the requirement asks for,
 * run against what Stripe actually billed. A price we do not recognise, or one
 * that has moved to a different product, is logged loudly and excluded — it is
 * not allowed to activate anything.
 */
async function reconcileLineItems({ sessionId, requestId, companyId }) {
  const stripe = getStripe();
  const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });

  const priceIds = lineItems.data.map((li) => idOf(li.price)).filter(Boolean);
  const plans = await repo.findPlansByStripePriceIds(prisma, priceIds);
  const byPriceId = new Map(plans.map((p) => [p.stripePriceId, p]));

  const recognised = [];
  for (const item of lineItems.data) {
    const priceId = idOf(item.price);
    const plan = priceId ? byPriceId.get(priceId) : null;

    if (!plan) {
      logger.error(`Webhook: session ${sessionId} contains unknown price ${priceId}; not activating it.`);
      logEvent({
        event: 'billing.webhook.unknown_price',
        status: 'error',
        requestId,
        companyId,
        stripeCheckoutSessionId: sessionId,
        stripePriceIds: priceId ? [priceId] : undefined,
        errorCode: 'STRIPE_PRICE_NOT_FOUND',
      });
      continue;
    }

    const productId = idOf(item.price?.product);
    if (productId && productId !== plan.stripeProductId) {
      logger.error(
        `Webhook: price ${priceId} billed under product ${productId}, catalog says ${plan.stripeProductId}; not activating it.`
      );
      logEvent({
        event: 'billing.webhook.product_mismatch',
        status: 'error',
        requestId,
        companyId,
        stripeCheckoutSessionId: sessionId,
        stripePriceIds: [priceId],
        errorCode: 'STRIPE_PRODUCT_PRICE_MISMATCH',
      });
      continue;
    }

    recognised.push({ plan, quantity: item.quantity ?? 1, priceId });
  }

  return recognised;
}

/* ------------------------------- handlers --------------------------------- */

/**
 * checkout.session.completed — the moment a selection becomes a subscription.
 *
 * Everything is re-derived from Stripe: the customer, the line items, the
 * subscription status and period. The request that started the checkout is not
 * consulted at all, so a tampered original request cannot survive to this point.
 */
async function handleCheckoutCompleted(event, { requestId }) {
  const session = event.data.object;

  const subscription = await repo.findSubscriptionByCheckoutSessionId(prisma, session.id);
  if (!subscription) {
    // A session this backend did not create, or one whose id write failed before
    // the redirect. Acknowledged so Stripe stops retrying; logged so it is visible.
    logger.warn(`Webhook: no local subscription for checkout session ${session.id}.`);
    logEvent({
      event: 'billing.webhook.unknown_session',
      status: 'failure',
      requestId,
      stripeCheckoutSessionId: session.id,
      stripeEventId: event.id,
      errorCode: 'CHECKOUT_SESSION_NOT_FOUND',
    });
    return { handled: false, reason: 'unknown_session' };
  }

  const companyId = subscription.companyId;

  /*
   * Order-guarded for STATE only — never for the Stripe id linkage below.
   *
   * This handler is the ONLY writer of `stripe_subscription_item_id`, and Stripe
   * routinely delivers invoice.paid and customer.subscription.created ahead of
   * checkout.session.completed. Those handlers stamp the high-water mark, so
   * returning early here left every item id permanently null — and a later
   * head-count change then had no Stripe item to act on, falling through to the
   * create branch and adding a duplicate line to the subscription.
   *
   * Same split the invoice handler already makes for the same reason: identifiers
   * are written regardless of arrival order, status and period are not.
   */
  const stale = isStaleEvent(subscription, event);
  if (stale) logStale(event, subscription, requestId, 'checkout_completed');

  // The metadata is ours, so a mismatch means the session was assembled by
  // something else. Refuse to act on it rather than guess which side is right.
  const metaCompanyId = Number(session.metadata?.company_id);
  if (Number.isInteger(metaCompanyId) && metaCompanyId !== companyId) {
    logger.error(`Webhook: session ${session.id} metadata company ${metaCompanyId} != subscription company ${companyId}.`);
    logEvent({
      event: 'billing.webhook.company_mismatch',
      status: 'error',
      requestId,
      companyId,
      stripeCheckoutSessionId: session.id,
      stripeEventId: event.id,
      errorCode: 'WEBHOOK_PROCESSING_FAILED',
    });
    return { handled: false, reason: 'company_mismatch' };
  }

  const customerId = idOf(session.customer);
  const recognised = await reconcileLineItems({ sessionId: session.id, requestId, companyId });

  /*
   * Backfill the customer id if checkout somehow completed without it stored —
   * outside the transaction below, deliberately. `stripe_customer_id` is unique,
   * so this write can fail with P2002, and in Postgres a failed statement aborts
   * the whole transaction: every later write would fail too. Keeping it out here
   * means a customer-id clash costs a warning, not the activation.
   */
  if (customerId) {
    const company = await companyRepo.findCompanyById(prisma, companyId);
    if (company && company.stripeCustomerId !== customerId) {
      if (company.stripeCustomerId) {
        logger.warn(
          `Webhook: company ${companyId} is stored against customer ${company.stripeCustomerId} but was billed as ${customerId}.`
        );
      } else {
        try {
          await repo.setCompanyStripeCustomerId(prisma, companyId, customerId);
        } catch (err) {
          logger.warn(`Webhook: could not set customer ${customerId} on company ${companyId}: ${err.message}`);
        }
      }
    }
  }

  let stripeSubscription = null;
  const stripeSubscriptionId = idOf(session.subscription);
  if (stripeSubscriptionId) {
    stripeSubscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
  }

  const periods = periodsOf(stripeSubscription);
  const status = stripeSubscription
    ? mapSubscriptionStatus(stripeSubscription.status)
    : session.payment_status === 'paid'
      ? 'ACTIVE'
      : 'INCOMPLETE';

  // Stripe subscription items carry the ids we need on our own item rows, so a
  // later quantity change can be applied to the right line.
  const stripeItemsByPrice = new Map(
    (stripeSubscription?.items?.data ?? []).map((item) => [idOf(item.price), item])
  );

  // Written whatever the arrival order. Skipped when another handler already
  // claimed the id, so the unique column is never re-set to the value it holds.
  const linkage =
    stripeSubscriptionId && subscription.stripeSubscriptionId !== stripeSubscriptionId
      ? { stripeSubscriptionId }
      : {};

  // Withheld when this event is older than what has already been applied.
  const state = stale
    ? {}
    : {
        status,
        ...periods,
        cancelAtPeriodEnd: Boolean(stripeSubscription?.cancel_at_period_end),
        lastStripeEventAt: eventCreatedAt(event),
      };

  await prisma.$transaction(async (tx) => {
    const changes = { ...linkage, ...state };
    if (Object.keys(changes).length) {
      await repo.updateSubscription(tx, subscription.id, changes);
    }

    for (const { plan, quantity } of recognised) {
      const ours = subscription.items.find((i) => i.servicePlanId === plan.id);
      if (!ours) {
        logger.warn(`Webhook: session ${session.id} billed plan ${plan.planCode} with no matching local item.`);
        continue;
      }
      const stripeItem = stripeItemsByPrice.get(plan.stripePriceId);
      // Stripe is authoritative for what was billed: if the quantities disagree,
      // ours is corrected, never the other way round.
      if (ours.quantity !== quantity) {
        logger.warn(
          `Webhook: plan ${plan.planCode} billed quantity ${quantity}, local item recorded ${ours.quantity}; correcting.`
        );
      }
      await repo.updateSubscriptionItem(tx, ours.id, {
        quantity,
        ...(stripeItem ? { stripeSubscriptionItemId: stripeItem.id } : {}),
      });
    }
  });

  // The normal path: checkout completed, so the company is now paid for and
  // stops being an ONBOARDING shell. After the transaction, never inside it —
  // a company must not read ACTIVE off a subscription write that rolled back.
  await syncCompanyOnSubscriptionStatus({ companyId: subscription.companyId, status, requestId, event });

  /*
   * The company has just started paying for something, so its Active Services
   * and Billing Date have changed. Published after the transaction above has
   * committed — a webhook that announced services a rollback then discarded
   * would leave every open admin screen showing a subscription that does not
   * exist.
   */
  adminEvents.companyServicesChanged({
    companyId,
    subscriptionId: subscription.id,
    status: stale ? subscription.status : status,
  });

  logEvent({
    event: 'billing.subscription.activated',
    status: 'success',
    requestId,
    companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeCheckoutSessionId: session.id,
    stripeSubscriptionId,
    stripeCustomerId: customerId,
    planCodes: recognised.map((r) => r.plan.planCode),
    detail: stale ? `${subscription.status} (ids linked, state withheld)` : status,
  });

  return {
    handled: true,
    subscriptionId: subscription.id,
    status: stale ? subscription.status : status,
    staleState: stale,
  };
}

/**
 * checkout.session.async_payment_failed — a delayed payment method (bank debit,
 * voucher) ultimately failed. The subscription must not stay hopeful.
 */
async function handleAsyncPaymentFailed(event, { requestId }) {
  const session = event.data.object;
  const subscription = await repo.findSubscriptionByCheckoutSessionId(prisma, session.id);
  if (!subscription) return { handled: false, reason: 'unknown_session' };

  if (isStaleEvent(subscription, event)) {
    logStale(event, subscription, requestId, 'async_payment_failed');
    return { handled: true, skipped: true };
  }

  await repo.updateSubscription(prisma, subscription.id, {
    status: 'UNPAID',
    lastStripeEventAt: eventCreatedAt(event),
  });

  await syncCompanyOnSubscriptionStatus({
    companyId: subscription.companyId,
    status: 'UNPAID',
    requestId,
    event,
  });

  logEvent({
    event: 'billing.payment.failed',
    status: 'failure',
    requestId,
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeCheckoutSessionId: session.id,
    errorCode: 'PAYMENT_FAILED',
  });

  return { handled: true, subscriptionId: subscription.id };
}

/**
 * customer.subscription.created / updated / deleted.
 *
 * Out-of-order protection lives here: once a subscription is CANCELED that is
 * treated as terminal, and a later event claiming it is active is ignored. Stripe
 * retries can genuinely deliver a stale `updated` after a `deleted`, and applying
 * it would silently restore an entitlement the customer no longer pays for.
 */
async function handleSubscriptionLifecycle(event, { requestId }) {
  const stripeSubscription = event.data.object;
  const stripeSubscriptionId = stripeSubscription.id;

  const subscription = await resolveSubscription({ stripeSubscriptionId, source: stripeSubscription });
  if (!subscription) {
    logger.warn(`Webhook: no local subscription for stripe subscription ${stripeSubscriptionId}.`);
    return { handled: false, reason: 'unknown_subscription' };
  }

  const nextStatus = mapSubscriptionStatus(stripeSubscription.status);

  if (isStaleEvent(subscription, event)) {
    logStale(event, subscription, requestId, nextStatus);
    return { handled: true, skipped: true };
  }

  /*
   * Kept alongside the timestamp guard rather than replaced by it. Stripe's
   * `created` has one-second resolution, and a cancellation and its trailing
   * update very often share a second — which is exactly the case the high-water
   * mark cannot discriminate. Cancellation stays terminal.
   */
  if (subscription.status === 'CANCELED' && nextStatus !== 'CANCELED') {
    logger.warn(
      `Webhook: ignoring ${event.type} moving cancelled subscription ${subscription.id} to ${nextStatus}.`
    );
    logEvent({
      event: 'billing.webhook.out_of_order_ignored',
      status: 'skipped',
      requestId,
      companyId: subscription.companyId,
      subscriptionId: subscription.id,
      stripeEventId: event.id,
      stripeEventType: event.type,
      detail: nextStatus,
    });
    return { handled: true, skipped: true };
  }

  await repo.updateSubscription(prisma, subscription.id, {
    status: nextStatus,
    ...periodsOf(stripeSubscription),
    cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
    canceledAt: toDate(stripeSubscription.canceled_at),
    lastStripeEventAt: eventCreatedAt(event),
  });

  // A lifecycle event can be the first thing to report the subscription live —
  // notably when checkout.session.completed is delayed or lost.
  await syncCompanyOnSubscriptionStatus({ companyId: subscription.companyId, status: nextStatus, requestId, event });

  // past_due, cancelled, renewed: all of them change what the admin table shows
  // in Active Services and Billing Date.
  adminEvents.companyServicesChanged({
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    status: nextStatus,
  });

  logEvent({
    event: 'billing.subscription.updated',
    status: 'success',
    requestId,
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeSubscriptionId,
    detail: nextStatus,
  });

  return { handled: true, subscriptionId: subscription.id, status: nextStatus };
}

/**
 * invoice.paid / invoice.payment_failed — the recurring money events.
 *
 * `company_payments` is the immutable receipt: the amount is copied from the
 * invoice, never recomputed from the plan catalog, so a historical receipt stays
 * true after a price change. The unique on stripe_invoice_id is what makes a
 * redelivered invoice event a no-op.
 */
/**
 * Write (or correct) the `company_payments` row for one invoice.
 *
 * Split out of the handler so reconciliation can replay a whole invoice history
 * through exactly the same code the live webhook uses — one definition of what a
 * receipt is, rather than two that drift.
 *
 * Idempotent by the unique on `stripe_invoice_id`: an invoice already recorded is
 * updated in place, and a concurrent insert that loses the index is swallowed.
 */
async function writeInvoiceReceipt({ invoice, subscription, paid }) {
  const currency = String(invoice.currency || config.billing.supportedCurrency).toUpperCase();
  const amountMinor = paid ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0);

  const payload = {
    companyId: subscription.companyId,
    companySubscriptionId: subscription.id,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: await paymentIntentIdOfInvoice(invoice),
    // Stored so a later refund or dispute — both of which identify the payment by
    // CHARGE and by nothing else — can be matched back to this receipt.
    stripeChargeId: idOf(invoice.charge),
    amountPaid: money.minorToDecimalString(amountMinor, currency),
    currency,
    status: paid ? 'PAID' : 'FAILED',
    paidAt: paid ? toDate(invoice.status_transitions?.paid_at) ?? new Date() : null,
    failureReason: paid ? null : String(invoice.last_finalization_error?.code || 'payment_failed').slice(0, 255),
  };

  const existing = invoice.id ? await repo.findPaymentByInvoiceId(prisma, invoice.id) : null;
  if (existing) {
    await repo.updatePayment(prisma, existing.id, payload);
  } else {
    try {
      await repo.createPayment(prisma, payload);
    } catch (err) {
      // Concurrent delivery of the same invoice event won the unique index.
      if (err.code !== 'P2002') throw err;
    }
  }

  return { payload, amountMinor, currency };
}

async function handleInvoice(event, { requestId, paid }) {
  const invoice = event.data.object;
  const stripeSubscriptionId = subscriptionIdOfInvoice(invoice);

  const subscription = await resolveSubscription({ stripeSubscriptionId, source: invoice });

  if (!subscription) {
    logger.warn(`Webhook: invoice ${invoice.id} has no local subscription (${stripeSubscriptionId}).`);
    return { handled: false, reason: 'unknown_subscription' };
  }

  const { payload, amountMinor, currency } = await writeInvoiceReceipt({ invoice, subscription, paid });

  /*
   * A failed renewal must show up on the subscription too, or the company keeps
   * reading as ACTIVE while its invoice is unpaid — and a recovered payment must
   * clear it again. Only THIS side of the handler is order-guarded: the receipt
   * above is written regardless, because dropping it would lose a payment record,
   * while a status move applied out of order would be actively wrong.
   */
  const stale = isStaleEvent(subscription, event);
  if (stale) {
    logStale(event, subscription, requestId, paid ? 'invoice_paid' : 'invoice_failed');
  } else {
    const nextStatus = !paid && subscription.status === 'ACTIVE'
      ? 'PAST_DUE'
      : paid && ['PAST_DUE', 'UNPAID', 'INCOMPLETE'].includes(subscription.status)
        ? 'ACTIVE'
        : null;
    if (nextStatus) {
      await repo.updateSubscription(prisma, subscription.id, {
        status: nextStatus,
        lastStripeEventAt: eventCreatedAt(event),
      });
      // A paid invoice recovering an INCOMPLETE subscription is a first payment
      // whose checkout event never arrived.
      await syncCompanyOnSubscriptionStatus({ companyId: subscription.companyId, status: nextStatus, requestId, event });
    }
  }

  logEvent({
    event: paid ? 'billing.invoice.paid' : 'billing.invoice.failed',
    status: paid ? 'success' : 'failure',
    requestId,
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: payload.stripePaymentIntentId,
    amountMinor,
    currency,
    ...(paid ? {} : { errorCode: 'PAYMENT_FAILED' }),
  });

  return { handled: true, subscriptionId: subscription.id };
}

/**
 * payment_intent.succeeded / payment_intent.payment_failed.
 *
 * Subscription billing settles through invoices, so these are informational for
 * the current catalog (every plan is recurring). They are still recorded, because
 * a one-time `mode: 'payment'` session — which this backend will assemble if a
 * plan is ever repriced as one-off — settles here and nowhere else.
 */
async function handlePaymentIntent(event, { requestId, succeeded }) {
  const intent = event.data.object;
  const subscriptionId = Number(intent.metadata?.company_subscription_id);

  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return { handled: false, reason: 'no_subscription_metadata' };
  }

  const subscription = await repo.findSubscriptionById(prisma, subscriptionId);
  if (!subscription) return { handled: false, reason: 'unknown_subscription' };

  /*
   * The receipt for a one-time purchase. A subscription charge already has its
   * row from the invoice handler, and re-inserting here would duplicate it.
   *
   * `intent.invoice` no longer carries that distinction on its own: API 2025-09-30
   * removed the field, so it reads undefined for subscription and one-time intents
   * alike. It is kept as a cheap early-out for older pinned versions, and two other
   * things hold the line on a current one. Only a `mode: 'payment'` checkout puts
   * metadata on the intent — subscription metadata goes on subscription_data — so a
   * subscription charge has already returned at the metadata check above. And the
   * partial unique on stripe_payment_intent_id rejects a second row for a charge the
   * invoice handler recorded, which works only because that column is now actually
   * populated (see paymentIntentIdOfInvoice); while it sat null, this insert had
   * nothing to collide with. The same unique makes a redelivery a no-op.
   */
  if (succeeded && !idOf(intent.invoice)) {
    const currency = String(intent.currency || config.billing.supportedCurrency).toUpperCase();
    try {
      await repo.createPayment(prisma, {
        companyId: subscription.companyId,
        companySubscriptionId: subscription.id,
        stripePaymentIntentId: intent.id,
        amountPaid: money.minorToDecimalString(intent.amount_received ?? intent.amount ?? 0, currency),
        currency,
        status: 'PAID',
        paidAt: new Date(),
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }

  if (isStaleEvent(subscription, event)) {
    logStale(event, subscription, requestId, succeeded ? 'payment_succeeded' : 'payment_failed');
    return { handled: true, skipped: true };
  }

  await repo.updateSubscription(prisma, subscription.id, {
    status: succeeded ? 'ACTIVE' : 'UNPAID',
    lastStripeEventAt: eventCreatedAt(event),
  });

  await syncCompanyOnSubscriptionStatus({
    companyId: subscription.companyId,
    status: succeeded ? 'ACTIVE' : 'UNPAID',
    requestId,
    event,
  });

  logEvent({
    event: succeeded ? 'billing.payment.succeeded' : 'billing.payment.failed',
    status: succeeded ? 'success' : 'failure',
    requestId,
    companyId: subscription.companyId,
    subscriptionId: subscription.id,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripePaymentIntentId: intent.id,
    amountMinor: intent.amount ?? undefined,
    currency: intent.currency ? String(intent.currency).toUpperCase() : undefined,
    ...(succeeded ? {} : { errorCode: 'PAYMENT_FAILED' }),
  });

  return { handled: true, subscriptionId: subscription.id };
}

/* -------------------------------- refunds --------------------------------- */

/**
 * charge.refunded — money went back to the customer.
 *
 * PaymentStatus.REFUNDED existed in the enum from the beginning and nothing ever
 * wrote it, so a refunded invoice kept displaying as PAID indefinitely: the
 * billing history in the portal contradicted the customer's bank statement, and
 * support had no way to reconcile the two.
 *
 * `amount_refunded` is tracked in its own column rather than by reducing
 * `amount_paid`. The receipt of what was actually charged has to stay true — a
 * record that silently rewrites itself is not a record — and a PARTIAL refund
 * has to be expressible at all, which subtracting cannot do without destroying
 * the original figure.
 *
 * The status therefore reflects the RELATIONSHIP between the two amounts rather
 * than the mere presence of a refund: fully refunded is REFUNDED, partially
 * refunded stays PAID (the customer did pay, and still owes nothing more), and
 * the amounts tell the rest of the story.
 */
async function handleChargeRefunded(event, { requestId }) {
  const charge = event.data.object;

  const payment = await findPaymentForCharge(charge);
  if (!payment) {
    logger.warn(`Webhook: charge ${charge.id} refunded but no local payment row matches it.`);
    logEvent({
      event: 'billing.refund.unmatched',
      status: 'failure',
      requestId,
      stripeEventId: event.id,
      stripeEventType: event.type,
      errorCode: 'PAYMENT_NOT_FOUND',
    });
    return { handled: false, reason: 'unknown_payment' };
  }

  const currency = String(charge.currency || payment.currency).toUpperCase();
  const refundedMinor = charge.amount_refunded ?? 0;
  const paidMinor = money.decimalToMinor(payment.amountPaid, currency);

  // Stripe is authoritative for the amount, but the CHECK constraint refuses a
  // refund larger than the recorded charge. Clamping keeps a rounding or
  // currency-scale surprise from failing the event and asking Stripe to redeliver
  // a refund we have already seen.
  const applied = Math.min(refundedMinor, paidMinor);
  if (applied !== refundedMinor) {
    logger.warn(
      `Webhook: charge ${charge.id} reports ${refundedMinor} refunded but the local payment records ${paidMinor} paid; clamping.`
    );
  }

  const fullyRefunded = applied >= paidMinor && paidMinor > 0;

  await repo.updatePayment(prisma, payment.id, {
    amountRefunded: money.minorToDecimalString(applied, currency),
    refundedAt: applied > 0 ? new Date() : null,
    status: fullyRefunded ? 'REFUNDED' : payment.status,
    stripeChargeId: charge.id,
  });

  logEvent({
    event: 'billing.refund.recorded',
    status: 'success',
    requestId,
    companyId: payment.companyId,
    subscriptionId: payment.companySubscriptionId ?? undefined,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeInvoiceId: payment.stripeInvoiceId ?? undefined,
    amountMinor: applied,
    currency,
    detail: fullyRefunded ? 'full' : 'partial',
  });

  return { handled: true, paymentId: payment.id, fullyRefunded };
}

/**
 * charge.dispute.created — the customer charged back.
 *
 * Recorded rather than acted on. A dispute is not a refund and must not silently
 * cancel a subscription: it may be resolved in the merchant's favour, and
 * cutting the customer's service on the strength of an unresolved claim is a
 * business decision, not a webhook's. What matters here is that the payment stops
 * reading as a clean PAID with nothing attached.
 */
async function handleDisputeCreated(event, { requestId }) {
  const dispute = event.data.object;
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return { handled: false, reason: 'no_charge' };

  const payment = await repo.findPaymentByChargeId(prisma, chargeId);
  if (!payment) {
    logger.warn(`Webhook: dispute on charge ${chargeId} but no local payment row matches it.`);
    return { handled: false, reason: 'unknown_payment' };
  }

  await repo.updatePayment(prisma, payment.id, {
    failureReason: String(dispute.reason || 'disputed').slice(0, 255),
  });

  logEvent({
    event: 'billing.dispute.opened',
    status: 'failure',
    requestId,
    companyId: payment.companyId,
    subscriptionId: payment.companySubscriptionId ?? undefined,
    stripeEventId: event.id,
    stripeEventType: event.type,
    amountMinor: dispute.amount ?? undefined,
    currency: dispute.currency ? String(dispute.currency).toUpperCase() : undefined,
    errorCode: 'PAYMENT_DISPUTED',
    detail: String(dispute.reason || 'unknown'),
  });

  return { handled: true, paymentId: payment.id };
}

/**
 * Find the receipt a charge belongs to.
 *
 * Three routes, because which identifier is available depends on how the payment
 * was made and on the API version: the charge id (once we have stored it), the
 * PaymentIntent (a one-time checkout), or the invoice (a subscription renewal).
 * The first match wins, and the charge id is written back so the next event on
 * this payment takes the cheap path.
 */
async function findPaymentForCharge(charge) {
  const byCharge = await repo.findPaymentByChargeId(prisma, charge.id);
  if (byCharge) return byCharge;

  const intentId = idOf(charge.payment_intent);
  if (intentId) {
    const byIntent = await repo.findPaymentByPaymentIntentId(prisma, intentId);
    if (byIntent) return byIntent;
  }

  const invoiceId = idOf(charge.invoice);
  if (invoiceId) {
    const byInvoice = await repo.findPaymentByInvoiceId(prisma, invoiceId);
    if (byInvoice) return byInvoice;
  }

  return null;
}

/* ----------------------------- reconciliation ----------------------------- */

/**
 * Re-write every paid invoice on a subscription as a local receipt.
 *
 * Only `paid` invoices are backfilled. A `void` or `draft` one is not a payment,
 * and an `open` one has not settled yet — recording either as a receipt would put
 * money in the ledger that Stripe never took. Failures are left to the live
 * `invoice.payment_failed` webhook, which carries the decline reason this listing
 * does not.
 */
async function backfillInvoices({ subscription }) {
  if (!subscription?.stripeSubscriptionId) return 0;

  let invoices;
  try {
    invoices = await getStripe().invoices.list({
      subscription: subscription.stripeSubscriptionId,
      limit: 100,
    });
  } catch (err) {
    logger.warn(`Reconcile: could not list invoices for ${subscription.stripeSubscriptionId}: ${err.message}`);
    return 0;
  }

  let written = 0;
  for (const invoice of invoices.data) {
    if (invoice.status !== 'paid') continue;
    await writeInvoiceReceipt({ invoice, subscription, paid: true });
    written += 1;
  }
  return written;
}

/**
 * Rebuild a subscription's local state directly from Stripe.
 *
 * The webhook is the normal path and stays the only one that can activate a
 * service on Stripe's word alone. This is the recovery path for when that word
 * never arrived — the listener was down, the tunnel died, the endpoint 500'd past
 * Stripe's retry window. Without it a completed payment stays INCOMPLETE forever,
 * because Stripe does not redeliver indefinitely and nothing else ever asks.
 *
 * Safety comes from where the facts are read, not from who called: the session,
 * the subscription and the invoices are all fetched from Stripe here, and the
 * work is then handed to the very same handler a webhook would have run. A caller
 * cannot inject an amount, a price or a status — it only supplies a session id,
 * and an unpaid session is refused outright.
 *
 * The synthetic event is stamped NOW deliberately. What it carries was read live
 * from Stripe seconds ago, which makes it the freshest truth in the system — so
 * it should win the high-water-mark comparison, and a redelivery of some older
 * event afterwards should still lose it.
 */
async function reconcileFromCheckoutSession({ sessionId, requestId }) {
  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    logger.warn(`Reconcile: could not read checkout session ${sessionId}: ${err.message}`);
    return { reconciled: false, reason: 'session_unreadable' };
  }

  if (session.status !== 'complete' || session.payment_status === 'unpaid') {
    return { reconciled: false, reason: 'not_paid' };
  }

  const synthetic = {
    id: `reconcile:${sessionId}`,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: { object: session },
  };

  const result = await handleCheckoutCompleted(synthetic, { requestId });
  if (!result.handled) return { reconciled: false, reason: result.reason };

  // Re-read: the handler has just linked the Stripe subscription id the invoice
  // listing needs, and the row loaded before it ran did not have one.
  const subscription = await repo.findSubscriptionById(prisma, result.subscriptionId);
  const receipts = await backfillInvoices({ subscription });

  logger.info(
    `Reconciled subscription ${result.subscriptionId} from session ${sessionId}: ` +
      `status ${result.status}, ${receipts} receipt(s).`
  );
  logEvent({
    event: 'billing.subscription.reconciled',
    status: 'success',
    requestId,
    companyId: subscription?.companyId,
    subscriptionId: result.subscriptionId,
    stripeCheckoutSessionId: sessionId,
    stripeSubscriptionId: subscription?.stripeSubscriptionId ?? undefined,
    detail: `${result.status}, ${receipts} receipt(s)`,
  });

  return {
    reconciled: true,
    subscriptionId: result.subscriptionId,
    status: result.status,
    receipts,
  };
}

/* ------------------------------- dispatch --------------------------------- */

const HANDLERS = {
  'checkout.session.completed': (e, ctx) => handleCheckoutCompleted(e, ctx),
  'checkout.session.async_payment_succeeded': (e, ctx) => handleCheckoutCompleted(e, ctx),
  'checkout.session.async_payment_failed': (e, ctx) => handleAsyncPaymentFailed(e, ctx),
  'customer.subscription.created': (e, ctx) => handleSubscriptionLifecycle(e, ctx),
  'customer.subscription.updated': (e, ctx) => handleSubscriptionLifecycle(e, ctx),
  'customer.subscription.deleted': (e, ctx) => handleSubscriptionLifecycle(e, ctx),
  'invoice.paid': (e, ctx) => handleInvoice(e, { ...ctx, paid: true }),
  'invoice.payment_failed': (e, ctx) => handleInvoice(e, { ...ctx, paid: false }),
  'payment_intent.succeeded': (e, ctx) => handlePaymentIntent(e, { ...ctx, succeeded: true }),
  'payment_intent.payment_failed': (e, ctx) => handlePaymentIntent(e, { ...ctx, succeeded: false }),
  // Refunds and chargebacks. Without these, PaymentStatus.REFUNDED was
  // unreachable and a refunded invoice still read as PAID forever.
  'charge.refunded': (e, ctx) => handleChargeRefunded(e, ctx),
  'charge.dispute.created': (e, ctx) => handleDisputeCreated(e, ctx),
};

/**
 * Verify, deduplicate, and dispatch one webhook delivery.
 *
 * @param {Buffer} rawBody   Unparsed request body — required for signature checking.
 * @param {string} signature The Stripe-Signature header.
 * @param {string} requestId Correlation id for the log line.
 * @returns {Promise<{ received: true, eventId: string, eventType: string, duplicate: boolean }>}
 */
async function processWebhook({ rawBody, signature, requestId }) {
  const event = constructEvent({ rawBody, signature });

  const { duplicate, record } = await claimEvent(event);
  if (duplicate) {
    logEvent({
      event: 'billing.webhook.duplicate',
      status: 'skipped',
      requestId,
      stripeEventId: event.id,
      stripeEventType: event.type,
      idempotent: true,
    });
    return { received: true, eventId: event.id, eventType: event.type, duplicate: true };
  }

  const handler = HANDLERS[event.type];
  if (!handler) {
    // Acknowledged, not processed: an endpoint subscribed to more events than it
    // handles must still 2xx, or Stripe retries them forever.
    await repo.markStripeEventProcessed(prisma, record.id, new Date());
    logEvent({
      event: 'billing.webhook.ignored',
      status: 'skipped',
      requestId,
      stripeEventId: event.id,
      stripeEventType: event.type,
    });
    return { received: true, eventId: event.id, eventType: event.type, duplicate: false };
  }

  try {
    const result = await handler(event, { requestId });
    await repo.markStripeEventProcessed(prisma, record.id, new Date());
    return { received: true, eventId: event.id, eventType: event.type, duplicate: false, ...result };
  } catch (err) {
    /*
     * Left UNPROCESSED on purpose: processed_at is not stamped, so Stripe's next
     * retry re-runs this event instead of finding it already claimed. The
     * alternative — acknowledging a failure — loses the payment silently.
     */
    logger.error(`[${requestId}] Webhook ${event.type} (${event.id}) failed: ${err.stack || err.message}`);
    logEvent({
      event: 'billing.webhook.failed',
      status: 'error',
      requestId,
      stripeEventId: event.id,
      stripeEventType: event.type,
      errorCode: 'WEBHOOK_PROCESSING_FAILED',
    });
    throw new ApiError(500, 'Webhook processing failed.', { code: 'WEBHOOK_PROCESSING_FAILED' });
  }
}

module.exports = {
  processWebhook,
  reconcileFromCheckoutSession,
  // exported for unit testing
  _internals: {
    writeInvoiceReceipt,
    backfillInvoices,
    constructEvent,
    claimEvent,
    mapSubscriptionStatus,
    periodsOf,
    isStaleEvent,
    eventCreatedAt,
    subscriptionIdOfInvoice,
    paymentIntentIdOfInvoice,
    metadataIdOf,
    resolveSubscription,
    reconcileLineItems,
    handleCheckoutCompleted,
    handleSubscriptionLifecycle,
    handleInvoice,
    handleChargeRefunded,
    handleDisputeCreated,
    findPaymentForCharge,
  },
};
