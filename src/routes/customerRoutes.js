'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { listCustomerDirectory, getCustomerDetail } = require('../controllers/companyController');

/*
 * The customer directory — the people on the customer side of an account: name,
 * email, their specific role (Owner / Team), and the company they belong to.
 *
 *   GET /customers?companyId=&search=&includeInactive=&limit=&offset=&sort=&order=
 *   GET /customers/:userId?companyId=   -> the profile behind a clicked row
 *
 * Scope, not a role gate — the same rule as GET /specialists, deliberately, so
 * the two directories behave identically from a client's point of view:
 *
 *   ADMIN        every customer user, with the companies each of them owns.
 *                `companyId` optional.
 *   EVERYONE     the customer users of ONE company they can read. `companyId` is
 *   ELSE         REQUIRED; without it the answer is a 400, never a merged list.
 *                An accounting manager therefore sees the customer contacts for
 *                the account they are looking at, and nothing about any other.
 *
 * "Attached to a company" means OWNS it (`companies.owner_user_id`) or is a
 * teammate on it (`company_members`). Both appear in a company-scoped list, and
 * both kinds of company appear on a row's `companies`.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listCustomerDirectory);

/*
 * The profile. NARROWER than the list above — this one is the ACCOUNTING
 * MANAGER of the named company, or an ADMIN, where the list also answers anyone
 * else who can read the company. An admin may omit `companyId` and read any
 * customer's profile; if they pass one, it scopes the lookup as it does for a
 * manager.
 *
 * The reason is what the profile carries: the customer's personal phone number
 * and their own home address, which is the manager's working material for
 * reaching the client and is nobody else's business. `companyId` is REQUIRED for
 * everyone here, because "the manager of THIS account" is the only form the rule
 * has — there is no unscoped version of the question.
 *
 * The gate below is the coarse token-claim filter; the service re-checks the
 * role against the database AND that this caller is the manager of that
 * particular company, so a stale token or a hand-crafted request ends at the
 * same answer. A customer who is not on the named company is a 404, not a 403 —
 * the profile must not become a way to confirm ids the list would not show.
 */
router.get('/:userId', requireRole('ACCOUNTING_MANAGER', 'ADMIN'), getCustomerDetail);

module.exports = router;
