'use strict';

const Stripe = require('stripe');

const config = require('./index');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Lazily-constructed Stripe client.
 *
 * Deliberately NOT built at import time. The billing modules are pulled in by
 * src/routes/index.js, which every request and every test loads — constructing a
 * client here would make a missing STRIPE_SECRET_KEY crash the whole API at
 * startup instead of failing only the billing routes. Outside production the app
 * is expected to run without a Stripe account at all (that is how the test suite
 * works), so the absence of a key becomes a clean 503 on the routes that need it
 * and is invisible everywhere else.
 */
let client = null;

/** True when a secret key is configured; billing routes gate on this. */
function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

/**
 * The shared Stripe client.
 * @throws {ApiError} 503 STRIPE_NOT_CONFIGURED when no secret key is set.
 */
function getStripe() {
  if (!isConfigured()) {
    throw new ApiError(503, 'Billing is not available right now.', {
      code: 'STRIPE_NOT_CONFIGURED',
    });
  }
  if (!client) {
    client = new Stripe(config.stripe.secretKey, {
      ...(config.stripe.apiVersion ? { apiVersion: config.stripe.apiVersion } : {}),
      // Surfaces this service by name in the Stripe dashboard's request logs,
      // which is what you want when several systems share one account.
      appInfo: { name: 'finopsys-portal-backend' },
      // Stripe retries idempotently on its side; two attempts is enough to ride
      // out a blip without stacking latency onto a user waiting on a redirect.
      maxNetworkRetries: 2,
    });
    logger.info('Stripe client initialised.');
  }
  return client;
}

/** Reset the memoised client. Test-only seam. */
function _resetStripe() {
  client = null;
}

module.exports = { getStripe, isConfigured, _resetStripe };
