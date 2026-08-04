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
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
} = require('../controllers/companyController');

/*
 * Company read, update, and team management. Every route is authenticated; the
 * caller id comes from the verified access token (req.user), and per-company
 * authorization is enforced authoritatively in the service.
 *
 *   GET    /companies                                      -> companies the caller can reach
 *   GET    /companies/:companyId                           -> one company + primary address
 *   PATCH  /companies/:companyId                           -> correct company details
 *   DELETE /companies/:companyId                           -> archive (soft delete)
 *   PUT    /companies/:companyId/accounting-manager        -> set/replace manager (ADMIN only)
 *   POST   /companies/:companyId/specialists               -> assign specialist(s)
 *   GET    /companies/:companyId/team                      -> owner + manager + specialists
 *   GET    /companies/:companyId/specialists               -> assignments, paginated
 *   DELETE /companies/:companyId/specialists/:assignmentId -> remove one
 *
 * Note that CREATING a company lives at POST /onboarding/company, not here — it
 * is part of the onboarding flow and carries its own OWNER gate.
 *
 * WRITE routes carry requireRole('OWNER', 'ADMIN') as a coarse token-claim gate
 * ahead of the service's authoritative ownership check. READ routes are left to
 * the service, which grants access more broadly (owner, admin, the company's
 * accounting manager, or an assigned specialist).
 */
const router = express.Router();

router.use(requireAuth);

const canManage = requireRole('OWNER', 'ADMIN');
// Assigning an accounting manager is an internal staffing decision, not
// something a customer makes about their own account — see the service.
const adminOnly = requireRole('ADMIN');

// Reads. The list is deliberately open to any authenticated caller: the service
// returns only the companies that caller can reach, so there is nothing to gate.
router.get('/', listCompanies);
router.get('/:companyId', getCompany);
router.get('/:companyId/team', getTeam);
router.get('/:companyId/specialists', listSpecialists);

// Writes.
router.patch('/:companyId', companyLimiter, canManage, updateCompany);
router.delete('/:companyId', companyLimiter, canManage, deleteCompany);
router.put('/:companyId/accounting-manager', companyLimiter, adminOnly, assignAccountingManager);
router.post('/:companyId/specialists', companyLimiter, canManage, assignSpecialists);
router.delete('/:companyId/specialists/:assignmentId', companyLimiter, canManage, removeSpecialist);

module.exports = router;
