'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const catalog = require('../config/serviceCatalog');
const { getStripe } = require('../config/stripe');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const money = require('../utils/money');
const repo = require('../repositories/billingRepository');
const { authorizeCompany } = require('./billingAccess');
const planCatalog = require('./planCatalogService');
const adminEvents = require('./adminEventService');
const dto = require('../dto/billingDto');

/**
 * Managing a subscription after it exists: reading it, changing the payroll head
 * counts, cancelling it, reading payment history, and handing the customer to
 * Stripe's hosted portal.
 *
 * The same rules as checkout apply throughout. The caller is the verified token
 * subject; the company_id in the request is authorised against it. No price, no
 * amount, and no Stripe id is ever accepted from the client — the only numbers
 * it contributes are the two integer head counts, and those are bounded and
 * multiplied by prices read from the approved catalog.
 *
 * Stripe is the source of truth for everything money-related. Every mutation here
 * is applied to Stripe FIRST and only then mirrored locally, so a failed API call
 * leaves the two in agreement rather than leaving our row claiming something
 * Stripe never did. The webhooks reconcile afterwards regardless.
 */

/* --------------------------------- errors -------------------------------- */

function subscriptionNotFound() {
  return new ApiError(404, 'This company has no subscription.', { code: 'SUBSCRIPTION_NOT_FOUND' });
}

function subscriptionNotActive(status) {
  return new ApiError(409, 'This company has no active subscription.', {
    code: 'SUBSCRIPTION_NOT_ACTIVE',
    details: { status },
  });
}

/**
 * A local subscription row exists but was never linked to a Stripe subscription
 * — an abandoned checkout, or one whose webhook has not landed yet. There is
 * nothing to change in Stripe, and inventing one would double-bill.
 */
function subscriptionNotLinked() {
  return new ApiError(409, 'This subscription is not ready to be modified yet.', {
    code: 'SUBSCRIPTION_NOT_ACTIVE',
    details: { reason: 'not_linked_to_stripe' },
  });
}

/* ------------------------------ read the state ---------------------------- */

/**
 * GET /billing/subscription — what is this company paying for right now?
 *
 * Answered from our own rows, not from Stripe. They are the record of what was
 * sold and at what price, they are kept current by the webhooks, and reading
 * them costs no API call on a page the customer may refresh often.
 */
async function getSubscription({ userId, requestId, companyId }) {
  await authorizeCompany(userId, companyId);

  const subscription = await repo.findCurrentSubscriptionForCompany(prisma, companyId);

  /*
   * A company with no subscription is a NORMAL state, not an error: every company
   * is in it between onboarding and its first checkout. This used to 404, while
   * the adjacent payments endpoint answered 200 with an empty list for the same
   * situation — so the billing screen needed two different empty-state paths for
   * one condition, and a 404 in the network tab looked like a bug rather than
   * "nothing bought yet".
   */
  logEvent({
    event: 'billing.subscription.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription?.id,
    detail: subscription?.status ?? 'none',
  });

  return {
    companyId,
    hasSubscription: Boolean(subscription),
    subscription: subscription ? dto.toSubscriptionResponse({ subscription }) : null,
  };
}

/** GET /billing/payments — the company's receipts. */
async function listPayments({ userId, requestId, companyId, limit, offset, sort, order, status }) {
  await authorizeCompany(userId, companyId);

  const [payments, total] = await Promise.all([
    repo.listPaymentsForCompany(prisma, companyId, { limit, offset, sort, order, status }),
    repo.countPaymentsForCompany(prisma, companyId, { status }),
  ]);

  logEvent({
    event: 'billing.payments.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    detail: `${payments.length}/${total}`,
  });

  return dto.toPaymentsResponse({ payments, total, limit, offset, companyId, sort, order });
}

/* ---------------------------- shared preconditions ------------------------ */

/**
 * Load the subscription a mutation will act on, refusing anything that is not a
 * live, Stripe-linked subscription. Returns the row plus its Stripe id.
 */
