'use strict';

/**
 * Data-access layer for the billing / checkout flow. Same contract as
 * companyRepository: every function takes a Prisma client first, so the caller
 * chooses between the shared `prisma` (standalone read) and a transaction client
 * (`tx`). No business rules live here.
 */

/* ---------------------------- plan catalog -------------------------------- */

/** Active plans for a set of plan codes. Inactive rows are simply not returned,
 *  so a deactivated plan can never be resolved into a checkout. */
function findActivePlansByCodes(client, planCodes) {
  return client.servicePlan.findMany({
    where: { planCode: { in: planCodes }, isActive: true },
  });
}

/** Every active plan in the catalog, ordered for display. */
function listActivePlans(client, planCodes) {
  return client.servicePlan.findMany({
    where: { planCode: { in: planCodes }, isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
  });
}

/** Plans matching a set of Stripe price ids — the webhook's reverse lookup. */
function findPlansByStripePriceIds(client, priceIds) {
  return client.servicePlan.findMany({ where: { stripePriceId: { in: priceIds } } });
}

/* ---------------------------- subscriptions ------------------------------- */

function createSubscription(client, data) {
  return client.companySubscription.create({ data });
}

function updateSubscription(client, id, data) {
  return client.companySubscription.update({ where: { id }, data });
}

function findSubscriptionById(client, id) {
  return client.companySubscription.findUnique({ where: { id }, include: { items: true } });
}

function findSubscriptionByCheckoutSessionId(client, stripeCheckoutSessionId) {
  return client.companySubscription.findUnique({
    where: { stripeCheckoutSessionId },
    include: { items: { include: { servicePlan: true } } },
  });
}

function findSubscriptionByStripeId(client, stripeSubscriptionId) {
  return client.companySubscription.findUnique({
    where: { stripeSubscriptionId },
    include: { items: { include: { servicePlan: true } } },
  });
}

/** The company's live subscription, if any. At most one exists — a partial
 *  unique index on (company_id) WHERE status = 'ACTIVE' enforces it. */
function findActiveSubscriptionForCompany(client, companyId) {
  return client.companySubscription.findFirst({
    where: { companyId, status: 'ACTIVE' },
    include: { items: { include: { servicePlan: true } } },
  });
}

/**
 * The subscription a "what am I paying for?" question means.
 *
 * Prefers a billable one (ACTIVE / PAST_DUE / UNPAID — the company owes or is
 * being charged) over a dead one, and the newest within that. Falls back to the
 * most recent row of any status, so a company whose only attempt was abandoned
 * still gets a truthful INCOMPLETE answer rather than a bare 404.
 */
async function findCurrentSubscriptionForCompany(client, companyId) {
  const billable = await client.companySubscription.findFirst({
    where: { companyId, status: { in: ['ACTIVE', 'PAST_DUE', 'UNPAID'] } },
    include: { items: { include: { servicePlan: true } } },
    orderBy: { createdAt: 'desc' },
  });
  if (billable) return billable;

  return client.companySubscription.findFirst({
    where: { companyId },
    include: { items: { include: { servicePlan: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Subscriptions that look like a webhook never landed.
 *
 * The three symptoms are the ones needsReconcile() checks in checkoutService,
 * kept in the same order: status stuck at INCOMPLETE, no Stripe subscription
 * linked, or a billed line with no Stripe item id (which happens on its own when
 * checkout.session.completed arrives after the events that stamp the high-water
 * mark, and quietly breaks every later head-count change).
 *
 * A row with no checkout session id is excluded outright — there is nothing to
 * reconcile FROM. `createdAt` bounds the scan to sessions that could still be
 * live; anything older is an abandoned checkout, not a lost delivery.
 */
function listSubscriptionsNeedingReconcile(client, { since, take }) {
  return client.companySubscription.findMany({
    where: {
      stripeCheckoutSessionId: { not: null },
      createdAt: { gte: since },
      OR: [
        { status: 'INCOMPLETE' },
        { stripeSubscriptionId: null },
        { items: { some: { quantity: { gt: 0 }, stripeSubscriptionItemId: null } } },
      ],
    },
    include: { items: { include: { servicePlan: true } } },
    orderBy: { createdAt: 'asc' },
    take,
  });
}

/* ------------------------- subscription items ----------------------------- */

function createSubscriptionItem(client, data) {
  return client.companySubscriptionItem.create({ data });
}

function updateSubscriptionItem(client, id, data) {
  return client.companySubscriptionItem.update({ where: { id }, data });
}

/* -------------------------------- payments -------------------------------- */

function findPaymentByInvoiceId(client, stripeInvoiceId) {
  return client.companyPayment.findUnique({ where: { stripeInvoiceId } });
}

function createPayment(client, data) {
  return client.companyPayment.create({ data });
}

function updatePayment(client, id, data) {
  return client.companyPayment.update({ where: { id }, data });
}

/** Find a receipt by Stripe Charge — the refund and dispute events' only handle. */
function findPaymentByChargeId(client, stripeChargeId) {
  return client.companyPayment.findFirst({ where: { stripeChargeId } });
}

function findPaymentByPaymentIntentId(client, stripePaymentIntentId) {
  return client.companyPayment.findFirst({ where: { stripePaymentIntentId } });
}

/**
 * A page of a company's payment history.
 *
 * The sort was previously hardcoded to paidAt/createdAt descending with no way
 * to change it, so a sortable table header was impossible to build. `sort` is an
 * allowlisted column name (see billingValidator), never a raw query value.
 */
function listPaymentsForCompany(client, companyId, { limit, offset, sort = 'paidAt', order = 'desc', status = null }) {
  return client.companyPayment.findMany({
    where: { companyId, ...(status ? { status } : {}) },
    // A secondary key on createdAt keeps the order total: paidAt is nullable, so
    // failed rows would otherwise come back in an arbitrary order between pages.
    orderBy: [{ [sort]: order }, { createdAt: 'desc' }],
    take: limit,
    skip: offset,
  });
}

function countPaymentsForCompany(client, companyId, { status = null } = {}) {
  return client.companyPayment.count({ where: { companyId, ...(status ? { status } : {}) } });
}

/* ------------------------------ stripe events ----------------------------- */

function findStripeEvent(client, stripeEventId) {
  return client.stripeEvent.findUnique({ where: { stripeEventId } });
}

function createStripeEvent(client, data) {
  return client.stripeEvent.create({ data });
}

function markStripeEventProcessed(client, id, processedAt) {
  return client.stripeEvent.update({ where: { id }, data: { processedAt } });
}

/* -------------------------------- companies ------------------------------- */

function setCompanyStripeCustomerId(client, companyId, stripeCustomerId) {
  return client.company.update({ where: { id: companyId }, data: { stripeCustomerId } });
}

/* ------------------------------ idempotency ------------------------------- */

function findIdempotencyKey(client, { userId, idempotencyKey }) {
  return client.idempotencyKey.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
}

function createIdempotencyKey(client, data) {
  return client.idempotencyKey.create({ data });
}

function updateIdempotencyKey(client, id, data) {
  return client.idempotencyKey.update({ where: { id }, data });
}

module.exports = {
  findActivePlansByCodes,
  listActivePlans,
  findPlansByStripePriceIds,
  createSubscription,
  updateSubscription,
  findSubscriptionById,
  findSubscriptionByCheckoutSessionId,
  findSubscriptionByStripeId,
  findActiveSubscriptionForCompany,
  findCurrentSubscriptionForCompany,
  listSubscriptionsNeedingReconcile,
  createSubscriptionItem,
  updateSubscriptionItem,
  findPaymentByInvoiceId,
  findPaymentByChargeId,
  findPaymentByPaymentIntentId,
  createPayment,
  updatePayment,
  listPaymentsForCompany,
  countPaymentsForCompany,
  findStripeEvent,
  createStripeEvent,
  markStripeEventProcessed,
  setCompanyStripeCustomerId,
  findIdempotencyKey,
  createIdempotencyKey,
  updateIdempotencyKey,
};
