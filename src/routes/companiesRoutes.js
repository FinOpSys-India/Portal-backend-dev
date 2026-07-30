'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { companyLimiter } = require('../middlewares/rateLimiter');
const {
  assignAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
} = require('../controllers/companyController');

/*
 * Company team management. Every route is authenticated; the caller id comes from
 * the verified access token (req.user), and per-company authorization (does the
 * caller own this company?) is enforced authoritatively in the service.
 *
 *   PUT    /companies/:companyId/accounting-manager      -> set/replace manager
 *   POST   /companies/:companyId/specialists             -> assign specialist(s)
 *   GET    /companies/:companyId/team                    -> owner + manager + specialists
 *   GET    /companies/:companyId/specialists             -> active assignments
 *   DELETE /companies/:companyId/specialists/:assignmentId -> remove one
 *
 * WRITE routes carry requireRole('OWNER', 'ADMIN') as a coarse token-claim gate
 * ahead of the service's authoritative ownership check. READ routes are left to
 * the service, which grants access more broadly (owner, admin, the company's
 * accounting manager, or an assigned specialist).
 */
const router = express.Router();

router.use(requireAuth);

const canManage = requireRole('OWNER', 'ADMIN');

router.put('/:companyId/accounting-manager', companyLimiter, canManage, assignAccountingManager);
router.post('/:companyId/specialists', companyLimiter, canManage, assignSpecialists);
router.delete('/:companyId/specialists/:assignmentId', companyLimiter, canManage, removeSpecialist);

router.get('/:companyId/team', getTeam);
router.get('/:companyId/specialists', listSpecialists);

module.exports = router;