async function loadMutableSubscription(companyId) {
  const subscription = await repo.findCurrentSubscriptionForCompany(prisma, companyId);
  if (!subscription) throw subscriptionNotFound();

  if (!['ACTIVE', 'PAST_DUE', 'UNPAID'].includes(subscription.status)) {
    throw subscriptionNotActive(subscription.status);
  }
  if (!subscription.stripeSubscriptionId) throw subscriptionNotLinked();

  return subscription;
}

/* ------------------------------ payroll counts ---------------------------- */

/**
 * PATCH /billing/subscription/payroll — change the billed head counts.
 *
 * Three transitions per component, and each is a different Stripe call:
 *
 *   n -> m (both > 0)  update the subscription item's quantity
 *   n -> 0             DELETE the item, so the customer stops being billed for a
 *                      line they no longer use (Stripe rejects quantity 0 on a
 *                      subscription item, so zeroing it is not an option)
 *   0 -> m             CREATE the item, because the original checkout omitted it
 *
 * That third case is why the local row is kept at quantity 0 rather than deleted
 * when a count drops to zero: the history and the plan link survive, and the
 * unique on (subscription, plan) still holds when the line comes back.
 *
 * The unit prices are NOT re-read from the request or the live catalog — they
 * come from the subscription's own items, so a mid-term head-count change never
 * silently reprices what the customer already agreed to.
 */
async function updatePayrollCounts({ userId, requestId, companyId, employeeCount, contractorCount }) {
  await authorizeCompany(userId, companyId);
  const subscription = await loadMutableSubscription(companyId);

  const payrollPlan = catalog.PAYROLL_PLANS.payroll_standard;
  const wanted = [
    { component: 'employees', planCode: payrollPlan.employees.planCode, quantity: employeeCount },
    { component: 'contractors', planCode: payrollPlan.contractors.planCode, quantity: contractorCount },
  ].filter((w) => w.quantity !== null);

  // Payroll must already be on the subscription. Adding a whole service is a new
  // purchase decision (new prices, possibly a new base line), not a quantity
  // edit, so it goes through checkout rather than through here.
  const hasPayrollBase = subscription.items.some(
    (item) => item.servicePlan?.planCode === payrollPlan.base.planCode
  );
  if (!hasPayrollBase) {
    throw new ApiError(409, 'This company is not subscribed to payroll.', {
      code: 'PAYROLL_NOT_SUBSCRIBED',
    });
  }

  const stripe = getStripe();
  const applied = [];

  for (const want of wanted) {
    const item = subscription.items.find((i) => i.servicePlan?.planCode === want.planCode);
    if (!item) {
      // The plan exists in the catalog but this subscription has no row for it —
      // only possible if the checkout that created it predates the plan.
      logger.error(`Subscription ${subscription.id} has no item for plan ${want.planCode}.`);
      throw new ApiError(409, 'This subscription cannot be updated automatically.', {
        code: 'SUBSCRIPTION_UPDATE_FAILED',
        details: { planCode: want.planCode },
      });
    }

    if (item.quantity === want.quantity) continue;

    try {
      if (want.quantity === 0) {
        if (item.stripeSubscriptionItemId) {
          await stripe.subscriptionItems.del(item.stripeSubscriptionItemId, {
            proration_behavior: config.billing.prorationBehavior,
          });
        }
        // The Stripe item id is gone and must not be reused; clearing it also
        // frees the unique index for the id a future re-add will get.
        await repo.updateSubscriptionItem(prisma, item.id, {
          quantity: 0,
          stripeSubscriptionItemId: null,
        });
      } else if (item.stripeSubscriptionItemId) {
        await stripe.subscriptionItems.update(item.stripeSubscriptionItemId, {
          quantity: want.quantity,
          proration_behavior: config.billing.prorationBehavior,
        });
        await repo.updateSubscriptionItem(prisma, item.id, { quantity: want.quantity });
      } else {
        const created = await stripe.subscriptionItems.create({
          subscription: subscription.stripeSubscriptionId,
          // Resolved from OUR catalog row, never from the request.
          price: item.servicePlan.stripePriceId,
          quantity: want.quantity,
          proration_behavior: config.billing.prorationBehavior,
        });
        await repo.updateSubscriptionItem(prisma, item.id, {
          quantity: want.quantity,
          stripeSubscriptionItemId: created.id,
        });
      }
    } catch (err) {
      logger.error(`[${requestId}] Stripe subscription item update failed: ${err.message}`);
      logEvent({
        event: 'billing.subscription.update_failed',
        status: 'error',
        requestId,
        userId,
        companyId,
        subscriptionId: subscription.id,
        planCodes: [want.planCode],
        errorCode: 'SUBSCRIPTION_UPDATE_FAILED',
      });
      /*
       * Partial application is possible here: employees may have gone through
       * before contractors failed. Stripe is authoritative and the webhook will
       * reconcile, and every step above writes locally only AFTER its Stripe call
       * succeeded — so what is stored is always a prefix of what Stripe did,
       * never a claim about something that did not happen.
       */
      throw new ApiError(502, 'Unable to update the subscription. Please try again.', {
        code: 'SUBSCRIPTION_UPDATE_FAILED',
        details: { applied: applied.map((a) => a.component) },
      });
    }

    applied.push({ component: want.component, from: item.quantity, to: want.quantity });
  }

  logEvent({
    event: 'billing.subscription.payroll_updated',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription.id,
    employeeCount: employeeCount ?? undefined,
    contractorCount: contractorCount ?? undefined,
    detail: applied.length ? applied.map((a) => `${a.component}:${a.from}->${a.to}`).join(',') : 'no_change',
  });

  const refreshed = await repo.findCurrentSubscriptionForCompany(prisma, companyId);

  // Payroll head counts are a column on the admin table. Broadcast only when
  // something actually moved — a no-op PATCH is not a change to announce.
  if (applied.length) {
    adminEvents.companyServicesChanged({
      companyId,
      subscriptionId: subscription.id,
      status: refreshed?.status ?? subscription.status,
    });
  }

  return {
    changed: applied.length > 0,
    changes: applied,
    subscription: dto.toSubscriptionResponse({ subscription: refreshed }),
  };
}

