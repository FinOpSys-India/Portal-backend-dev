'use strict';

const crypto = require('crypto');

const config = require('../config');
const { prisma } = require('../config/prisma');
const catalog = require('../config/serviceCatalog');
const { getStripe } = require('../config/stripe');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const money = require('../utils/money');
const { logEvent } = require('../utils/auditLog');
const repo = require('../repositories/billingRepository');
const { authorizeCompany } = require('./billingAccess');
const planCatalog = require('./planCatalogService');
const webhooks = require('./stripeWebhookService');
const dto = require('../dto/billingDto');

/**
 * Service selection -> Stripe Checkout.
 *
 * The caller is identified only by the verified access token (userId passed in
 * from req.user); the request body's company_id is authorised against that
 * identity before anything else happens. Every Stripe id and every amount is
 * resolved server-side by planCatalogService — nothing priced here originates in
 * the request.
 *
 * Ordering is deliberate. The subscription row and its items are written BEFORE
 * the redirect, in one transaction, so an abandoned checkout leaves a visible
 * INCOMPLETE record instead of nothing. The Stripe session is created after, and
 * its id is written back; if that write fails the row simply stays unlinked and
 * the next attempt creates a fresh one. Nothing is ever marked ACTIVE here — only
 * a verified webhook does that.
 */

/* ------------------------------ idempotency ------------------------------- */

/** Stable SHA-256 of the canonical request input, to pin a key to one payload. */
function fingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * The idempotency key for this attempt.
 *
 * A client-supplied `Idempotency-Key` header wins. When there is none we derive
 * one from the caller, the company, and the exact selection — which is what turns
 * a double-clicked "Pay" button into one Checkout Session instead of two. A
 * different selection hashes differently and correctly gets its own session, so
 * the derived key never blocks a customer who changed their mind.
 */
function checkoutIdempotencyKey({ headerKey, companyId, requestHash }) {
  return headerKey || `auto:checkout:${companyId}:${requestHash.slice(0, 32)}`;
}

/* -------------------------------- customer -------------------------------- */

/**
 * The company's Stripe Customer, created on first checkout and reused after.
 *
 * Billing is per COMPANY, not per user (one user may own several companies), so
 * the id lives on `companies.stripe_customer_id` — unique, so two companies can
 * never share one customer and merge their invoices.
 *
 * Three things guard against duplicates: the stored id is reused when present, a
 * stored id that Stripe reports as deleted is replaced rather than reused into an
 * error, and the create call carries a per-company Stripe idempotency key so two
 * simultaneous first-checkouts converge on one customer instead of two.
 */
async function ensureStripeCustomer({ company, userId, requestId }) {
  const stripe = getStripe();

  if (company.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(company.stripeCustomerId);
      if (!existing.deleted) return company.stripeCustomerId;
      logger.warn(`Stripe customer ${company.stripeCustomerId} for company ${company.id} was deleted; recreating.`);
    } catch (err) {
      if (err?.statusCode !== 404 && err?.code !== 'resource_missing') throw err;
      logger.warn(`Stripe customer ${company.stripeCustomerId} for company ${company.id} no longer exists; recreating.`);
    }
  }


  const params = {
    email: company.companyEmail,
    name: company.companyName,
    metadata: {
      company_id: String(company.id),
      created_by_user_id: String(userId),
    },
  };

  /*
   * Stripe pins an idempotency key to the exact payload it first saw and rejects
   * a later reuse carrying different parameters. A key of just the company id
   * therefore breaks the moment the company renames or changes its billing email.
   * Folding the payload into the key keeps both properties that matter: two
   * simultaneous first-checkouts with identical details still converge on one
   * customer, and a changed payload gets its own key instead of a 400.
   */
  const customerKey = `customer:create:${company.id}:${fingerprint(params).slice(0, 32)}`;

  const customer = await stripe.customers.create(params, { idempotencyKey: customerKey });

  await repo.setCompanyStripeCustomerId(prisma, company.id, customer.id);
  logEvent({
    event: 'billing.customer.created',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    stripeCustomerId: customer.id,
  });

  return customer.id;
}

