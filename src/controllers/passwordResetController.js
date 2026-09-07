'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validatePasswordResetRequest,
  validatePasswordResetOtp,
  validatePasswordResetConfirm,
} = require('../validators/passwordResetValidator');
const passwordResetService = require('../services/passwordResetService');

/** Request context passed to the service for hashing + security logging. */
function requestContext(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * POST /api/auth/password-reset
 *
 * Step one of the forgotten-password flow: name an address and, if it belongs to
 * an active account, receive a code by email.
 *
 * An address with no account is refused with 404 EMAIL_NOT_REGISTERED, so the
 * screen can say so plainly. An address that has an account but cannot reset
 * (INVITED, HIBERNATED) still gets the ordinary 202 with a throwaway
 * `challengeId` that verifies against nothing — status stays private even though
 * existence does not. See the note in passwordResetService.requestPasswordReset.
 */
const requestPasswordReset = asyncHandler(async (req, res) => {
  const input = validatePasswordResetRequest(req.body);
  const result = await passwordResetService.requestPasswordReset({
    ...input,
    context: requestContext(req),
  });

  return res.status(202).json({
    success: true,
    message: 'A verification code has been sent to your email address.',
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
 * POST /api/auth/password-reset/otp
 *
 * Step two. One endpoint, two actions selected by `action` — the same shape as
 * the login OTP endpoint, so the client can drive both screens identically:
 *   - verify: check the code; on success return the single-use reset token that
 *     authorises the confirm step.
 *   - resend: mint a fresh code for the same challenge (subject to cooldown/caps).
 *
 * Note what is NOT returned on success: no access token, no refresh token, no
 * user object. Verifying a reset code proves control of the mailbox and buys
 * exactly one thing — permission to set a new password.
 */
const passwordResetOtp = asyncHandler(async (req, res) => {
  const input = validatePasswordResetOtp(req.body);
  const context = requestContext(req);

  if (input.action === 'verify') {
    const result = await passwordResetService.verifyPasswordResetOtp({
      challengeId: input.challengeId,
      otp: input.otp,
      context,
    });

    return res.status(200).json({
      success: true,
      data: {
        otpVerified: true,
        resetToken: result.resetToken,
        expiresInSeconds: result.expiresInSeconds,
        maskedEmail: result.maskedEmail,
      },
    });
  }

  // action === 'resend'
  const result = await passwordResetService.resendPasswordResetOtp({
    challengeId: input.challengeId,
    context,
  });

  return res.status(200).json({ success: true, data: result });
});

/**
 * POST /api/auth/password-reset/confirm
 *
 * Step three: redeem the reset token and store the new password. Every existing
 * session is revoked as part of the same change, so the user (and anyone else
 * holding a token for the account) must sign in again.
 *
 * The response deliberately does not log the user in — they are sent back to the
 * normal password + OTP login. `sessionsRevoked` is returned so the client can
 * say "you have been signed out on N devices" rather than guessing.
 */
const confirmPasswordReset = asyncHandler(async (req, res) => {
  const input = validatePasswordResetConfirm(req.body);
  const result = await passwordResetService.completePasswordReset({
    ...input,
    context: requestContext(req),
  });

  return res.status(200).json({
    success: true,
    message: 'Your password has been updated. Please sign in with your new password.',
    data: {
      passwordUpdated: result.passwordUpdated,
      sessionsRevoked: result.sessionsRevoked,
    },
  });
});

module.exports = { requestPasswordReset, passwordResetOtp, confirmPasswordReset };