/* ------------------------------ add services ------------------------------ */

/**
 * POST /billing/subscription/services — add a service to a LIVE subscription.
 *
 * This closes a genuine dead end. A customer who bought bookkeeping and later
 * wanted tax had no route at all: POST /billing/checkout refused with
 * SUBSCRIPTION_ALREADY_ACTIVE, and PATCH /subscription/payroll only moves head
 * counts on a service already purchased. The only workaround was to cancel and
 * re-buy everything, which loses the billing period the customer had paid for.
 *
 * Everything is added to the EXISTING Stripe subscription rather than sold as a
 * second one, which is what keeps a single renewal date and a single invoice.
 * Proration follows BILLING_PRORATION_BEHAVIOR, so the customer pays for the
 * remainder of the current period and nothing more.
 *
 * Prices are resolved through exactly the same server-side path as checkout
 * (planCatalogService.resolveSelection): an option id in, a verified Stripe
 * Price out. No amount and no Stripe id is accepted from the request, here or
 * anywhere else.
 */
async function addServices({ userId, requestId, companyId, selections, selectedServices }) {
  await authorizeCompany(userId, companyId);
  const subscription = await loadMutableSubscription(companyId);

  // Resolve and validate BEFORE touching Stripe, so a rejected selection leaves
  // the live subscription exactly as it was.
  const { lines, currency } = await planCatalog.resolveSelection(selections);

  // Refuse anything the company already pays for. Adding a second line for a
  // plan already on the subscription would charge twice for one service, and the
  // unique on (subscription, plan) would reject it halfway through anyway —
  // after the Stripe call had already succeeded.
  const existingPlanIds = new Set(subscription.items.filter((i) => i.quantity > 0).map((i) => i.servicePlanId));
  const duplicates = lines.filter((l) => existingPlanIds.has(l.servicePlanId));
  if (duplicates.length) {
    throw new ApiError(409, 'This company is already subscribed to one or more of the selected services.', {
      code: 'SERVICE_ALREADY_SUBSCRIBED',
      details: {
        services: [...new Set(duplicates.map((l) => l.service))],
        optionIds: [...new Set(duplicates.map((l) => l.optionId))],
      },
    });
  }

  // Every plan in the catalog renews monthly, but a mixed-interval addition would
  // silently change what "next renewal" means for the whole subscription.
  const intervals = [...new Set(lines.filter((l) => l.recurring).map((l) => l.interval))];
  if (intervals.length > 1) {
    throw new ApiError(422, 'The selected services renew on different schedules.', {
      code: 'INCOMPATIBLE_CHECKOUT_PRICES',
      details: { reason: 'mixed_intervals', intervals },
    });
  }

  const stripe = getStripe();
  const added = [];

  for (const line of lines) {
    try {
      const created = await stripe.subscriptionItems.create({
        subscription: subscription.stripeSubscriptionId,
        // From OUR verified catalog row, never from the request.
        price: line.stripePriceId,
        quantity: line.quantity,
        proration_behavior: config.billing.prorationBehavior,
      });

      /*
       * A row may already exist at quantity 0 — that is how a component whose
       * count dropped to zero is kept, so its history and plan link survive. Reuse
       * it rather than inserting a duplicate, which the unique on (subscription,
       * plan) would reject.
       */
      const existingItem = subscription.items.find((i) => i.servicePlanId === line.servicePlanId);
      if (existingItem) {
        await repo.updateSubscriptionItem(prisma, existingItem.id, {
          quantity: line.quantity,
          stripeSubscriptionItemId: created.id,
          unitAmount: money.minorToDecimalString(line.unitAmountMinor, line.currency),
          currency: line.currency,
        });
      } else {
        await repo.createSubscriptionItem(prisma, {
          companySubscriptionId: subscription.id,
          servicePlanId: line.servicePlanId,
          quantity: line.quantity,
          stripeSubscriptionItemId: created.id,
          // The price PAID, captured now — the same rule as checkout, so a later
          // price rise never rewrites what this customer is recorded as paying.
          unitAmount: money.minorToDecimalString(line.unitAmountMinor, line.currency),
          currency: line.currency,
        });
      }

      added.push({ service: line.service, component: line.component, optionId: line.optionId, quantity: line.quantity });
    } catch (err) {
      logger.error(`[${requestId}] Stripe subscription item create failed: ${err.message}`);
      logEvent({
        event: 'billing.subscription.add_services_failed',
        status: 'error',
        requestId,
        userId,
        companyId,
        subscriptionId: subscription.id,
        planCodes: [line.planCode],
        errorCode: 'SUBSCRIPTION_UPDATE_FAILED',
      });
      /*
       * Partial application is possible: an earlier line may already be on the
       * subscription. Every write above happens only AFTER its Stripe call
       * succeeded, so what is stored is always a prefix of what Stripe did —
       * never a claim about something that did not happen. `applied` tells the
       * client what to expect when it refetches.
       */
      throw new ApiError(502, 'Unable to add the selected services. Please try again.', {
        code: 'SUBSCRIPTION_UPDATE_FAILED',
        details: { applied: added.map((a) => a.service) },
      });
    }
  }

  logEvent({
    event: 'billing.subscription.services_added',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription.id,
    selectedServices,
    planCodes: lines.map((l) => l.planCode),
    amountMinor: lines.reduce((sum, l) => sum + l.totalAmountMinor, 0),
    currency,
  });

  const refreshed = await repo.findCurrentSubscriptionForCompany(prisma, companyId);

  // A service was added: the company's Active Services cell is now wrong on
  // every open admin screen.
  adminEvents.companyServicesChanged({
    companyId,
    subscriptionId: subscription.id,
    status: refreshed?.status ?? subscription.status,
  });

  return {
    added,
    pricingSummary: dto.toPricingSummary({
      lines,
      currency,
      grandTotalMinor: lines.reduce((sum, l) => sum + l.totalAmountMinor, 0),
    }),
    subscription: dto.toSubscriptionResponse({ subscription: refreshed }),
  };
}

