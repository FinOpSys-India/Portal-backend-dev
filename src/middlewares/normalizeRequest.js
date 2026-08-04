'use strict';

const ApiError = require('../utils/ApiError');
const { toCamelDeep, detectCaseCollisions } = require('../utils/caseTransform');

/**
 * Normalise inbound key casing so every validator downstream sees exactly one
 * convention.
 *
 * The API accepts `company_id` and `companyId` alike; this is the single place
 * that reconciles them. Running it BEFORE the validators is what lets those
 * validators keep their strict reject-unknown behaviour — they compare against
 * one canonical name instead of a pair, so a genuine typo is still a 400 rather
 * than being absorbed by a permissive alias list.
 *
 * Two things are deliberately not done here:
 *
 *   - The raw Stripe webhook body is never touched. It is a Buffer (the route
 *     installs express.raw ahead of the JSON parser) and the signature covers
 *     the exact bytes; `toCamelDeep` returns Buffers by reference, and this
 *     middleware is mounted after the webhook route in any case.
 *   - Values are never transformed, only keys. A password with an underscore,
 *     a plan code like `BOOKKEEPING_STARTER`, a specialization code — all reach
 *     the validators byte-identical to what was sent.
 */
module.exports = function normalizeRequest(req, res, next) {
  // A body carrying both spellings of one field is ambiguous: whichever the
  // transform kept, the other was silently discarded, and the caller has no way
  // to learn which. Refuse it rather than guess.
  const collisions = [
    ...detectCaseCollisions(req.body),
    ...detectCaseCollisions(req.query),
  ];
  if (collisions.length) {
    return next(
      new ApiError(
        400,
        `Send each field once. Received both snake_case and camelCase for: ${[...new Set(collisions)].join(', ')}.`,
        { code: 'VALIDATION_ERROR', details: { conflictingFields: [...new Set(collisions)] } }
      )
    );
  }

  if (req.body !== undefined && req.body !== null) {
    req.body = toCamelDeep(req.body);
  }

  /*
   * Express 5 exposes `req.query` as a lazily-evaluated getter on the prototype,
   * so a plain assignment throws. Redefining the property on the instance is the
   * supported way to replace it, and it must be writable so anything later in
   * the chain can still adjust it.
   */
  if (req.query && typeof req.query === 'object') {
    const normalisedQuery = toCamelDeep(req.query);
    Object.defineProperty(req, 'query', {
      value: normalisedQuery,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return next();
};
