'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listCustomerDirectory } = require('../controllers/companyController');

/*
 * The customer directory — the people on the customer side of an account: name,
 * email, their specific role (Owner / Team), and the company they belong to.
 *
 *   GET /customers?companyId=&search=&includeInactive=&limit=&offset=&sort=&order=
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
 * "Attached to a company" means OWNS it — `companies.owner_user_id` is the only
 * customer-to-company link in the schema today. A CUSTOMER/TEAM user has no such
 * link, so they appear in the admin's list with an empty company list and in
 * nobody else's. When team members gain a company association, this endpoint is
 * where that widens, and the response shape already has room for it.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listCustomerDirectory);

module.exports = router;
