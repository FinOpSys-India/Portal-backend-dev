'use strict';

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
 * Provision the authenticated user as the OWNER of a new customer account:
 * assign the default role, create the customer, and link the user as its owner
 * (steps 2–6). Idempotent — a second call for an already-provisioned user
 * returns the existing status with 200 instead of creating another account.
 */
const provision = asyncHandler(async (req, res) => {
  const input = validateProvision(req.body);
  const { status, created } = await onboardingService.provision({
    userId: req.user.id,
    email: req.user.email,
    companyName: input.companyName,
  });

  return res.status(created ? 201 : 200).json({
    success: true,
    message: created ? 'Onboarding started.' : 'Account already provisioned.',
    data: status,
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
