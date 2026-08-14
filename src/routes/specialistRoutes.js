'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { listSpecialistDirectory, getSpecialistDetail } = require('../controllers/companyController');

/*
 * The specialist directory — who the specialists are, what they specialise in,
 * and how to reach them.
 *
 *   GET /specialists?companyId=&search=&includeInactive=&limit=&offset=&sort=&order=
 *   GET /specialists/:userId?companyId=   -> the profile behind a clicked row
 *
 * TWO ROLES, and each one gets exactly one form of the request — the service
 * decides both against the database:
 *
 *   ADMIN        every specialist, including those not yet assigned to anything.
 *                `companyId` is REFUSED: the admin roll is the whole roll, and a
 *                filter arriving on an admin token is a frontend mixing up the
 *                two screens, not a narrower question worth answering.
 *   ACCOUNTING   the specialists on ONE company — and only a company where THIS
 *   MANAGER      caller is the accounting manager. `companyId` is REQUIRED;
 *                there is no merged view across their accounts.
 *
 * Nobody else, which is why this route carries a role gate where the other
 * directories do not. Who staffs an account is the manager's working picture:
 * the owner and the assigned specialists can read the company, but the team a
 * customer is entitled to see is GET /companies/:companyId/team, which answers
 * that question without exposing the staffing view.
 *
 * The gate below is the coarse token-claim filter; the service re-checks the
 * role against the database AND narrows a manager to their own companies, so a
 * stale token or a hand-crafted request ends at the same answer.
 *
 * This is deliberately NOT /companies/:companyId/specialists, which already
 * exists and answers a different question: that one lists the ASSIGNMENT ROWS of
 * one company (with assignment status and history); this one lists PEOPLE across
 * companies, deduplicated, with their specialities folded together.
 */
const router = express.Router();

router.use(requireAuth);

const directoryRoles = requireRole('ACCOUNTING_MANAGER', 'ADMIN');

router.get('/', directoryRoles, listSpecialistDirectory);

/*
 * The profile. Same gate and same scope rule as the list — a detail endpoint
 * that authorised more loosely than the list it hangs off would be the way to
 * fetch, by id, the row the list refused to show.
 *
 * It carries the specialist's own contact detail and address plus the counters
 * for their tasks on the named company. The task TABLE is deliberately not
 * nested here: it lives at GET /tasks?companyId=&specialistUserId=, where it can
 * be paged, filtered by status and searched — none of which a nested array can
 * do, and all of which a task table needs.
 */
router.get('/:userId', directoryRoles, getSpecialistDetail);

module.exports = router;
