'use strict';

const config = require('../config');
const asyncHandler = require('../middlewares/asyncHandler');
const { validateProfile, validateProvision } = require('../validators/onboardingValidator');
const onboardingService = require('../services/onboardingService');

/**
 * GET /onboarding
 *
 * Return the caller's current onboarding status so the frontend can decide which
 * step to show (or move the user into the app). Identity comes from the verified
 * access token via req.user — never from the request.
 */
const getStatus = asyncHandler(async (req, res) => {
  const status = await onboardingService.getStatus(req.user.id);
  return res.status(200).json({ success: true, data: status });
});

/**
 * POST /onboarding
 *
 * Provision the authenticated user as an OWNER by assigning the default role
 * pair. Idempotent — a second call for an already-provisioned user returns the
 * existing status with 200.
 */
const provision = asyncHandler(async (req, res) => {
  validateProvision(req.body);
  const { status, created, accessToken } = await onboardingService.provision({
    userId: req.user.id,
  });

  /*
   * `accessToken` is present only when this call changed the caller's role — it
   * promotes them to CUSTOMER/OWNER, and the token they are holding was signed
   * before that. The next step of the flow (POST /onboarding/company) is gated
   * on the OWNER claim, so a client that ignores this and keeps its old token is
   * relying on requireRole's database fallback. Swapping it in is the correct
   * move; the fallback is the safety net, not the plan.
   */
  return res.status(created ? 201 : 200).json({
    success: true,
    message: created ? 'Onboarding started.' : 'Account already provisioned.',
    data: {
      ...status,
      ...(accessToken
        ? { tokens: { accessToken, expiresInSeconds: config.auth.accessTokenTtlSeconds } }
        : {}),
    },
  });
});

/**
 * PUT /onboarding/profile
 *
 * Submit the onboarding form: first name, last name, phone, job title (step 7).
 * The email and user id are taken from the token, so the body carries only
 * profile fields.
 */
const submitProfile = asyncHandler(async (req, res) => {
  const profile = validateProfile(req.body);
  const status = await onboardingService.submitProfile({ userId: req.user.id, profile });

  return res.status(200).json({
    success: true,
    message: 'Profile saved.',
    data: status,
  });
});

module.exports = { getStatus, provision, submitProfile };