/* -------------------------------- cancellation ---------------------------- */

/**
 * DELETE /billing/subscription — cancel.
 *
 * Two modes, and the default matters. `at_period_end: true` (the default) leaves
 * the subscription running until the period the customer has already paid for
 * expires; immediate cancellation forfeits that remainder, so it must be asked
 * for explicitly.
 *
 * Our row is updated from what Stripe returns, not from what was requested. The
 * `customer.subscription.updated` / `.deleted` webhook then confirms it — this
 * write only means the UI does not have to wait for that round trip.
 */
async function cancelSubscription({ userId, requestId, companyId, atPeriodEnd }) {
  await authorizeCompany(userId, companyId);
  const subscription = await loadMutableSubscription(companyId);

  if (atPeriodEnd && subscription.cancelAtPeriodEnd) {
    // Already scheduled. Idempotent rather than an error: a repeated click on
    // "cancel" should not read as a failure.
    return {
      alreadyScheduled: true,
      subscription: dto.toSubscriptionResponse({ subscription }),
    };
  }

  const stripe = getStripe();
  let updated;
  try {
    updated = atPeriodEnd
      ? await stripe.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: true })
      : await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
  } catch (err) {
    logger.error(`[${requestId}] Stripe cancellation failed: ${err.message}`);
    logEvent({
      event: 'billing.subscription.cancel_failed',
      status: 'error',
      requestId,
      userId,
      companyId,
      subscriptionId: subscription.id,
      errorCode: 'SUBSCRIPTION_CANCEL_FAILED',
    });
    throw new ApiError(502, 'Unable to cancel the subscription. Please try again.', {
      code: 'SUBSCRIPTION_CANCEL_FAILED',
    });
  }

  const canceledNow = updated.status === 'canceled';
  await repo.updateSubscription(prisma, subscription.id, {
    ...(canceledNow ? { status: 'CANCELED' } : {}),
    cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
    canceledAt: updated.canceled_at ? new Date(updated.canceled_at * 1000) : null,
  });

  logEvent({
    event: 'billing.subscription.canceled',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription.id,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    detail: atPeriodEnd ? 'at_period_end' : 'immediate',
  });

  const refreshed = await repo.findCurrentSubscriptionForCompany(prisma, companyId);

  adminEvents.companyServicesChanged({
    companyId,
    subscriptionId: subscription.id,
    status: refreshed?.status ?? subscription.status,
  });

  return {
    alreadyScheduled: false,
    immediate: !atPeriodEnd,
    subscription: dto.toSubscriptionResponse({ subscription: refreshed }),
  };
}

