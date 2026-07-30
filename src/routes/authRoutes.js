'use strict';

const express = require('express');

const { signup, login, otp } = require('../controllers/authController');
const {
  requestPasswordReset,
  passwordResetOtp,
  confirmPasswordReset,
} = require('../controllers/passwordResetController');
const {
  authLimiter,
  loginLimiter,
  otpLimiter,
  passwordResetLimiter,
} = require('../middlewares/rateLimiter');

const router = express.Router();

router.post('/signup', authLimiter, signup);
router.post('/login', loginLimiter, login);
// One endpoint for both OTP verify and resend; the `action` field selects which.
router.post('/otp', otpLimiter, otp);

/*
 * Forgotten password, in three steps. All three are unauthenticated — the whole
 * point is that the caller cannot sign in — so each is rate limited, and none of
 * them returns a session: a completed reset sends the user back to /login.
 *
 *   POST /password-reset          { email }
 *                                 -> 202 { challengeId, maskedEmail, ... }
 *                                 Answers identically for a registered and an
 *                                 unregistered address; see the controller.
 *   POST /password-reset/otp      { action: 'verify', challengeId, otp }
 *                                 -> 200 { resetToken, expiresInSeconds }
 *                                 { action: 'resend', challengeId }
 *                                 -> 200 { otpResent: true, ... }
 *   POST /password-reset/confirm  { resetToken, password, confirmPassword? }
 *                                 -> 200 { passwordUpdated, sessionsRevoked }
 *
 * The OTP step shares otpLimiter with login: both are per-IP code-guessing
 * surfaces and there is no reason to let an attacker get a fresh budget by
 * switching flows.
 */
router.post('/password-reset', passwordResetLimiter, requestPasswordReset);
router.post('/password-reset/otp', otpLimiter, passwordResetOtp);
router.post('/password-reset/confirm', passwordResetLimiter, confirmPasswordReset);

/*
 * FUTURE: session-lifecycle endpoints. Login/OTP already mint a refresh token
 * (hashed in the refresh_tokens table), but nothing consumes it yet. Still to
 * build:
 *   - POST /refresh  Swap a valid refresh token (from the HttpOnly cookie) for a
 *                    new access token. With ROTATION: revoke the presented token
 *                    and issue a fresh one, so each refresh token is single-use.
 *                    REUSE DETECTION: if an already-revoked token is presented,
 *                    revoke the whole token family and force re-login (see the
 *                    schema note on RefreshToken for the family fields needed).
 *   - POST /logout   Revoke the current session's refresh token (set revokedAt)
 *                    and clear the cookie.
 *   - POST /logout-all  Revoke every refresh token for the user (e.g. after a
 *                    password change or "sign out of all devices").
 * These are cookie-based state changes, so add CSRF protection (see app.js).
 */

module.exports = router;
