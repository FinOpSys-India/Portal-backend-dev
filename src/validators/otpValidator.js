'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Validation for POST /api/auth/otp, the single endpoint that handles both
 * OTP verification and OTP resend. Strict: unknown fields are rejected, and the
 * allowed fields depend on the action (an OTP may only accompany `verify`).
 */

const ACTIONS = ['verify', 'resend'];
// crypto.randomUUID() output; matched case-insensitively.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exactly six digits. Validated as a string so a leading zero survives; the OTP
// is never parsed as a number, which would drop it.
const OTP_PATTERN = /^[0-9]{6}$/;

function validateAction(value, fields) {
  if (typeof value !== 'string' || !ACTIONS.includes(value)) {
    fields.action = 'action must be either "verify" or "resend".';
    return null;
  }
  return value;
}

function validateChallengeId(value, fields) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fields.challengeId = 'A valid challengeId is required.';
    return null;
  }
  return value;
}

/**
 * Validate an OTP request body. Returns { action, challengeId, otp? }. Throws a
 * 400 VALIDATION_ERROR with per-field messages; the submitted OTP is never
 * echoed back in an error.
 */
function validateOtpRequest(body) {
  const fields = {};
  const input = body && typeof body === 'object' ? body : {};

  const action = validateAction(input.action, fields);
  const challengeId = validateChallengeId(input.challengeId, fields);

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

  if (Object.keys(fields).length) {
    throw new ApiError(400, 'The submitted information is invalid.', {
      code: 'VALIDATION_ERROR',
      fields,
    });
  }

  return action === 'verify' ? { action, challengeId, otp } : { action, challengeId };
}

module.exports = { validateOtpRequest };
