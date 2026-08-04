'use strict';

const config = require('../config');
const asyncHandler = require('../middlewares/asyncHandler');
const { validateSignup } = require('../validators/authValidator');
const { validateLogin } = require('../validators/loginValidator');
const { validateOtpRequest } = require('../validators/otpValidator');
const authService = require('../services/authService');
const refreshTokenService = require('../services/refreshTokenService');
const { issueCsrfToken } = require('../middlewares/csrf');

const REFRESH_COOKIE = 'refreshToken';

/** Request context passed to the service for hashing + security logging. */
function requestContext(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * Set the refresh token as a cookie rather than returning it in the body. The
 * cookie is HttpOnly (invisible to page JavaScript, so an XSS bug cannot read
 * it), Secure in production (never sent over plain HTTP), and SameSite=Lax
 * (not sent on cross-site requests). Its lifetime matches the token's.
 *
 * A CSRF token is minted alongside it, with the SAME expiry. The refresh cookie
 * is a credential the browser attaches automatically, so /auth/refresh and
 * /auth/logout need the double-submit check — and the client can only satisfy
 * that if it still holds the token to echo. Giving the two cookies different
 * lifetimes strands the session: the one that survives is useless without the
 * one that did not.
 */
function setRefreshCookie(res, { refreshToken, refreshTokenExpiresAt }) {
  const expires =
    refreshTokenExpiresAt instanceof Date ? refreshTokenExpiresAt : new Date(refreshTokenExpiresAt);

  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    expires,
  });
  return issueCsrfToken(res, expires);
}

/** Clear both cookies on logout, with the same attributes they were set with. */
function clearAuthCookies(res) {
  const base = { httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/' };
  res.clearCookie(REFRESH_COOKIE, base);
  res.clearCookie(config.security.csrfCookieName, { ...base, httpOnly: false });
}

/**
 * Read the refresh token from the cookie, falling back to the body.
 *
 * The cookie is the intended transport for a browser. The body fallback exists
 * for non-browser clients — a mobile app or a server-side integration has no
 * cookie jar, and forcing one on them would mean the only way to hold a session
 * is to emulate a browser.
 */
function readRefreshToken(req) {
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie.trim()) return fromCookie.trim();
  const fromBody = req.body?.refreshToken;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();
  return null;
}

/**
 * POST /auth/signup
 *
 * Completes an invitation: validates the token, creates the user, and returns a
 * short-lived access token plus a refresh token. The invitation token and
 * password never appear in the response — only the created user's public
 * fields and the freshly minted tokens are returned.
 */
const signup = asyncHandler(async (req, res) => {
  const input = validateSignup(req.body);
  const result = await authService.signup(input);

  // Sign-up now sets the refresh cookie too. It previously returned the raw
  // refresh token in the body and set no cookie, while login did the opposite —
  // so a client had to hold the session two different ways depending on how it
  // was created. The body copy is kept for non-browser clients.
  const csrfToken = setRefreshCookie(res, result);

  return res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    data: {
      user: result.user,
      tokens: {
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
        csrfToken,
      },
    },
  });
});

/**
 * POST /auth/login
 *
 * Step one of login. Verifies email + password and, on success, issues an
 * email-OTP challenge. The user is NOT logged in here: no token or session is
 * returned — only what the client needs to drive the OTP screen. Responds 202
 * (Accepted): the request succeeded but authentication is not yet complete.
 */
const login = asyncHandler(async (req, res) => {
  const input = validateLogin(req.body);
  const result = await authService.login({ ...input, context: requestContext(req) });

  return res.status(202).json({
    success: true,
    message: 'Enter the verification code sent to your email.',
    data: {
      otpRequired: true,
      challengeId: result.challengeId,
      maskedEmail: result.maskedEmail,
      expiresInSeconds: result.expiresInSeconds,
      resendAvailableInSeconds: result.resendAvailableInSeconds,
    },
  });
});

/**
 * POST /auth/otp
 *
 * Step two of login. One endpoint, two actions selected by `action`:
 *   - verify: check the OTP; on success complete the login and issue tokens.
 *   - resend: mint a fresh OTP for the same challenge (subject to cooldown/caps).
 */
const otp = asyncHandler(async (req, res) => {
  const input = validateOtpRequest(req.body);
  const context = requestContext(req);

  if (input.action === 'verify') {
    const result = await authService.verifyOtpChallenge({
      challengeId: input.challengeId,
      otp: input.otp,
      context,
    });
    const csrfToken = setRefreshCookie(res, result);

    return res.status(200).json({
      success: true,
      message: 'Signed in successfully.',
      data: {
        authenticated: true,
        user: result.user,
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
        csrfToken,
      },
    });
  }

  // action === 'resend'
  const result = await authService.resendOtpChallenge({
    challengeId: input.challengeId,
    context,
  });

  return res.status(200).json({
    success: true,
    message: 'A new verification code has been sent.',
    data: result,
  });
});

/**
 * POST /auth/refresh
 *
 * Exchange a refresh token for a new access token, rotating the refresh token in
 * the process. Guarded by CSRF when the token arrives in the cookie (see
 * middlewares/csrf) because a cookie is attached by the browser automatically.
 *
 * Every failure — unknown, expired, revoked, or replayed token — answers with
 * the same 401 REFRESH_TOKEN_INVALID. Distinguishing them would tell someone
 * holding a stolen token which of those it is, and the client's response is
 * identical in every case: sign in again.
 */
const refresh = asyncHandler(async (req, res) => {
  const rawToken = readRefreshToken(req);

  const result = await refreshTokenService.rotate({
    rawToken,
    context: requestContext(req),
    requestId: req.id,
  });

  const csrfToken = setRefreshCookie(res, result);

  return res.status(200).json({
    success: true,
    message: 'Session refreshed.',
    data: {
      accessToken: result.accessToken,
      expiresInSeconds: result.expiresInSeconds,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      user: result.user,
      csrfToken,
    },
  });
});

/**
 * POST /auth/logout
 *
 * End the current session: revoke its refresh-token family and clear the
 * cookies.
 *
 * Always 200, even when no valid token was presented. A logout that fails
 * because the token had already expired is useless — the client wants the
 * session gone either way — and answering differently for a real and a bogus
 * token would make this an oracle for testing stolen tokens.
 */
const logout = asyncHandler(async (req, res) => {
  const rawToken = readRefreshToken(req);
  const { revoked } = await refreshTokenService.revokeSession({ rawToken, requestId: req.id });

  clearAuthCookies(res);

  return res.status(200).json({
    success: true,
    message: 'Signed out.',
    data: { sessionsRevoked: revoked },
  });
});

/**
 * POST /auth/logout-all
 *
 * Revoke every session for the authenticated user ("sign out of all devices").
 *
 * Identity comes from the verified access token, not from the refresh cookie —
 * which is what makes this usable in the situation people actually reach for it
 * in, where the cookie may be lost or the other sessions are on other machines.
 */
const logoutAll = asyncHandler(async (req, res) => {
  const { revoked } = await refreshTokenService.revokeAllSessions({
    userId: req.user.id,
    requestId: req.id,
  });

  clearAuthCookies(res);

  return res.status(200).json({
    success: true,
    message: 'Signed out on all devices.',
    data: { sessionsRevoked: revoked },
  });
});

module.exports = { signup, login, otp, refresh, logout, logoutAll, setRefreshCookie, clearAuthCookies };
