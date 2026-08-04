'use strict';

const express = require('express');

const { signup, login, otp, refresh, logout, logoutAll } = require('../controllers/authController');
const {
  requestPasswordReset,
  passwordResetOtp,
  confirmPasswordReset,
} = require('../controllers/passwordResetController');
const requireAuth = require('../middlewares/requireAuth');
const { requireCsrf } = require('../middlewares/csrf');
const {
  authLimiter,
  loginLimiter,
  otpLimiter,
  passwordResetLimiter,
  refreshLimiter,
} = require('../middlewares/rateLimiter');

const router = express.Router();

/*
 * Account creation and sign-in.
 *
 *   POST /signup   { invitationToken, email, firstName, lastName, password }
 *                  -> 201 { user, tokens }   (no OTP step; the invitation is the proof)
 *   POST /login    { email, password }
 *                  -> 202 { otpRequired, challengeId, ... }   (NOT signed in yet)
 *   POST /otp      { action: 'verify', challengeId, otp }
 *                  -> 200 { authenticated, user, accessToken, ... }
 *                  { action: 'resend', challengeId }
 *                  -> 200 { otpResent, ... }
 */
router.post('/signup', authLimiter, signup);
router.post('/login', loginLimiter, login);
// One endpoint for both OTP verify and resend; the `action` field selects which.
router.post('/otp', otpLimiter, otp);

/*
 * Session lifecycle.
 *
 *   POST /refresh     cookie or { refreshToken }
 *                     -> 200 { accessToken, refreshToken, ... }
 *                     Rotates: the presented token is revoked and replaced, so
 *                     each one is single-use. Replaying a rotated token is
 *                     treated as theft and revokes the whole family.
 *   POST /logout      -> 200 { sessionsRevoked }   revokes this session's family
 *   POST /logout-all  -> 200 { sessionsRevoked }   revokes every session
 *
 * /refresh and /logout carry requireCsrf because they act on the HttpOnly
 * cookie, which a browser attaches to cross-site requests by itself. The check
 * is skipped automatically for callers presenting a Bearer token, which is not
 * attached automatically and therefore not forgeable this way.
 *
 * /logout-all needs requireAuth instead: it acts on the USER, not on one
 * session, so it must work even when the cookie for this device is gone —
 * which is the state someone reaching for "sign out everywhere" is often in.
 *
 * /refresh gets its own limiter. It is unauthenticated by nature (an expired
 * access token is exactly when it is called), and rotation writes on every hit.
 */
router.post('/refresh', refreshLimiter, requireCsrf, refresh);
router.post('/logout', requireCsrf, logout);
router.post('/logout-all', requireAuth, logoutAll);

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

module.exports = router;
