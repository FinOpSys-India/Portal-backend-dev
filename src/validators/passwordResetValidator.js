'use strict';

const common = require('./common');
const { validatePassword } = require('./authValidator');
const { OTP_PATTERN, ACTIONS } = require('./otpValidator');

/**
 * Validation for the forgotten-password endpoints. Strict about unknown fields,
 * and careful never to echo a submitted secret — password, OTP, or reset token —
 * back in an error message.
 *
 * Three bodies are validated here:
 *   POST /auth/password-reset          { email }
 *   POST /auth/password-reset/otp      { action, challengeId, otp? }
 *   POST /auth/password-reset/confirm  { resetToken, password, confirmPassword? }
 *
 * The OTP grammar is imported from otpValidator rather than re-declared. It was
 * previously duplicated so the two flows "could diverge"; in practice that only
 * meant a rule tightened in one place silently failed to apply in the other.
 * Where the flows genuinely differ — what a success returns, which failures are
 * disclosed — they still differ, in the services.
 */

// 48 random bytes, hex-encoded by generatePasswordResetToken().
const RESET_TOKEN_PATTERN = /^[0-9a-f]{96}$/i;

/**
 * Step one: the address to send a reset code to. `email` is the only accepted
 * field — nothing in the body may influence which account is targeted beyond
 * naming it, and nothing may redirect delivery (the code always goes to the
 * address stored on the account, which the service reads from the database).
 */
function validatePasswordResetRequest(body = {}) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  let email = null;
  try {
    email = common.email(input.email);
  } catch (err) {
    fields.email = err.fields?.email ?? 'A valid email is required.';
  }

  const unknown = Object.keys(input).filter((k) => k !== 'email');
  if (unknown.length) fields._ = `Unexpected field(s): ${unknown.join(', ')}.`;

  if (Object.keys(fields).length) common.fail(fields);

  return { email };
}

/**
 * Step two: verify or resend the reset code.
 */
function validatePasswordResetOtp(body = {}) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const action = typeof input.action === 'string' && ACTIONS.includes(input.action) ? input.action : null;
  if (!action) {
    fields.action = 'action must be either "verify" or "resend".';
  }

  if (typeof input.challengeId !== 'string' || !common.UUID_PATTERN.test(input.challengeId)) {
    fields.challengeId = 'A valid challengeId is required.';
  }

  const allowed = new Set(['action', 'challengeId']);
  if (action === 'verify') allowed.add('otp');
  const unknown = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknown.length) fields._ = `Unexpected field(s): ${unknown.join(', ')}.`;

  let otp;
  if (action === 'verify') {
    if (typeof input.otp !== 'string' || !OTP_PATTERN.test(input.otp)) {
      fields.otp = 'A six-digit verification code is required.';
    } else {
      otp = input.otp;
    }
  }

  if (Object.keys(fields).length) common.fail(fields);

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
 */
function validatePasswordResetConfirm(body = {}) {
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

  const allowed = new Set(['resetToken', 'password', 'confirmPassword']);
  const unknown = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknown.length) fields._ = `Unexpected field(s): ${unknown.join(', ')}.`;

  if (Object.keys(fields).length) common.fail(fields);

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
  RESET_TOKEN_PATTERN,
};
