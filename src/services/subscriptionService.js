'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const catalog = require('../config/serviceCatalog');
const { getStripe } = require('../config/stripe');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const repo = require('../repositories/billingRepository');
const { authorizeCompany } = require('./billingAccess');
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
  if (!subscription) throw subscriptionNotFound();

  logEvent({
    event: 'billing.subscription.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    subscriptionId: subscription.id,
    detail: subscription.status,
  });

  return dto.toSubscriptionResponse({ subscription });
}

/** GET /billing/payments — the company's receipts, newest first. */
async function listPayments({ userId, requestId, companyId, limit, offset }) {
  await authorizeCompany(userId, companyId);

  const [payments, total] = await Promise.all([
    repo.listPaymentsForCompany(prisma, companyId, { limit, offset }),
    repo.countPaymentsForCompany(prisma, companyId),
  ]);

  logEvent({
    event: 'billing.payments.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    detail: `${payments.length}/${total}`,
  });

  return dto.toPaymentsResponse({ payments, total, limit, offset, companyId });
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
  return {
    changed: applied.length > 0,
    changes: applied,
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

  return { portal_url: session.url, company_id: companyId };
}

module.exports = {
  getSubscription,
  listPayments,
  updatePayrollCounts,
  cancelSubscription,
  createPortalSession,
  // exported for unit testing
  _internals: { loadMutableSubscription },
};
