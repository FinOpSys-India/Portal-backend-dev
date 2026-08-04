'use strict';

const express = require('express');

const { prisma } = require('../config/prisma');
const invitationRoutes = require('./invitationRoutes');
const authRoutes = require('./authRoutes');
const onboardingRoutes = require('./onboardingRoutes');
const companiesRoutes = require('./companiesRoutes');
const userRoutes = require('./userRoutes');
const billingRoutes = require('./billingRoutes');

/**
 * API route aggregator. Mount feature routers here.
 */
const router = express.Router();

/**
 * GET /health — readiness, not just liveness.
 *
 * The root `GET /` returns a static string without touching anything, so it
 * reports healthy on a process whose database is unreachable — which is exactly
 * the state a load balancer most needs to detect. This one actually round-trips
 * a query.
 *
 * Unauthenticated on purpose (a probe holds no token) and deliberately terse: it
 * reports reachability and nothing about versions, hosts, or configuration.
 */
router.get('/health', async (req, res) => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      success: true,
      message: 'Healthy.',
      data: { status: 'ok', database: 'up', latencyMs: Date.now() - startedAt },
    });
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is not ready.',
        requestId: req.id,
        details: { database: 'down' },
      },
    });
  }
});

router.use('/auth', authRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/companies', companiesRoutes);
router.use('/users', userRoutes);
router.use('/invitations', invitationRoutes);
// POST /billing/webhook is mounted in app.js instead — it needs the raw body,
// so it must sit ahead of express.json(). Everything else is authenticated here.
router.use('/billing', billingRoutes);

module.exports = router;
