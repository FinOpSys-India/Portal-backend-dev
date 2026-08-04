'use strict';

const ApiError = require('../utils/ApiError');
const common = require('./common');

/**
 * Input validation for the sign-up flow.
 *
 * The email, name, and length rules now come from validators/common, so sign-up
 * and login agree on what a valid address is. They previously did not: sign-up
 * allowed 255 characters and login 254, which meant an address of exactly 255
 * could register and then never authenticate.
 */

// Password policy. Deliberately checks composition, not just length: an 8-char
// minimum alone still permits "password". The 72-byte ceiling is bcrypt's own
// limit — it silently truncates beyond that, so anything longer is rejected
// rather than accepted with bytes that do not count toward the password.
const PASSWORD = {
  minLength: 8,
  maxBytes: 72,
};

const SIGNUP_FIELDS = ['invitationToken', 'email', 'firstName', 'lastName', 'password'];

/**
 * Enforce the password policy. Returns the password unchanged on success (it is
 * never trimmed or normalised — surrounding spaces are legitimate characters).
 * Collects every failed rule so the caller learns all of them at once.
 */
function validatePassword(value) {
  const password = String(value);
  const failures = [];

  if (password.length < PASSWORD.minLength) {
    failures.push(`be at least ${PASSWORD.minLength} characters`);
  }
  // bcrypt operates on bytes, and multi-byte characters make length() and the
  // byte count diverge, so measure the real input to bcrypt.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD.maxBytes) {
    failures.push(`be at most ${PASSWORD.maxBytes} bytes`);
  }
  if (!/[a-z]/.test(password)) failures.push('contain a lowercase letter');
  if (!/[A-Z]/.test(password)) failures.push('contain an uppercase letter');
  if (!/[0-9]/.test(password)) failures.push('contain a number');

  if (failures.length) {
    throw new ApiError(400, `Password must ${failures.join(', ')}.`, {
      code: 'VALIDATION_ERROR',
      fields: { password: `Password must ${failures.join(', ')}.` },
      details: { requirements: failures },
    });
  }
  return password;
}

/**
 * The invitation token is `crypto.randomBytes(32).toString('hex')` — 64 hex
 * characters. Shape-checking it here rejects obvious junk before it reaches a
 * database lookup, and keeps a multi-kilobyte "token" out of the query.
 */
function validateInvitationToken(value) {
  if (typeof value !== 'string' || !common.INVITATION_TOKEN_PATTERN.test(value.trim())) {
    throw common.fieldError('invitationToken', 'A valid invitation token is required.', 'This invitation link is not valid.');
  }
  return value.trim();
}

/**
 * Validate and normalise a sign-up request body. Returns only the whitelisted,
 * cleaned fields — never the raw body — so nothing unexpected reaches the
 * service layer. The token is never echoed anywhere.
 */
function validateSignup(body = {}) {
  common.rejectUnknown(body, SIGNUP_FIELDS);
  common.requireFields(body, SIGNUP_FIELDS);

  return {
    invitationToken: validateInvitationToken(body.invitationToken),
    email: common.email(body.email),
    firstName: common.str(body.firstName, 'firstName', { max: common.LIMITS.firstName }),
    lastName: common.str(body.lastName, 'lastName', { max: common.LIMITS.lastName }),
    password: validatePassword(body.password),
  };
}

// validatePassword is exported so the password-reset flow enforces the identical
// policy. One definition means a rule tightened here cannot be silently skipped
// by the other path — which would let a user reset their way to a weaker
// password than sign-up would ever have accepted.
module.exports = { validateSignup, validatePassword, validateInvitationToken, PASSWORD };
