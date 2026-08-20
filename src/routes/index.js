'use strict';

const express = require('express');

const config = require('../config');
const { prisma } = require('../config/prisma');
const requireAuth = require('../middlewares/requireAuth');
const requirePaidAccount = require('../middlewares/requirePaidAccount');
const invitationRoutes = require('./invitationRoutes');
const authRoutes = require('./authRoutes');
const onboardingRoutes = require('./onboardingRoutes');
const companiesRoutes = require('./companiesRoutes');
const userRoutes = require('./userRoutes');
const specialistRoutes = require('./specialistRoutes');
const customerRoutes = require('./customerRoutes');
const teammateRoutes = require('./teammateRoutes');
const roleRoutes = require('./roleRoutes');
const adminRoutes = require('./adminRoutes');
const accountingManagerRoutes = require('./accountingManagerRoutes');
const projectRoutes = require('./projectRoutes');
const documentRoutes = require('./documentRoutes');
const taskRoutes = require('./taskRoutes');
const emailRoutes = require('./emailRoutes');
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
 *
 * `storage` IS reported, and it is the one exception to that rule — for a reason
 * worth stating, because it looks like configuration and configuration does not
 * belong in an unauthenticated response.
 *
 * What it reports is a READINESS FACT, not a setting: "supabase" means documents
 * will work, "local" means every upload and download will fail on a serverless
 * host, because there is no durable disk there. That failure is otherwise
 * invisible until a user tries to open a file and gets a 503 — the credentials
 * are absent, the driver quietly falls back, and nothing says so. This makes it
 * one request to check, before anyone notices the hard way.
 *
 * It leaks nothing: the answer is one of two words. Not the project URL, not the
 * bucket names, and certainly not the key — only whether this deployment is
 * wired up.
 */
router.get('/health', async (req, res) => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      success: true,
      message: 'Healthy.',
      data: {
        status: 'ok',
        database: 'up',
        storage: config.storage.driver,
        latencyMs: Date.now() - startedAt,
      },
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
// The specialist directory, scoped to the caller: every specialist for an admin,
// and for everyone else only those on companies they can reach.
router.use('/specialists', specialistRoutes);
// The customer-side people directory, scoped the same way: everyone for an
// admin, one company's customers for anyone else.
router.use('/customers', customerRoutes);
// One company's teammate roster, named with the same global ?companyId= filter.
// Gated: managing a roster is account work, and an unpaid account has none.
router.use('/teammates', requireAuth, requirePaidAccount, teammateRoutes);
// The role catalog the invite forms read their roleId/specificRoleId from.
router.use('/roles', roleRoutes);
// Admin-only company account management + its real-time channel.
router.use('/admin', adminRoutes);
// The accounting manager's own accounts, in more detail than the admin table.
router.use('/accounting-manager', accountingManagerRoutes);
/*
 * THE PAYWALL. An owner with an unpaid company reaches nothing below this line.
 *
 * requireAuth runs first because requirePaidAccount needs a verified req.user to
 * ask about; the feature routers install it again themselves, which is harmless
 * (a second verification of the same token) and keeps each router standalone.
 *
 * Only these three are gated. /billing, /onboarding, /companies and /users are
 * deliberately left open — they are exactly what an unpaid owner needs in order
 * to stop being one.
 */
// Projects, always scoped to one company by ?companyId= — the table, the form's
// service list, and the specialist auto-assignment.
router.use('/projects', requireAuth, requirePaidAccount, projectRoutes);
// Every file on a company, across its projects. Gated with /projects, since it
// reads the same records through a different door.
router.use('/documents', requireAuth, requirePaidAccount, documentRoutes);
// The task board: every task on a company, and the writes the assigned
// specialist performs on them. Gated with /projects for the same reason
// /documents is — it reads and writes the same work through a different door.
router.use('/tasks', requireAuth, requirePaidAccount, taskRoutes);
// The compose-and-send email screen, plus the recipient picker it is built from.
// Gated with /projects and /documents for the same reason: writing to a client
// is account work, and an unpaid account has no client to write to. The picker
// is behind the paywall too, deliberately — an ungated directory of a company's
// people would be the one way to read its roster without paying for it.
router.use('/emails', requireAuth, requirePaidAccount, emailRoutes);
router.use('/invitations', requireAuth, requirePaidAccount, invitationRoutes);
// POST /billing/webhook is mounted in app.js instead — it needs the raw body,
// so it must sit ahead of express.json(). Everything else is authenticated here.
router.use('/billing', billingRoutes);

module.exports = router;
