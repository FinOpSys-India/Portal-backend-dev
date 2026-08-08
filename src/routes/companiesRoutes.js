'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { companyLimiter } = require('../middlewares/rateLimiter');
const {
  listCompanies,
  getCompany,
  updateCompany,
  deleteCompany,
  assignAccountingManager,
  removeAccountingManager,
  assignSpecialists,
  getSpecialistOptions,
  setCompanySpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
  listOwnedCompanies,
} = require('../controllers/companyController');

/*
 * Company read, update, and team management. Every route is authenticated; the
 * caller id comes from the verified access token (req.user), and per-company
 * authorization is enforced authoritatively in the service.
 *
 *   GET    /companies                                      -> companies the caller can reach
 *   GET    /companies/owned                                -> companies the caller OWNS (picker)
 *   GET    /companies/:companyId                           -> one company + primary address
 *   PATCH  /companies/:companyId                           -> correct company details
 *   DELETE /companies/:companyId                           -> archive (soft delete)
 *   PUT    /companies/:companyId/accounting-manager        -> set/replace manager (ADMIN only)
 *   DELETE /companies/:companyId/accounting-manager        -> remove manager (ADMIN only)
 *   GET    /companies/:companyId/specialist-options        -> staffing dropdowns (the
 *                                                             company's manager, or ADMIN read-only)
 *   PUT    /companies/:companyId/specialists               -> save the whole team (manager only)
 *   POST   /companies/:companyId/specialists               -> assign specialist(s) (manager only)
 *   GET    /companies/:companyId/team                      -> owner + manager + specialists
 *   GET    /companies/:companyId/specialists               -> assignments, paginated
 *   DELETE /companies/:companyId/specialists/:assignmentId -> remove one (manager only)
 *
 * Note that CREATING a company lives at POST /onboarding/company, not here — it
 * is part of the onboarding flow and carries its own OWNER gate.
 *
 * WHO MAY DO WHAT — three different answers, on purpose:
 *
 *   company details (PATCH/DELETE)  the owner, or an admin
 *   accounting manager              an ADMIN only. Who serves an account is an
 *                                   internal staffing decision, not the
 *                                   customer's.
 *   specialists                     the company's OWN accounting manager only —
 *                                   not an admin, not the owner. The admin
 *                                   appoints the manager; the manager staffs the
 *                                   account. Splitting the two means neither can
 *                                   quietly do the other's job.
 *
 * Every gate here is a coarse token-claim filter ahead of the service's
 * authoritative check — which is per-company, and is what actually decides.
 * READ routes are left to the service entirely, since it grants access more
 * broadly (owner, admin, the company's accounting manager, or an assigned
 * specialist).
 */
const router = express.Router();

router.use(requireAuth);

const canManage = requireRole('OWNER', 'ADMIN');
// Assigning an accounting manager is an internal staffing decision, not
// something a customer makes about their own account — see the service.
const adminOnly = requireRole('ADMIN');
// Staffing specialists belongs to the company's own accounting manager. The
// service narrows this further to THAT company's manager; the claim gate can
// only tell that the caller holds the role at all.
const accountingManagerOnly = requireRole('ACCOUNTING_MANAGER');
const managerOrAdminRead = requireRole('ACCOUNTING_MANAGER', 'ADMIN');

// Reads. The list is deliberately open to any authenticated caller: the service
// returns only the companies that caller can reach, so there is nothing to gate.
router.get('/', listCompanies);
// MUST stay above '/:companyId'. Express matches in declaration order, so the
// parameterised route would otherwise swallow "owned" and try to parse it as an
// id — a 400 on a perfectly valid URL.
router.get('/owned', listOwnedCompanies);
router.get('/:companyId', getCompany);
router.get('/:companyId/team', getTeam);
router.get('/:companyId/specialists', listSpecialists);
router.get('/:companyId/specialist-options', managerOrAdminRead, getSpecialistOptions);

// Writes.
router.patch('/:companyId', companyLimiter, canManage, updateCompany);
router.delete('/:companyId', companyLimiter, canManage, deleteCompany);
router.put('/:companyId/accounting-manager', companyLimiter, adminOnly, assignAccountingManager);
router.delete('/:companyId/accounting-manager', companyLimiter, adminOnly, removeAccountingManager);
router.put('/:companyId/specialists', companyLimiter, accountingManagerOnly, setCompanySpecialists);
router.post('/:companyId/specialists', companyLimiter, accountingManagerOnly, assignSpecialists);
router.delete('/:companyId/specialists/:assignmentId', companyLimiter, accountingManagerOnly, removeSpecialist);

module.exports = router;
