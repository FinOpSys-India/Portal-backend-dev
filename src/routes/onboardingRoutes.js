'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { onboardingLimiter, companyLimiter } = require('../middlewares/rateLimiter');
const { getStatus, provision, submitProfile } = require('../controllers/onboardingController');
const { onboardCompany } = require('../controllers/companyController');

/*
 * Post-signup onboarding. Every route is authenticated: the user id and email
 * are read from the verified access token (req.user), never from the request
 * body, so a client can only ever onboard itself.
 *
 *   GET  /onboarding          -> current onboarding status
 *   POST /onboarding          -> provision the user as OWNER of a new customer
 *                                account (idempotent)
 *   PUT  /onboarding/profile  -> submit the onboarding form
 *   POST /onboarding/company  -> onboard a new company owned by the caller
 *                                (idempotent via Idempotency-Key)
 *
 * requireAuth guards the whole router; the limiter is added only to the writing
 * routes (the status read is cheap and safe to poll). Company onboarding is
 * additionally gated by requireRole('OWNER') as coarse defense-in-depth — the
 * service re-verifies the OWNER role against the database.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', getStatus);
router.post('/', onboardingLimiter, provision);
router.put('/profile', onboardingLimiter, submitProfile);
router.post('/company', companyLimiter, requireRole('OWNER'), onboardCompany);

module.exports = router;
