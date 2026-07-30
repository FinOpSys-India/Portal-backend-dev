'use strict';

const crypto = require('crypto');

const jwt = require('jsonwebtoken');

const config = require('../config');

/**
 * Token helpers shared by the auth flows.
 *
 * Three distinct token types:
 *  - Access token: a signed JWT the client sends on every request. Stateless
 *    and short-lived; carries the user's identity and role as claims.
 *  - Refresh token: a long random string. Only its SHA-256 hash is stored, so
 *    the database never holds anything replayable. The raw value is returned to
 *    the client exactly once.
 *  - Password-reset token: same construction as a refresh token but with a
 *    minutes-long lifetime. It is the bearer proof that the reset OTP was
 *    verified, and nothing else — it grants no session and no API access.
 */

const REFRESH_TOKEN_BYTES = 48;
const RESET_TOKEN_BYTES = 48;

/**
 * Sign a short-lived access token. `sub` is the user id; role/specificRole are
 * copied into the claims so downstream authorization checks need no extra
 * lookup. Never put secrets (password hash, refresh token) in here — a JWT
 * payload is signed, not encrypted, and is readable by anyone holding it.
 */
function signAccessToken({ userId, email, role, specificRole }) {
  return jwt.sign(
    { email, role, specificRole: specificRole ?? null },
    config.auth.jwtSecret,
    {
      subject: String(userId),
      expiresIn: config.auth.accessTokenTtl,
      issuer: config.auth.jwtIssuer,
      audience: config.auth.jwtAudience,
    }
  );
}

/** Verify and decode an access token. Throws (JsonWebTokenError) if invalid. */
function verifyAccessToken(token) {
  return jwt.verify(token, config.auth.jwtSecret, {
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });
}

/** SHA-256 hex digest. Fast hash is fine here: the input is already a 48-byte
 *  random value with full entropy, so there is nothing to brute-force. */
function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Hash a password-reset token for storage / lookup. Same construction as
 * hashRefreshToken — kept as its own name so the two token families read
 * distinctly at the call sites and can diverge later without a rename.
 */
function hashPasswordResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint the ticket token handed back after a password-reset OTP is verified.
 * Returns the raw token (client-only), its hash (for storage), and the absolute
 * expiry. Unlike a refresh token this is single-use and lives for minutes, not
 * days: it exists purely to carry "the OTP checked out" from the verify request
 * to the set-the-password request.
 */
function generatePasswordResetToken() {
  const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + config.passwordReset.ticketTtlSeconds * 1000);
  return { rawToken, tokenHash: hashPasswordResetToken(rawToken), expiresAt };
}

/**
 * Mint a refresh token. Returns the raw token (client-only), its hash (for
 * storage), and the absolute expiry. The caller persists the hash + expiry and
 * hands the raw token back to the client.
 *
 * FUTURE: when the /refresh endpoint lands, rotation reuses this same helper —
 * each refresh revokes the old row and mints a new one here. No change to this
 * function is needed; the rotation/reuse-detection logic belongs in the refresh
 * service (see authRoutes.js and the RefreshToken schema note).
 */
function generateRefreshToken() {
  const rawToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(
    Date.now() + config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000
  );
  return { rawToken, tokenHash: hashRefreshToken(rawToken), expiresAt };
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  hashRefreshToken,
  generateRefreshToken,
  hashPasswordResetToken,
  generatePasswordResetToken,
};