/* -------------------------------- metadata -------------------------------- */

/**
 * Checkout metadata. Stripe stores metadata as strings, so every value is
 * serialised explicitly rather than left to implicit coercion (an array would
 * otherwise arrive as "a,b" and a number as "12" by accident rather than by
 * design). Values are capped at Stripe's 500-character limit.
 *
 * Ids and counts only — no names, no emails, no addresses, no amounts a client
 * could later point at. Metadata is visible to everyone with dashboard access
 * and is echoed back in webhooks, so it is treated as semi-public.
 */
function buildMetadata({ userId, companyId, subscriptionId, selections, selectedServices, lines }) {
  const priceOf = (service, component) =>
    lines.find((l) => l.service === service && l.component === component)?.stripePriceId;

  const metadata = {
    user_id: String(userId),
    company_id: String(companyId),
    company_subscription_id: String(subscriptionId),
    internal_checkout_reference: `chk_${companyId}_${subscriptionId}`,
    selected_services: selectedServices.join(','),
  };

  if (selections.bookkeeping) {
    metadata.bookkeeping_price_option_id = selections.bookkeeping.optionId;
    metadata.bookkeeping_price_id = priceOf(catalog.SERVICES.BOOKKEEPING, 'plan') ?? '';
  }

  if (selections.payroll) {
    metadata.payroll_plan_id = selections.payroll.planId;
    metadata.payroll_base_price_id = priceOf(catalog.SERVICES.PAYROLL, 'base') ?? '';
    metadata.payroll_employee_price_id = priceOf(catalog.SERVICES.PAYROLL, 'employees') ?? '';
    metadata.payroll_contractor_price_id = priceOf(catalog.SERVICES.PAYROLL, 'contractors') ?? '';
    metadata.employee_count = String(selections.payroll.employeeCount);
    metadata.contractor_count = String(selections.payroll.contractorCount);
  }

  if (selections.taxes) {
    metadata.tax_price_option_id = selections.taxes.optionId;
    metadata.tax_price_id = priceOf(catalog.SERVICES.TAXES, 'plan') ?? '';
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (value.length > 500) metadata[key] = value.slice(0, 500);
  }
  return metadata;
}

/* ------------------------------- checkout --------------------------------- */

/**
 * POST /billing/checkout — resolve the selection, record the pending
 * subscription, and hand back a Stripe Checkout URL.
 *
 * @returns {Promise<{ statusCode: number, body: object, idempotent: boolean }>}
 */
