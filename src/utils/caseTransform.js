'use strict';

/**
 * Key-case translation between the wire format and the internal one.
 *
 * The API accepts BOTH `snake_case` and `camelCase` on the way in, and always
 * answers in `camelCase`. That asymmetry is deliberate:
 *
 *   - Inbound tolerance means the existing clients that send `company_id` keep
 *     working, and a new client that sends `companyId` works too. Neither has to
 *     know which module it is talking to — the old split (auth in camelCase,
 *     billing in snake_case) is invisible from outside.
 *   - Outbound uniformity means a client models ONE convention. A response
 *     shape that changes case depending on which router produced it is the kind
 *     of thing that gets papered over with a global transform, which then
 *     corrupts whichever half of the API it was not written for.
 *
 * Normalisation happens once, in middlewares/normalizeRequest, before any
 * validator runs; serialisation happens once, in the DTOs. Nothing in between
 * has to think about it.
 */

/**
 * Values that must survive a deep transform untouched. A Buffer is the Stripe
 * webhook's raw body, and Date/RegExp have their own semantics — recursing into
 * any of them would quietly destroy the value while "succeeding".
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (Buffer.isBuffer(value)) return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  return true;
}

/**
 * `company_id` -> `companyId`, `address_line_1` -> `addressLine1`.
 *
 * A key that is already camelCase passes through unchanged, which is what makes
 * accepting both conventions a no-op rather than a translation table.
 */
function toCamelKey(key) {
  if (!key.includes('_')) return key;
  // A leading underscore is meaningful: the validators use `_` as the key for
  // form-level (non-field) messages, so it must not be eaten by the transform.
  if (key === '_') return key;
  return key.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** `companyId` -> `company_id`. Kept for callers that need the wire form back. */
function toSnakeKey(key) {
  if (key === '_') return key;
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Recursively rewrite every key of a plain object (and of objects inside
 * arrays) with `mapKey`. Non-plain values are returned by reference — the
 * transform is about key names, never about copying payloads.
 *
 * A key collision (a body carrying BOTH `company_id` and `companyId`) resolves
 * to whichever key appears last. That is ambiguous input, and the validators
 * reject-unknown pass cannot see it once both have collapsed to one name, so
 * `detectCaseCollisions` below is used to refuse it explicitly instead.
 */
function transformKeys(value, mapKey) {
  if (Array.isArray(value)) return value.map((item) => transformKeys(item, mapKey));
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[mapKey(key)] = transformKeys(val, mapKey);
  }
  return out;
}

const toCamelDeep = (value) => transformKeys(value, toCamelKey);
const toSnakeDeep = (value) => transformKeys(value, toSnakeKey);

/**
 * Find keys that would collide once normalised — `{ company_id: 1, companyId: 2 }`.
 *
 * Silently picking one is the wrong answer: the caller has expressed two
 * different intentions for one field and cannot be told which was honoured.
 * Returns the offending camelCase names so the caller can 400 with them.
 */
function detectCaseCollisions(value, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => detectCaseCollisions(item, `${path}[${i}]`, found));
    return found;
  }
  if (!isPlainObject(value)) return found;

  const seen = new Map();
  for (const key of Object.keys(value)) {
    const normalised = toCamelKey(key);
    if (seen.has(normalised) && seen.get(normalised) !== key) {
      found.push(path ? `${path}.${normalised}` : normalised);
    } else {
      seen.set(normalised, key);
    }
  }

  for (const [key, val] of Object.entries(value)) {
    detectCaseCollisions(val, path ? `${path}.${toCamelKey(key)}` : toCamelKey(key), found);
  }
  return found;
}

module.exports = {
  toCamelKey,
  toSnakeKey,
  toCamelDeep,
  toSnakeDeep,
  detectCaseCollisions,
  isPlainObject,
};
