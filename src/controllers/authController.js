'use strict';

const config = require('../config');
const asyncHandler = require('../middlewares/asyncHandler');
const { validateSignup } = require('../validators/authValidator');
const { validateLogin } = require('../validators/loginValidator');
const { validateOtpRequest } = require('../validators/otpValidator');
const authService = require('../services/authService');

/** Request context passed to the service for hashing + security logging. */
function requestContext(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * Set the refresh token as a cookie rather than returning it in the body. The
 * cookie is HttpOnly (invisible to page JavaScript, so an XSS bug cannot read
 * it), Secure in production (never sent over plain HTTP), and SameSite=Lax
 * (not sent on cross-site requests). Its lifetime matches the token's.
 */
function setRefreshCookie(res, { refreshToken, refreshTokenExpiresAt }) {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    expires: refreshTokenExpiresAt,
  });
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

  return res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    data: {
      user: result.user,
      tokens: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
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
    setRefreshCookie(res, result);

    return res.status(200).json({
      success: true,
      data: {
        authenticated: true,
        user: result.user,
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
      },
    });
  }

  // action === 'resend'
  const result = await authService.resendOtpChallenge({
    challengeId: input.challengeId,
    context,
  });

  return res.status(200).json({ success: true, data: result });
});

module.exports = { signup, login, otp };
