'use strict';

const common = require('./common');

/**
 * Validation for POST /auth/otp, the single endpoint that handles both OTP
 * verification and OTP resend. Strict: unknown fields are rejected, and the
 * allowed fields depend on the action (an OTP may only accompany `verify`).
 */

const ACTIONS = ['verify', 'resend'];
// Exactly six digits. Validated as a string so a leading zero survives; the OTP
// is never parsed as a number, which would drop it.
const OTP_PATTERN = /^[0-9]{6}$/;

/**
 * Validate an OTP request body. Returns { action, challengeId, otp? }. Throws a
 * 400 VALIDATION_ERROR with per-field messages; the submitted OTP is never
 * echoed back in an error.
 */
function validateOtpRequest(body = {}) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const action = typeof input.action === 'string' && ACTIONS.includes(input.action) ? input.action : null;
  if (!action) {
    fields.action = 'action must be either "verify" or "resend".';
  }

  if (typeof input.challengeId !== 'string' || !common.UUID_PATTERN.test(input.challengeId)) {
    fields.challengeId = 'A valid challengeId is required.';
  }

  // Only the fields relevant to the resolved action are permitted. Anything else
  // — a stray `otp` on a resend, an `email` trying to redirect delivery, a typo'd
  // key — is rejected rather than silently ignored.
  const allowed = new Set(['action', 'challengeId']);
  if (action === 'verify') allowed.add('otp');

  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    fields._ = `Unexpected field(s): ${unexpected.join(', ')}.`;
  }

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

module.exports = { validateOtpRequest, OTP_PATTERN, ACTIONS };
