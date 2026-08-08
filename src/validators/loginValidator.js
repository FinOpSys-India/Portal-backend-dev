'use strict';

const common = require('./common');

/**
 * Validation for POST /auth/login.
 *
 * Produces field-level messages under `fields` so the client can highlight the
 * offending input — but never echoes the submitted password back in any error.
 *
 * The email rule is validators/common's, shared with sign-up and password reset,
 * so all three agree on what a valid address is.
 */

// Upper bound on the raw password so a multi-megabyte body cannot be used to
// force expensive hashing. Well above any legitimate passphrase.
const MAX_PASSWORD_LENGTH = common.LIMITS.password;

/**
 * Validate a login body. Returns the normalised email and the untouched
 * password. Throws a 400 VALIDATION_ERROR with per-field messages on any
 * problem; the message set never contains the password itself.
 */
function validateLogin(body = {}) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  let email = null;
  try {
    email = common.email(input.email);
  } catch (err) {
    fields.email = err.fields?.email ?? 'A valid email is required.';
  }

  // The password is never trimmed, lower-cased, or otherwise altered — leading
  // and trailing spaces are legitimate characters and must reach verification
  // exactly as typed.
  let password = '';
  if (typeof input.password !== 'string' || input.password.length === 0) {
    fields.password = 'Password is required.';
  } else if (input.password.length > MAX_PASSWORD_LENGTH) {
    fields.password = 'Password is too long.';
  } else {
    password = input.password;
  }

  // Reject unknown fields alongside the per-field errors rather than ahead of
  // them, so a body with both a typo'd key and a bad email reports both.
  const unknown = Object.keys(input).filter((k) => !['email', 'password'].includes(k));
  if (unknown.length) {
    fields._ = `Unexpected field(s): ${unknown.join(', ')}.`;
  }

  if (Object.keys(fields).length) common.fail(fields);

  return { email, password };
}

module.exports = { validateLogin };
