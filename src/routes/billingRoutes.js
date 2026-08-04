'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { billingLimiter } = require('../middlewares/rateLimiter');
const {
  listPlans,
  createCheckout,
  getCheckoutStatus,
  getSubscription,
  listPayments,
  addServices,
  updatePayroll,
  cancelSubscription,
  createPortalSession,
} = require('../controllers/billingController');

/*
 * Service selection and Stripe Checkout. Every route here is authenticated: the
 * caller id comes from the verified access token (req.user), and per-company
 * authorization — is this caller the company's OWNER, or an ADMIN? — is enforced
 * authoritatively in checkoutService against the database.
 *
 *   GET    /billing/plans                -> sellable options, by our own option ids
 *   POST   /billing/checkout             -> create one Checkout Session for the selection
 *   GET    /billing/checkout-status      -> normalized payment/subscription status
 *   GET    /billing/subscription         -> what the company is paying for now
 *   PATCH  /billing/subscription/payroll -> change the billed head counts
 *   DELETE /billing/subscription         -> cancel (end of period by default)
 *   GET    /billing/payments             -> payment history
 *   POST   /billing/portal               -> link into Stripe's hosted portal
 *
 * POST /billing/webhook is NOT mounted here. It is unauthenticated (Stripe holds
 * no token; the signature is the authentication) and needs the raw request body,
 * so it is mounted separately in app.js ahead of the JSON body parser — see
 * billingWebhookRoutes.
 *
 * requireRole('OWNER', 'ADMIN') on the write route is a coarse token-claim gate
 * in front of the service's authoritative ownership check, matching the pattern
 * in companiesRoutes.
 */
const router = express.Router();

router.use(requireAuth);

const canBill = requireRole('OWNER', 'ADMIN');

/*
 * Reads. Cheap, safe to poll, and the service still proves company access.
 *
 * `/plans` is authenticated like everything else here, but unlike the rest it is
 * NOT company-scoped: it publishes the catalog by our own option ids, so any
 * signed-in user can read it. Everything below it carries real customer data —
 * what a company subscribed to, what it was charged, what failed — and
 * billingAccess proves the caller owns that company (or is an admin) on each.
 */
router.get('/plans', listPlans);
router.get('/checkout-status', getCheckoutStatus);
router.get('/subscription', getSubscription);
router.get('/payments', listPayments);

// Writes. Each costs Stripe API calls and changes what the customer is charged,
// so all five carry the rate limiter and the coarse role gate.
router.post('/checkout', billingLimiter, canBill, createCheckout);
// Adding a service to a LIVE subscription. Registered before the payroll route
// only for readability; Express matches on the full path, so order is not
// load-bearing between these two.
router.post('/subscription/services', billingLimiter, canBill, addServices);
router.patch('/subscription/payroll', billingLimiter, canBill, updatePayroll);
router.delete('/subscription', billingLimiter, canBill, cancelSubscription);
router.post('/portal', billingLimiter, canBill, createPortalSession);

module.exports = router;