async function createCheckoutSession({ userId, requestId, companyId, selections, selectedServices, idempotencyKey }) {
  const { company } = await authorizeCompany(userId, companyId);

  /*
   * One live subscription per company is a database invariant (a partial unique
   * index on company_id WHERE status = 'ACTIVE'). Catching it here turns what
   * would be a P2002 raised deep inside the webhook — after the customer has
   * already paid — into a clear refusal before they are redirected.
   */
  const active = await repo.findActiveSubscriptionForCompany(prisma, companyId);
  if (active) {
    logEvent({
      event: 'billing.checkout.rejected',
      status: 'failure',
      requestId,
      userId,
      companyId,
      errorCode: 'SUBSCRIPTION_ALREADY_ACTIVE',
    });
    throw new ApiError(409, 'This company already has an active subscription.', {
      code: 'SUBSCRIPTION_ALREADY_ACTIVE',
      details: { companySubscriptionId: active.id },
    });
  }

  const requestHash = fingerprint({ companyId, selections });
  const key = checkoutIdempotencyKey({ headerKey: idempotencyKey, companyId, requestHash });

  const replayed = await replayIfPossible({ userId, requestId, companyId, key, requestHash });
  if (replayed) return replayed;

  logEvent({
    event: 'billing.checkout.started',
    status: 'started',
    requestId,
    userId,
    companyId,
    selectedServices,
  });

  // Resolve + validate every price BEFORE writing anything. A rejected selection
  // must leave no subscription row and no Stripe object behind.
  const { lines, mode, currency, grandTotalMinor } = await planCatalog.resolveSelection(selections);

  logEvent({
    event: 'billing.plans.resolved',
    status: 'success',
    requestId,
    userId,
    companyId,
    selectedServices,
    planCodes: lines.map((l) => l.planCode),
    stripeProductIds: [...new Set(lines.map((l) => l.stripeProductId))],
    stripePriceIds: lines.map((l) => l.stripePriceId),
    employeeCount: selections.payroll?.employeeCount,
    contractorCount: selections.payroll?.contractorCount,
    amountMinor: grandTotalMinor,
    currency,
  });

  const customerId = await ensureStripeCustomer({ company, userId, requestId });

  // The pending subscription and its items commit together: a half-written
  // subscription would make the webhook's reconciliation ambiguous.
  const subscription = await prisma.$transaction(async (tx) => {
    const created = await repo.createSubscription(tx, { companyId, status: 'INCOMPLETE' });
    for (const line of lines) {
      await repo.createSubscriptionItem(tx, {
        companySubscriptionId: created.id,
        servicePlanId: line.servicePlanId,
        quantity: line.quantity,
        // The price PAID, captured now. Deliberately not read back from the plan
        // catalog later: raising a price must never rewrite what an existing
        // subscriber is recorded as paying.
        unitAmount: money.minorToDecimalString(line.unitAmountMinor, line.currency),
        currency: line.currency,
      });
    }
    return created;
  });

  const metadata = buildMetadata({
    userId,
    companyId,
    subscriptionId: subscription.id,
    selections,
    selectedServices,
    lines,
  });

  const stripe = getStripe();

  const sessionParams = {
    mode,
    customer: customerId,
    line_items: lines.map((line) => ({ price: line.stripePriceId, quantity: line.quantity })),
    success_url: config.billing.checkoutSuccessUrl,
    cancel_url: config.billing.checkoutCancelUrl,
    client_reference_id: metadata.internal_checkout_reference,
    metadata,
    // Copy the metadata onto the object the recurring webhooks carry, so
    // invoice.paid a month from now can still be traced to this company
    // without re-reading the session.
    ...(mode === 'subscription'
      ? { subscription_data: { metadata } }
      : { payment_intent_data: { metadata } }),
  };

  /*
   * Keyed on our own subscription row so a retry of THIS request returns the same
   * session and a new attempt gets a new one. The row id alone is not enough: it
   * restarts at 1 whenever the database is reset, and Stripe would still be
   * holding that key against a previous run's payload. Hashing the payload in
   * keeps the retry guarantee without ever colliding across resets.
   */
  const sessionKey = `checkout:session:${subscription.id}:${fingerprint(sessionParams).slice(0, 32)}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create(sessionParams, { idempotencyKey: sessionKey });
  } catch (err) {
    logger.error(`[${requestId}] Stripe checkout session creation failed: ${err.message}`);
    logEvent({
      event: 'billing.checkout.failed',
      status: 'error',
      requestId,
      userId,
      companyId,
      subscriptionId: subscription.id,
      errorCode: 'CHECKOUT_SESSION_CREATION_FAILED',
    });
    throw new ApiError(502, 'Unable to start checkout. Please try again.', {
      code: 'CHECKOUT_SESSION_CREATION_FAILED',
    });
  }

  await repo.updateSubscription(prisma, subscription.id, { stripeCheckoutSessionId: session.id });

  const body = {
    success: true,
    message: 'Checkout session created successfully.',
    data: dto.toCheckoutResponse({
      session,
      companyId,
      selectedServices,
      pricingSummary: dto.toPricingSummary({ lines, currency, grandTotalMinor }),
    }),
  };

  await rememberCheckout({ userId, companyId, key, requestHash, body });

  logEvent({
    event: 'billing.checkout.created',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription.id,
    stripeCustomerId: customerId,
    stripeCheckoutSessionId: session.id,
    amountMinor: grandTotalMinor,
    currency,
  });

  return { statusCode: 201, body, idempotent: false };
}

/**
 * Return the stored response for a repeated checkout request, or null to proceed.
 *
 * A stored Checkout Session is only worth replaying while Stripe still considers
 * it open — sessions expire after 24 hours, and replaying an expired URL would
 * send the customer to a dead page with no way forward. So the stored session is
 * re-read from Stripe first; if it has expired or already completed, the record
 * is treated as spent and a fresh checkout is created in its place.
 */
async function replayIfPossible({ userId, requestId, companyId, key, requestHash }) {
  const existing = await repo.findIdempotencyKey(prisma, { userId, idempotencyKey: key });
  if (!existing) return null;

  if (existing.requestHash !== requestHash) {
    throw new ApiError(422, 'This Idempotency-Key was already used with a different request.', {
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }

  /*
   * Read both spellings. The response DTO now emits `checkoutSessionId`, but
   * idempotency records written by the previous version are still in the table
   * with `checkout_session_id` — and failing to find the id there would silently
   * turn a legitimate replay into a second Checkout Session for a customer who
   * merely clicked twice.
   */
  const sessionId =
    existing.responseBody?.data?.checkoutSessionId ?? existing.responseBody?.data?.checkout_session_id;
  if (!sessionId) return null;

  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.status !== 'open') {
      logEvent({
        event: 'billing.checkout.replay_expired',
        status: 'skipped',
        requestId,
        userId,
        companyId,
        stripeCheckoutSessionId: sessionId,
        detail: session.status,
      });
      return null;
    }
  } catch (err) {
    logger.warn(`[${requestId}] Could not re-read checkout session ${sessionId}: ${err.message}`);
    return null;
  }

  logEvent({
    event: 'billing.checkout.replayed',
    status: 'success',
    requestId,
    userId,
    companyId,
    stripeCheckoutSessionId: sessionId,
    idempotent: true,
  });
  return { statusCode: existing.responseStatus, body: existing.responseBody, idempotent: true };
}

/**
 * Persist the checkout response against its idempotency key, replacing any spent
 * record for the same key. Best-effort: the customer already has a working
 * checkout URL by this point, so a failure to write the replay record must not
 * turn a successful checkout into an error. It only costs the duplicate-click
 * protection on the next click, which is logged.
 */
async function rememberCheckout({ userId, companyId, key, requestHash, body }) {
  try {
    const existing = await repo.findIdempotencyKey(prisma, { userId, idempotencyKey: key });
    if (existing) {
      await repo.updateIdempotencyKey(prisma, existing.id, {
        requestHash,
        responseStatus: 201,
        responseBody: body,
        companyId,
      });
      return;
    }
    await repo.createIdempotencyKey(prisma, {
      idempotencyKey: key,
      userId,
      method: 'POST',
      path: '/billing/checkout',
      requestHash,
      responseStatus: 201,
      responseBody: body,
      companyId,
    });
  } catch (err) {
    logger.warn(`Could not record checkout idempotency key ${key}: ${err.message}`);
  }
}

/* ----------------------------- checkout status ---------------------------- */

/**
 * Is this row missing anything only a webhook writes?
 *
 * Three separate symptoms of a lost delivery, and each has to be checked: the
 * status never left INCOMPLETE, the Stripe subscription was never linked, or the
 * line items never got their Stripe item ids — the last of which can happen on
 * its own when checkout.session.completed arrives after the events that stamp the
 * high-water mark, and which quietly breaks every later head-count change.
 */
function needsReconcile(subscription) {
  return (
    subscription.status === 'INCOMPLETE' ||
    !subscription.stripeSubscriptionId ||
    subscription.items.some((item) => item.quantity > 0 && !item.stripeSubscriptionItemId)
  );
}

/**
 * GET /billing/checkout-status — the authoritative answer to "did it work?".
 *
 * Ownership is proved twice over: the session must belong to a subscription row
 * this backend created, and the caller must be authorised on that row's company.
 * Neither the session id nor anything inside it is taken as proof of identity —
 * a session id is a bearer-ish string that appears in a redirect URL, so on its
 * own it must never grant access to another company's billing state.
 */
async function getCheckoutStatus({ userId, requestId, sessionId }) {
  const subscription = await repo.findSubscriptionByCheckoutSessionId(prisma, sessionId);
  if (!subscription) {
    throw new ApiError(404, 'Checkout session not found.', { code: 'CHECKOUT_SESSION_NOT_FOUND' });
  }

  try {
    await authorizeCompany(userId, subscription.companyId);
  } catch (err) {
    // Distinguish "not yours" from "does not exist" for the log, but return the
    // same shape either way so the endpoint cannot be used to enumerate sessions.
    logEvent({
      event: 'billing.checkout_status.denied',
      status: 'failure',
      requestId,
      userId,
      companyId: subscription.companyId,
      stripeCheckoutSessionId: sessionId,
      errorCode: 'CHECKOUT_SESSION_ACCESS_DENIED',
    });
    if (err instanceof ApiError && err.statusCode === 403) {
      throw new ApiError(403, 'You do not have access to this checkout session.', {
        code: 'CHECKOUT_SESSION_ACCESS_DENIED',
      });
    }
    throw err;
  }

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'resource_missing') {
      throw new ApiError(404, 'Checkout session not found.', { code: 'CHECKOUT_SESSION_NOT_FOUND' });
    }
    throw err;
  }

  /*
   * Self-heal a webhook that never landed.
   *
   * Stripe says this session is paid, so the money is real; if our row still does
   * not reflect it, the delivery was lost — the listener was down, the tunnel
   * died, the endpoint failed past Stripe's retry window. Stripe will not
   * redeliver forever, so without repairing it here a paid subscription stays
   * INCOMPLETE indefinitely and the customer is charged for nothing.
   *
   * This is the natural moment for it: the success page lands here, the caller is
   * already authorised on the company, and the session has just been read from
   * Stripe. Nothing is believed from the request — reconciliation re-fetches
   * everything from Stripe itself.
   *
   * Best-effort by design. A reconciliation failure must not turn "did my payment
   * work?" into a 500; the answer below is read from Stripe either way, and the
   * next status poll (or a redelivered webhook) will try again.
   */
  let current = subscription;
  if (session.mode === 'subscription' && session.payment_status === 'paid' && needsReconcile(subscription)) {
    try {
      const outcome = await webhooks.reconcileFromCheckoutSession({ sessionId, requestId });
      if (outcome.reconciled) {
        current = (await repo.findSubscriptionByCheckoutSessionId(prisma, sessionId)) ?? subscription;
      }
    } catch (err) {
      logger.warn(`[${requestId}] Reconcile from checkout status failed for ${sessionId}: ${err.message}`);
    }
  }

  const data = dto.toCheckoutStatusResponse({ session, subscription: current, companyId: current.companyId });

  logEvent({
    event: 'billing.checkout_status.read',
    status: 'success',
    requestId,
    userId,
    companyId: current.companyId,
    subscriptionId: current.id,
    stripeCheckoutSessionId: sessionId,
    detail: data.status,
  });

  const MESSAGES = {
    paid: 'Payment completed successfully.',
    processing: 'Payment is still being processed.',
    pending: 'Checkout has not been completed yet.',
    cancelled: 'Checkout was cancelled or has expired.',
    failed: 'Payment failed.',
  };

  return { message: MESSAGES[data.status] ?? 'Checkout status retrieved.', data };
}

/* ------------------------------- plan catalog ----------------------------- */

/** GET /billing/plans — the sellable options, by our own ids. */
async function listPlans() {
  return planCatalog.listCatalog();
}

module.exports = {
  createCheckoutSession,
  getCheckoutStatus,
  listPlans,
  // exported for unit testing
  _internals: { fingerprint, checkoutIdempotencyKey, buildMetadata, authorizeCompany, ensureStripeCustomer },
};
