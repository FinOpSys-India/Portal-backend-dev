'use strict';

const crypto = require('crypto');

const config = require('../config');

/**
 * Email-OTP helpers.
 *
 * The plain OTP lives only long enough to be emailed; the database stores a
 * keyed digest instead. A six-digit code has just a million possible values, so
 * a plain SHA-256 of it could be reversed with a trivial lookup table — the
 * HMAC keyed with OTP_SECRET is what makes a leaked digest unusable to an
 * attacker who does not also hold the secret.
 */

const OTP_MAX_EXCLUSIVE = 10 ** 6; // 000000–999999

/**
 * Generate a cryptographically random six-digit OTP as a string. Returned as a
 * string, and zero-padded, so leading zeroes survive ("012345" is a valid code
 * and must never be normalised to 12345).
 */
function generateOtp() {
  const n = crypto.randomInt(0, OTP_MAX_EXCLUSIVE);
  return String(n).padStart(config.otp.length, '0');
}

/**
 * Keyed digest of an OTP, bound to its challenge so the same six digits are
 * worthless against a different challenge: HMAC-SHA256(OTP_SECRET,
 * challengeId + ":" + otp), hex-encoded (64 chars).
 */
function digestOtp(challengeId, otp) {
  return crypto
    .createHmac('sha256', config.otp.secret)
    .update(`${challengeId}:${otp}`)
    .digest('hex');
}

/**
 * Constant-time comparison of a freshly computed digest against the stored one.
 * Uses timingSafeEqual so verification time does not leak how many leading
 * characters matched. Returns false (never throws) on any length/format
 * mismatch.
 */
function verifyOtp(challengeId, otp, storedDigest) {
  if (typeof storedDigest !== 'string' || storedDigest.length === 0) return false;
  const computed = digestOtp(challengeId, otp);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedDigest, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Keyed one-way hash of a piece of request context (IP address, user agent) for
 * privacy-preserving storage. Returns null for an absent value so the caller can
 * store NULL rather than a hash of the empty string.
 */
function hashContext(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', config.otp.secret).update(String(value)).digest('hex');
}

/**
 * Mask an email for display before authentication completes, e.g.
 * "alice@example.com" -> "a***e@example.com". Keeps the first and last
 * characters of the local part; a one- or two-character local part is fully
 * masked so nothing meaningful is revealed.
 */
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '*****';
  let maskedLocal;
  if (local.length <= 2) {
    maskedLocal = '*'.repeat(Math.max(local.length, 1));
  } else {
    maskedLocal = `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}`;
  }
  return `${maskedLocal}@${domain}`;
}

module.exports = { generateOtp, digestOtp, verifyOtp, hashContext, maskEmail };
