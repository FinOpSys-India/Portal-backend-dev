'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listTeammates } = require('../controllers/companyController');

/*
 * The teammate roster — the customer-side people who belong to a company but do
 * not own it: name, email, job title, their specific role, and when they joined
 * that company.
 *
 *   GET /teammates?companyId=&search=&specificRole=&includeInactive=&limit=&offset=&sort=&order=
 *
 * A top-level route taking the global `companyId` filter, exactly like
 * GET /specialists and GET /customers, so all three directories look the same to
 * a client. It is deliberately NOT nested under /companies/:companyId: the
 * frontend carries one selected company across every screen, and a path
 * parameter would make this the one screen that reads it from somewhere else.
 *
 * `companyId` is REQUIRED here, with no admin exemption. A roster belongs to one
 * company; a merged list across several would mix people who cannot see each
 * other's accounts. The validator rejects a request without it.
 *
 * Scope, not a role gate. Any authenticated caller may ask, and the service
 * decides against the database whether they may read THAT company — the same
 * rule as every other company read: its owner, an ADMIN, its accounting manager,
 * or a specialist assigned to it. Nothing is gated here, because a coarse role
 * check could only tell that the caller holds a role somewhere, which is not the
 * question.
 *
 * Membership is read from `company_members`. The owner is linked through
 * `companies.owner_user_id` instead and so never appears in this list — the
 * result is teammates by construction, with nobody to subtract.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listTeammates);

module.exports = router;
