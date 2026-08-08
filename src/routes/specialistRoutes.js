'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listSpecialistDirectory } = require('../controllers/companyController');

/*
 * The specialist directory — who the specialists are, what they specialise in,
 * and how to reach them.
 *
 *   GET /specialists?companyId=&search=&includeInactive=&limit=&offset=&sort=&order=
 *
 * NO ROLE GATE, on purpose. The gate would have to be "admin OR anyone with a
 * company", which is every authenticated user — a check that never says no is
 * not a check. What actually differs between callers is the SCOPE of the answer,
 * and scope is decided in the service against the database:
 *
 *   ADMIN        every specialist, including those not yet assigned to anything.
 *                `companyId` optional.
 *   EVERYONE     the specialists on ONE company they can read. `companyId` is
 *   ELSE         REQUIRED — there is no unscoped answer for a non-admin, and a
 *                request without it is a 400, not a merged list.
 *
 * `?companyId=` is the global company filter the frontend applies elsewhere. It
 * is authorised through the same read rule as any other company read, so it can
 * only narrow a caller's scope — never widen it. An admin who omits it gets
 * everyone, which is why the admin screens do not need the filter at all.
 *
 * This is deliberately NOT /companies/:companyId/specialists, which already
 * exists and answers a different question: that one lists the ASSIGNMENT ROWS of
 * one company (with assignment status and history); this one lists PEOPLE across
 * companies, deduplicated, with their specialities folded together.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listSpecialistDirectory);

module.exports = router;
