'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Shared validation primitives.
 *
 * Every rule that more than one endpoint needs lives here exactly once. Before
 * this file the email regex was declared in five places, the phone rule in two,
 * and `parseId` in two — and they had already drifted: sign-up accepted a
 * 255-character address that login (capped at 254) could never authenticate,
 * and the control-character guard protected only two of the five entry points.
 * A rule that exists in five copies is five rules.
 *
 * Field names here are the canonical camelCase ones. Requests may arrive in
 * snake_case; middlewares/normalizeRequest has already reconciled that by the
 * time any of this runs.
 */

/* -------------------------------------------------------------------------- */
/* limits                                                                     */
/* -------------------------------------------------------------------------- */

const LIMITS = {
  // RFC 5321 caps a full address at 254 characters. The database column is
  // VARCHAR(255), so 254 is the binding constraint everywhere and is now applied
  // everywhere — sign-up used to allow 255.
  email: 254,
  firstName: 100,
  lastName: 100,
  phone: 30,
  jobTitle: 150,
  companyName: 255,
  password: 1024,
  addressLine: 255,
  city: 120,
  state: 120,
  postalCode: 20,
  country: 100,
  specializationCode: 50,
  idempotencyKey: 255,
};

// Deliberately pragmatic: the real proof an address is reachable is a delivered
// message, not a regex. This one rejects the shapes that cannot possibly work.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Optional leading '+', a leading digit, then digits and the usual separators.
// The digit-count bound below is the real gate; this just rejects obvious junk.
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{5,}$/;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

// crypto.randomUUID() output, matched case-insensitively.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// crypto.randomBytes(32).toString('hex') — the invitation token.
const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

/* -------------------------------------------------------------------------- */
/* error helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Throw a 400 carrying per-field messages. `_` is the form-level key. */
function fail(fields, message = 'The submitted information is invalid.') {
  throw new ApiError(400, message, { code: 'VALIDATION_ERROR', fields });
}

function fieldError(field, message, detail) {
  return new ApiError(400, message, {
    code: 'VALIDATION_ERROR',
    fields: { [field]: detail ?? message },
  });
}

/**
 * Reject any key that is not in the allowed set.
 *
 * Applied to EVERY request body now, not just the company and billing ones. A
 * silently-ignored field is indistinguishable from an accepted one, which is the
 * worst possible failure mode for a form: the user submits, the request
 * succeeds, and the value they typed was never stored.
 */
function rejectUnknown(body, allowed, where = 'request body') {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ApiError(400, `Unknown field(s) in ${where}: ${unknown.join(', ')}.`, {
      code: 'VALIDATION_ERROR',
      details: { unknown, where },
    });
  }
}

/** Treat undefined, null, and '' as missing; report them all at once. */
function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw new ApiError(400, 'Required fields are missing.', {
      code: 'VALIDATION_ERROR',
      details: { missing },
      fields: Object.fromEntries(missing.map((f) => [f, 'Required.'])),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* scalar validators                                                          */
/* -------------------------------------------------------------------------- */

/**
 * True if the string contains any C0/C1 control character or DEL. A legitimate
 * email or name never does; a value that does is almost certainly an injection
 * probe. Checked numerically to keep raw control bytes out of the source.
 */
function hasControlChars(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Trimmed, length-checked string. Returns null for an absent optional value. */
function str(value, field, { max, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fieldError(field, `${field} is required.`, 'Required.');
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw fieldError(field, `${field} must be text.`, 'Enter a valid value.');
  }
  const s = String(value).trim();
  if (!s) {
    if (required) throw fieldError(field, `${field} cannot be blank.`, 'Required.');
    return null;
  }
  if (max && s.length > max) {
    throw fieldError(field, `${field} cannot exceed ${max} characters.`, `Must be at most ${max} characters.`);
  }
  if (hasControlChars(s)) {
    throw fieldError(field, `${field} contains invalid characters.`, 'Remove any special control characters.');
  }
  return s;
}

/**
 * Normalise and validate an email. Trimmed then lower-cased — the identical
 * normalisation applied at registration, login, and reset, so the stored value
 * and the looked-up value always line up.
 */
function email(value, field = 'email') {
  if (typeof value !== 'string') {
    throw fieldError(field, 'A valid email address is required.', 'Email is required.');
  }
  const normalised = value.trim().toLowerCase();
  if (!normalised) {
    throw fieldError(field, 'A valid email address is required.', 'Email is required.');
  }
  if (
    hasControlChars(normalised) ||
    !EMAIL_PATTERN.test(normalised) ||
    normalised.length > LIMITS.email
  ) {
    throw fieldError(field, 'A valid email address is required.', 'Enter a valid email address.');
  }
  return normalised;
}

/**
 * Permissive phone check. Stored verbatim — the app deliberately does not
 * canonicalise numbers, so "+1 (415) 555-0123" round-trips exactly as typed.
 */
function phone(value, field = 'phone') {
  const raw = str(value, field, { max: LIMITS.phone });
  const digits = raw.replace(/\D/g, '');
  if (!PHONE_PATTERN.test(raw) || digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    throw fieldError(field, 'A valid phone number is required.', 'Enter a valid phone number.');
  }
  return raw;
}

/** Parse a path param / body id into a positive integer or throw 400. */
function parseId(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw fieldError(field, `${field} must be a positive integer.`, 'Invalid id.');
  }
  return n;
}

/**
 * A whole number within bounds. Shape-checked with a regex BEFORE conversion:
 * `Number('')` is 0 and `Number(' 3 ')` is 3, so a bare `Number()` would let an
 * empty string through as zero.
 */
function integer(value, field, { min = 0, max, required = true, defaultValue = null, code } = {}) {
  const invalid = (detail) =>
    new ApiError(400, `${field} must be a whole number between ${min} and ${max ?? 'the maximum'}.`, {
      code: code || 'VALIDATION_ERROR',
      fields: { [field]: detail },
    });

  if (value === undefined || value === null || value === '') {
    if (required) throw invalid('Enter a whole number.');
    return defaultValue;
  }
  if (typeof value === 'boolean') throw invalid('Enter a whole number.');

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw invalid('Whole numbers only — no decimals.');
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!/^-?\d+$/.test(raw)) {
      throw invalid(raw.includes('.') ? 'Whole numbers only — no decimals.' : 'Enter a whole number.');
    }
  } else {
    throw invalid('Enter a whole number.');
  }

  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid('Enter a whole number.');
  if (n < min) throw invalid(`Must be at least ${min}.`);
  if (max !== undefined && n > max) throw invalid(`Must be at most ${max}.`);
  return n;
}

