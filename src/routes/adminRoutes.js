'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const requireAdminStream = require('../middlewares/requireAdminStream');
const { companyLimiter } = require('../middlewares/rateLimiter');
const { listCompanyAccounts, listAccountingManagers } = require('../controllers/companyController');
const { createStreamTicket, streamEvents } = require('../controllers/adminController');

/*
 * The Admin area.
 *
 *   GET  /admin/company-accounts     -> the company table: company, owner, active
 *                                       services, billing date, team — every
 *                                       company, plus the eligible accounting
 *                                       managers for the assign control
 *   GET  /admin/accounting-managers -> the same staffing picture read the other
 *                                      way round: one row per manager, with the
 *                                      companies on their book nested inside
 *   POST /admin/events/ticket        -> short-lived ticket for EventSource
 *   GET  /admin/events               -> Server-Sent Events for the admin screens
 *
 * Two families of write are deliberately NOT here.
 *
 * The accounting-manager writes already exist as company operations and are
 * already ADMIN-only:
 *
 *   PUT    /companies/:companyId/accounting-manager   assign or replace
 *   DELETE /companies/:companyId/accounting-manager   remove
 *
 * Giving them a second URL under /admin would mean two paths to one write, and
 * the day one of them grows a check the other lacks is the day the gate stops
 * meaning anything.
 *
 * The SPECIALIST staffing endpoints are not here because they are not an admin
 * function at all — the company's own accounting manager staffs their accounts,
 * and an admin cannot. They live with the rest of the company team operations:
 *
 *   GET /companies/:companyId/specialist-options   the dropdowns
 *   PUT /companies/:companyId/specialists          save the team
 *
 * A THIRD screen is not here either: the accounting manager's own accounts, in
 * more detail than this table carries, live at GET /accounting-manager/companies.
 * An admin appoints the manager; the manager works the accounts. Different
 * roles, different questions, different endpoints.
 *
 * Every route below is admin-only. The gate here turns away obvious cases before
 * any database work; the SERVICE
 * re-checks the caller's role against the database and is what actually decides,
 * so a stale token, a bypassed frontend route, or a request crafted by hand all
 * end at the same answer.
 */
const router = express.Router();

const adminOnly = requireRole('ADMIN');

/*
 * ADMIN only. This is the appointment screen: every company, one row each, with
 * the eligible accounting managers for the assign control. A manager's own view
 * of their accounts is GET /accounting-manager/companies, which carries the
 * detail this deliberately does not.
 */
router.get('/company-accounts', requireAuth, adminOnly, listCompanyAccounts);

/*
 * ADMIN only. The staffing report: who the accounting managers are, and what
 * each of them carries.
 *
 * It is the inverse of the table above, and it is a separate endpoint rather
 * than a `?groupBy=manager` on that one because the two return genuinely
 * different rows — companies there, people here — and an endpoint whose response
 * shape changes with a query parameter is two endpoints wearing one name.
 *
 * Read-only. Moving a company between managers stays where it already lives:
 * PUT /companies/:companyId/accounting-manager.
 */
router.get('/accounting-managers', requireAuth, adminOnly, listAccountingManagers);

// Minting a ticket is cheap but it is a credential; hold it to the same per-IP
// cap as the other authenticated writes.
router.post('/events/ticket', requireAuth, adminOnly, companyLimiter, createStreamTicket);

/*
 * The stream carries its own authentication (bearer header OR ticket), so it
 * does not sit behind requireAuth. It is also NOT rate limited: a limiter counts
 * requests, a stream is one request that lasts for hours, and the reconnect
 * storm a limiter would guard against is already bounded by the `retry` interval
 * the server itself dictates.
 */
router.get('/events', requireAdminStream, streamEvents);

module.exports = router;
