'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validateCheckoutRequest,
  validateSessionId,
  validateCompanyIdQuery,
  validatePagination,
  validateCancelRequest,
  validatePayrollUpdate,
  validatePortalRequest,
} = require('../validators/billingValidator');
const checkoutService = require('../services/checkoutService');
const subscriptionService = require('../services/subscriptionService');
const stripeWebhookService = require('../services/stripeWebhookService');

/**
 * HTTP layer for the billing flows. Thin by design, exactly as companyController
 * is: read the caller identity from req.user (set by requireAuth — NEVER from the
 * body), validate input, delegate, shape the response. Error translation is the
 * central error handler's job.
 */

/**
 * GET /billing/plans
 *
 * The sellable catalog by our own option ids, so the frontend can render the four
 * bookkeeping tiers, the three tax tiers, and the payroll components without ever
 * being told a Stripe price id.
 */
const listPlans = asyncHandler(async (req, res) => {
  const data = await checkoutService.listPlans();
  return res.status(200).json({ success: true, data });
});

/**
 * POST /billing/checkout
 *
 * Create one Stripe Checkout Session covering every selected service. Supports an
 * optional `Idempotency-Key` header; without one, a key derived from the caller,
 * the company, and the exact selection still protects against a double-clicked
 * button.
 */
const createCheckout = asyncHandler(async (req, res) => {
  const { companyId, selections, selectedServices } = validateCheckoutRequest(req.body);
  const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);

  const { statusCode, body, idempotent } = await checkoutService.createCheckoutSession({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    selections,
    selectedServices,
    idempotencyKey,
  });

  if (idempotent) res.setHeader('Idempotent-Replay', 'true');
  return res.status(statusCode).json(body);
});

/**
 * GET /billing/checkout-status?session_id=cs_123
 *
 * The frontend polls this after the redirect. It answers from Stripe plus our own
 * records — never from anything the success page supplied.
 */
const getCheckoutStatus = asyncHandler(async (req, res) => {
  const sessionId = validateSessionId(req.query.session_id);

  const { message, data } = await checkoutService.getCheckoutStatus({
    userId: req.user.id,
    requestId: req.id,
    sessionId,
  });

  return res.status(200).json({ success: true, message, data });
});

/**
 * GET /billing/subscription?company_id=1
 *
 * What the company is paying for right now — status, renewal date, per-service
 * breakdown, and each line's captured price.
 */
const getSubscription = asyncHandler(async (req, res) => {
  const companyId = validateCompanyIdQuery(req.query);

  const data = await subscriptionService.getSubscription({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({ success: true, data });
});

/**
 * GET /billing/payments?company_id=1&limit=25&offset=0
 *
 * Payment history, newest first.
 */
const listPayments = asyncHandler(async (req, res) => {
  const companyId = validateCompanyIdQuery(req.query);
  const { limit, offset } = validatePagination(req.query);

  const data = await subscriptionService.listPayments({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    limit,
    offset,
  });

  return res.status(200).json({ success: true, data });
});

/**
 * PATCH /billing/subscription/payroll
 *
 * Change the billed W-2 employee and 1099 contractor counts on a live
 * subscription. Only the counts move; the prices are the ones captured at
 * purchase.
 */
const updatePayroll = asyncHandler(async (req, res) => {
  const { companyId, employeeCount, contractorCount } = validatePayrollUpdate(req.body);

  const { changed, changes, subscription } = await subscriptionService.updatePayrollCounts({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    employeeCount,
    contractorCount,
  });

  return res.status(200).json({
    success: true,
    message: changed ? 'Payroll quantities updated.' : 'No change — the counts already match.',
    data: { changes, subscription },
  });
});

/**
 * DELETE /billing/subscription
 *
 * Cancel. Defaults to end-of-period so the customer keeps what they have paid
 * for; pass `at_period_end: false` to cancel immediately and forfeit it.
 */
const cancelSubscription = asyncHandler(async (req, res) => {
  const { companyId, atPeriodEnd } = validateCancelRequest(req.body);

  const { alreadyScheduled, immediate, subscription } = await subscriptionService.cancelSubscription({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    atPeriodEnd,
  });

  const message = alreadyScheduled
    ? 'Cancellation was already scheduled for the end of the period.'
    : immediate
      ? 'Subscription cancelled immediately.'
      : 'Subscription will be cancelled at the end of the current period.';

  return res.status(200).json({ success: true, message, data: { subscription } });
});

/**
 * POST /billing/portal
 *
 * A short-lived link into Stripe's hosted billing portal, where the customer can
 * update their card or download invoices without this backend handling card data.
 */
const createPortalSession = asyncHandler(async (req, res) => {
  const { companyId } = validatePortalRequest(req.body);

  const data = await subscriptionService.createPortalSession({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(201).json({ success: true, message: 'Billing portal session created.', data });
});

/**
 * POST /billing/webhook
 *
 * Stripe's callback. Unauthenticated by necessity — Stripe holds no access token
 * — so the signature IS the authentication, checked in the service against the
 * raw body. `req.body` here is a Buffer, not parsed JSON (see billingWebhookRoutes).
 *
 * The response is deliberately minimal: Stripe only needs a 2xx, and anything
 * more would leak internal state to an unauthenticated endpoint.
 */
const handleWebhook = asyncHandler(async (req, res) => {
  const result = await stripeWebhookService.processWebhook({
    rawBody: req.body,
    signature: req.headers['stripe-signature'],
    requestId: req.id,
  });

  return res.status(200).json({ received: true, duplicate: Boolean(result.duplicate) });
});

/**
 * The Idempotency-Key header may arrive as a string or (for a repeated header) an
 * array. Reduce it to a single trimmed string, or null when absent/blank.
 */
function normalizeIdempotencyKey(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 255);
  return trimmed || null;
}

module.exports = {
  listPlans,
  createCheckout,
  getCheckoutStatus,
  getSubscription,
  listPayments,
  updatePayroll,
  cancelSubscription,
  createPortalSession,
  handleWebhook,
};
