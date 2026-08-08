'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listRoles } = require('../controllers/roleController');

/*
 * The role catalog — the ids and codes the invite forms need.
 *
 *   GET /roles   every role, each with its specific roles nested
 *
 * No parameters. Four rows that change only when the seed does: the client
 * fetches this once after login, caches it, and each invite page picks its role
 * with a `find` on the code. A server-side filter would be a second way to ask
 * one question.
 *
 * WHY THIS EXISTS. POST /invitations takes `roleId` and `specificRoleId` —
 * numeric primary keys — and until now nothing returned them. Every other
 * endpoint speaks in CODES ("SPECIALIST_1"), so a frontend had exactly two
 * options: hardcode the numbers, or guess. Hardcoded ids survive right up until
 * the seed is re-run on another environment and 3 stops meaning "Payroll
 * Specialist", at which point invitations quietly grant the wrong role.
 *
 * This is the lookup that closes that gap. It serves all three admin invite
 * screens from one call:
 *
 *   Specialist page   -> the four specialist services, as a dropdown
 *   Accounting Mgr    -> the ACCOUNTING_MANAGER roleId (no specific roles)
 *   Customer page     -> OWNER / TEAM, as a dropdown
 *
 * Authenticated but not role-gated. This is reference data — the same four role
 * names already visible on every user row in the directories — and it grants
 * nothing: creating an invitation is still ADMIN-only, enforced where it matters.
 * Gating a lookup that the write endpoint's own gate already covers would only
 * mean the invite form has to handle a 403 it can do nothing about.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listRoles);

module.exports = router;
