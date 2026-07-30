'use strict';

const ApiError = require('../utils/ApiError');
const { validatePassword } = require('./authValidator');

/**
 * Validation for the forgotten-password endpoints. Hand-rolled to match the rest
 * of the project (no schema library), strict about unknown fields, and careful
 * never to echo a submitted secret — password, OTP, or reset token — back in an
 * error message.
 *
 * Three bodies are validated here:
 *   POST /auth/password-reset          { email }
 *   POST /auth/password-reset/otp      { action, challengeId, otp? }
 *   POST /auth/password-reset/confirm  { resetToken, password, confirmPassword? }
 */

// Same shape used everywhere else in the app. Deliberately simple: the real
// proof an address is reachable is the OTP email arriving.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 5321 caps an address at 254 characters.
const MAX_EMAIL_LENGTH = 254;

const ACTIONS = ['verify', 'resend'];
// crypto.randomUUID() output; matched case-insensitively.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exactly six digits. Validated as a string so a leading zero survives; the OTP
// is never parsed as a number, which would drop it.
const OTP_PATTERN = /^[0-9]{6}$/;
// 48 random bytes, hex-encoded by generatePasswordResetToken().
const RESET_TOKEN_PATTERN = /^[0-9a-f]{96}$/i;

/**
 * True if the string contains any C0/C1 control character or DEL. A normal email
 * never does; a value that does is almost certainly an injection probe. Checked
 * numerically to keep raw control bytes out of the source.
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
  // Trim surrounding whitespace, then lower-case — the identical normalisation
  // applied at registration and login, so the stored and looked-up values line
  // up and "  Alice@Example.com " finds the same row as "alice@example.com".
  const email = value.trim().toLowerCase();
  if (!email) {
    fields.email = 'Email is required.';
  } else if (
    hasControlChars(email) ||
    !EMAIL_PATTERN.test(email) ||
    email.length > MAX_EMAIL_LENGTH
  ) {
    fields.email = 'A valid email is required.';
  }
  return email;
}

/** Reject any key we did not ask for, rather than silently ignoring it. */
function rejectUnexpected(input, allowed, fields) {
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    fields._ = `Unexpected field(s): ${unexpected.join(', ')}.`;
  }
}

function fail(fields) {
  throw new ApiError(400, 'The submitted information is invalid.', {
    code: 'VALIDATION_ERROR',
    fields,
  });
}

/**
 * Step one: the address to send a reset code to. `email` is the only accepted
 * field — nothing in the body may influence which account is targeted beyond
 * naming it, and nothing may redirect delivery (the code always goes to the
 * address stored on the account, which the service reads from the database).
 *
 * @returns {{ email: string }} the normalised address
 */
function validatePasswordResetRequest(body) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const email = normalizeEmailOrFail(input.email, fields);
  rejectUnexpected(input, new Set(['email']), fields);

  if (Object.keys(fields).length) fail(fields);

  return { email };
}

/**
 * Step two: verify or resend the reset code. Identical in shape to the login OTP
 * body, but validated here rather than shared so the two flows can diverge
 * without one quietly loosening the other. The allowed fields depend on the
 * action — an `otp` may only accompany `verify`.
 *
 * @returns {{ action: 'verify'|'resend', challengeId: string, otp?: string }}
 */
function validatePasswordResetOtp(body) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const action =
    typeof input.action === 'string' && ACTIONS.includes(input.action) ? input.action : null;
  if (!action) {
    fields.action = 'action must be either "verify" or "resend".';
  }

  if (typeof input.challengeId !== 'string' || !UUID_PATTERN.test(input.challengeId)) {
    fields.challengeId = 'A valid challengeId is required.';
  }

  const allowed = new Set(['action', 'challengeId']);
  if (action === 'verify') allowed.add('otp');
  rejectUnexpected(input, allowed, fields);

  let otp;
  if (action === 'verify') {
    if (typeof input.otp !== 'string' || !OTP_PATTERN.test(input.otp)) {
      fields.otp = 'A six-digit verification code is required.';
    } else {
      otp = input.otp;
    }
  }

  if (Object.keys(fields).length) fail(fields);

  return action === 'verify'
    ? { action, challengeId: input.challengeId, otp }
    : { action, challengeId: input.challengeId };
}

/**
 * Step three: the new password, authorised by the ticket minted at step two.
 *
 * The password policy is authValidator's, unchanged — resetting must not be a
 * route to a weaker password than sign-up allows. `confirmPassword` is optional
 * (the browser normally checks it) but is verified when present, so a typo in a
 * paste-disabled field is caught here rather than locking the user out of the
 * account they just recovered.
 *
 * The reset token is shape-checked only. Whether it is real, unused and unexpired
 * is a database question, answered in the service — this layer exists to reject
 * obvious junk cheaply, before a lookup.
 *
 * @returns {{ resetToken: string, password: string }}
 */
function validatePasswordResetConfirm(body) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  if (typeof input.resetToken !== 'string' || !RESET_TOKEN_PATTERN.test(input.resetToken)) {
    fields.resetToken = 'A valid resetToken is required.';
  }

  // Presence only here; the policy check runs below, once we know it is a string.
  // Never trimmed or normalised — leading and trailing spaces are legitimate
  // password characters and must survive to hashing exactly as typed.
  if (typeof input.password !== 'string' || input.password.length === 0) {
    fields.password = 'Password is required.';
  }

  if (input.confirmPassword !== undefined) {
    if (typeof input.confirmPassword !== 'string') {
      fields.confirmPassword = 'confirmPassword must be a string.';
    } else if (input.confirmPassword !== input.password) {
      fields.confirmPassword = 'The passwords do not match.';
    }
  }

  rejectUnexpected(input, new Set(['resetToken', 'password', 'confirmPassword']), fields);

  if (Object.keys(fields).length) fail(fields);

  // Throws its own 400 listing every unmet requirement at once. Deliberately
  // last: telling someone their password is too weak is only useful once we know
  // the rest of the body is coherent.
  const password = validatePassword(input.password);

  return { resetToken: input.resetToken, password };
}

module.exports = {
  validatePasswordResetRequest,
  validatePasswordResetOtp,
  validatePasswordResetConfirm,
};
