'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Validation for POST /api/auth/login. Hand-rolled to match the rest of the
 * project (no schema library). Produces field-level messages under `fields` so
 * the client can highlight the offending input — but never echoes the submitted
 * password back in any error.
 */

// Same shape used everywhere else in the app. Deliberately simple: the real
// proof an address is reachable is the OTP email arriving.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 5321 caps an address at 254 characters.
const MAX_EMAIL_LENGTH = 254;
// Upper bound on the raw password so a multi-megabyte body cannot be used to
// force expensive hashing. Well above any legitimate passphrase.
const MAX_PASSWORD_LENGTH = 1024;

/**
 * True if the string contains any C0/C1 control character or DEL. A normal
 * email never does; a value that does is almost certainly an injection probe.
 * Checked numerically to keep raw control bytes out of the source.
 */
function hasControlChars(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizeEmailOrFail(value, fields) {
  if (typeof value !== 'string') {
    fields.email = 'Email is required.';
    return null;
  }
  // Trim only surrounding whitespace, then lower-case — the identical
  // normalisation applied at registration, so the stored and looked-up values
  // line up.
  const email = value.trim().toLowerCase();
  if (!email) {
    fields.email = 'Email is required.';
  } else if (hasControlChars(email) || !EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
    fields.email = 'A valid email is required.';
  }
  return email;
}

function validatePasswordPresence(value, fields) {
  // The password is never trimmed, lower-cased, or otherwise altered — leading
  // and trailing spaces are legitimate characters and must reach verification
  // exactly as typed.
  if (typeof value !== 'string' || value.length === 0) {
    fields.password = 'Password is required.';
    return '';
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    fields.password = 'Password is too long.';
  }
  return value;
}

/**
 * Validate a login body. Returns the normalised email and the untouched
 * password. Throws a 400 VALIDATION_ERROR with per-field messages on any
 * problem; the message set never contains the password itself.
 */
function validateLogin(body) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const email = normalizeEmailOrFail(input.email, fields);
  const password = validatePasswordPresence(input.password, fields);

  if (Object.keys(fields).length) {
    throw new ApiError(400, 'The submitted information is invalid.', {
      code: 'VALIDATION_ERROR',
      fields,
    });
  }

  return { email, password };
}

module.exports = { validateLogin };