/**
 * A boolean that may arrive as a real boolean or as the strings "true"/"false"
 * (query strings and some form encoders cannot express a JSON boolean).
 */
function boolean(value, field, { defaultValue = null, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fieldError(field, `${field} is required.`, 'Use true or false.');
    return defaultValue;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw fieldError(field, `${field} must be true or false.`, 'Use true or false.');
}

/** A value from a fixed set, upper-cased first. */
function enumValue(value, field, allowed, { required = true, defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fieldError(field, `${field} is required.`, 'Select an option.');
    return defaultValue;
  }
  const candidate = String(value).trim().toUpperCase();
  if (!allowed.includes(candidate)) {
    throw new ApiError(400, `${field} is not a supported value.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: `Must be one of: ${allowed.join(', ')}.` },
      details: { allowed },
    });
  }
  return candidate;
}

/**
 * Non-negative decimal with at most two fraction digits, returned as a STRING so
 * it reaches Prisma's Decimal without ever passing through a binary float
 * (which would round large values).
 */
function decimalAmount(value, field, { maxIntegerDigits = 16 } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw fieldError(field, `${field} must be a non-negative amount.`, 'Enter an amount of 0 or more.');
  }
  const raw = String(value).trim();
  if (!new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,2})?$`).test(raw)) {
    throw fieldError(
      field,
      `${field} must be a non-negative amount with at most 2 decimals.`,
      'Enter a valid amount (max 2 decimal places).'
    );
  }
  return raw;
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw fieldError(field, `A valid ${field} is required.`, 'Invalid identifier.');
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* pagination + sorting                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `?limit=&offset=&sort=&order=` for every list endpoint.
 *
 * One implementation so a client learns the paging contract once. `sortable` is
 * the allowlist of columns a caller may order by — never the raw value, which
 * would otherwise reach an ORDER BY.
 */
function pagination(query = {}, { defaultLimit = 25, maxLimit = 100, sortable = [], defaultSort = null } = {}) {
  const num = (value, field, fallback, max) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!/^\d+$/.test(String(value).trim())) {
      throw fieldError(field, `${field} must be a whole number.`, 'Enter a whole number.');
    }
    return Math.min(Number(value), max);
  };

  const limit = Math.max(1, num(query.limit, 'limit', defaultLimit, maxLimit));
  const offset = num(query.offset, 'offset', 0, 1_000_000);

  let sort = defaultSort;
  if (query.sort !== undefined && query.sort !== null && query.sort !== '') {
    const candidate = String(query.sort).trim();
    if (!sortable.includes(candidate)) {
      throw new ApiError(400, 'sort is not a supported field.', {
        code: 'VALIDATION_ERROR',
        fields: { sort: `Sort by one of: ${sortable.join(', ')}.` },
        details: { allowed: sortable },
      });
    }
    sort = candidate;
  }

  const order = query.order === undefined || query.order === null || query.order === ''
    ? 'desc'
    : String(query.order).trim().toLowerCase();
  if (!['asc', 'desc'].includes(order)) {
    throw fieldError('order', 'order must be asc or desc.', 'Use asc or desc.');
  }

  return { limit, offset, sort, order };
}

module.exports = {
  LIMITS,
  EMAIL_PATTERN,
  PHONE_PATTERN,
  UUID_PATTERN,
  INVITATION_TOKEN_PATTERN,
  fail,
  fieldError,
  rejectUnknown,
  requireFields,
  hasControlChars,
  str,
  email,
  phone,
  parseId,
  integer,
  boolean,
  enumValue,
  decimalAmount,
  uuid,
  pagination,
};
