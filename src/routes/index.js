'use strict';

const express = require('express');

const invitationRoutes = require('./invitationRoutes');
const authRoutes = require('./authRoutes');
const onboardingRoutes = require('./onboardingRoutes');
const companiesRoutes = require('./companiesRoutes');
const billingRoutes = require('./billingRoutes');

/**
 * API route aggregator. Mount feature routers here, e.g.:
 *   router.use('/users', require('./userRoutes'));
 */
const router = express.Router();

router.use('/auth', authRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/companies', companiesRoutes);
router.use('/invitations', invitationRoutes);
// POST /billing/webhook is mounted in app.js instead — it needs the raw body,
// so it must sit ahead of express.json(). Everything else is authenticated here.
router.use('/billing', billingRoutes);

module.exports = router;
