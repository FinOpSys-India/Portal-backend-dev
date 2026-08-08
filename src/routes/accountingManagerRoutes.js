'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { listManagedCompanies } = require('../controllers/companyController');

/*
 * The accounting manager's area.
 *
 *   GET /accounting-manager/companies -> the accounts this manager is
 *                                        responsible for, each with its priced
 *                                        service plans, billing period, and
 *                                        members
 *
 * Its own area rather than another entry under /admin, because it is not an
 * admin screen: an admin appoints the manager and sees the company table; the
 * manager works the accounts. Two roles, two screens, two questions — and this
 * one carries the detail the admin table deliberately does not.
 *
 * The staffing endpoints a manager also uses live with the company operations,
 * since they act on one company rather than on this collection:
 *
 *   GET /companies/:companyId/specialist-options
 *   PUT /companies/:companyId/specialists
 *
 * The route gate checks the ROLE; the service scopes the rows to the companies
 * where this user is the accounting manager, and re-checks the role against the
 * database. A manager can therefore never see another manager's accounts, and a
 * token claim alone decides nothing.
 */
const router = express.Router();

router.get('/companies', requireAuth, requireRole('ACCOUNTING_MANAGER'), listManagedCompanies);

module.exports = router;