/* ------------------------------ billing portal ---------------------------- */

/**
 * POST /billing/portal — a one-time link into Stripe's hosted billing portal.
 *
 * This is how a customer updates a card, downloads invoices, or cancels without
 * this backend ever touching a card number. The URL is short-lived and scoped to
 * one customer, so it is minted per request and never stored.
 *
 * What the portal is allowed to expose (cancellation, plan switching, invoice
 * history) is configured in the Stripe dashboard, not here — deliberately, so a
 * code change cannot quietly widen what a customer can do to their own billing.
 */
async function createPortalSession({ userId, requestId, companyId }) {
  const { company } = await authorizeCompany(userId, companyId);

  if (!company.stripeCustomerId) {
    throw new ApiError(409, 'This company has no billing account yet.', {
      code: 'SUBSCRIPTION_NOT_FOUND',
      details: { reason: 'no_stripe_customer' },
    });
  }

  let session;
  try {
    session = await getStripe().billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: config.billing.portalReturnUrl,
    });
  } catch (err) {
    logger.error(`[${requestId}] Stripe billing portal session failed: ${err.message}`);
    logEvent({
      event: 'billing.portal.failed',
      status: 'error',
      requestId,
      userId,
      companyId,
      errorCode: 'PORTAL_SESSION_FAILED',
    });
    throw new ApiError(502, 'Unable to open the billing portal. Please try again.', {
      code: 'PORTAL_SESSION_FAILED',
    });
  }

  logEvent({
    event: 'billing.portal.created',
    status: 'success',
    requestId,
    userId,
    companyId,
    stripeCustomerId: company.stripeCustomerId,
  });

  return { portalUrl: session.url, companyId };
}

module.exports = {
  getSubscription,
  listPayments,
  addServices,
  updatePayrollCounts,
  cancelSubscription,
  createPortalSession,
  // exported for unit testing
  _internals: { loadMutableSubscription },
};
