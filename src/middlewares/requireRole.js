'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Coarse role gate, layered on top of requireAuth. It authorizes from the signed
 * token claims (req.user.role / req.user.specificRole) so an obviously
 * unauthorized caller is turned away before any database work.
 *
 * This is defense-in-depth, NOT the last word: token claims can be stale, and
 * per-resource authorization (does this owner own THIS company?) can only be
 * answered against the database. So the service still performs the authoritative
 * ownership/role checks — this middleware just filters the clearly-wrong actors
 * early.
 *
 * `OWNER` is matched against the specific-role claim (the owner of a customer
 * account); every other code is matched against the top-level role claim.
 *
 *   router.put('/:id/accounting-manager', requireAuth, requireRole('OWNER', 'ADMIN'), handler);
 */
function requireRole(...allowed) {
  const set = new Set(allowed);
  return function roleGate(req, res, next) {
    const user = req.user;
    if (!user) {
      return next(new ApiError(401, 'Authentication required.', { code: 'AUTH_REQUIRED' }));
    }
    const roleOk = user.role && set.has(user.role);
    const ownerOk = set.has('OWNER') && user.specificRole === 'OWNER';
    if (roleOk || ownerOk) return next();

    return next(
      new ApiError(403, 'You do not have permission to perform this action.', {
        code: 'FORBIDDEN',
      })
    );
  };
}

module.exports = requireRole;
