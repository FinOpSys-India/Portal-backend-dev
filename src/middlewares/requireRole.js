'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Role gate, layered on top of requireAuth.
 *
 * It authorizes from the signed token claims first (req.user.role /
 * req.user.specificRole), so an obviously unauthorized caller is turned away
 * before any database work.
 *
 * WHY THERE IS A DATABASE FALLBACK
 * --------------------------------
 * Token claims are a snapshot from the moment the token was signed, and this
 * application changes a user's role mid-session: POST /onboarding promotes the
 * caller to CUSTOMER/OWNER. The access token they are holding still says
 * whatever their invitation said. So the natural next call —
 * POST /onboarding/company, gated on the OWNER claim — used to return 403 while
 * GET /onboarding simultaneously reported `specificRole: "OWNER"`. Two endpoints
 * disagreeing about the same user, because one reads the token and the other
 * reads the database.
 *
 * Re-issuing the token from POST /onboarding fixes the common path (and is now
 * done), but it cannot fix every path: an admin changing someone's role, or a
 * client that holds a token minted before any such change, would hit the same
 * wall. So a claim MISS is re-checked against the database before it becomes a
 * 403. A claim HIT still short-circuits with no query, which keeps the happy
 * path free.
 *
 * This is still not the last word on authorization. Per-resource questions
 * ("does this owner own THIS company?") can only be answered against the
 * database with the resource in hand, so the services continue to perform the
 * authoritative ownership checks. This middleware filters clearly-wrong actors
 * early; it does not decide access.
 *
 *   router.put('/:id/accounting-manager', requireAuth, requireRole('OWNER', 'ADMIN'), handler);
 */
function requireRole(...allowed) {
  const set = new Set(allowed);

  return async function roleGate(req, res, next) {
    const user = req.user;
    if (!user) {
      return next(new ApiError(401, 'Authentication required.', { code: 'AUTH_REQUIRED' }));
    }

    if (matches(set, user.role, user.specificRole)) return next();

    // The claim did not match. Before refusing, ask the database — the claim may
    // simply be older than a role change.
    let current;
    try {
      current = await resolveDbRole(req);
    } catch (err) {
      logger.error(`[${req.id}] Role re-check failed: ${err.message}`);
      return next(forbidden());
    }

    if (!current) {
      return next(new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' }));
    }

    if (matches(set, current.role, current.specificRole)) {
      logger.info(
        `[${req.id}] Access token for user ${user.id} carries a stale role ` +
          `(${user.role}/${user.specificRole}); database says ${current.role}/${current.specificRole}. ` +
          'Allowing, and the client should refresh its token.'
      );
      // Let the request through with the authoritative values, so anything
      // downstream that reads req.user sees the truth rather than the snapshot.
      req.user.role = current.role;
      req.user.specificRole = current.specificRole;
      // A hint the client can act on: the token it holds is out of date.
      res.setHeader('X-Token-Stale', 'true');
      return next();
    }

    return next(forbidden());
  };
}

/**
 * `OWNER` is matched against the specific-role claim (the owner of a customer
 * account); every other code is matched against the top-level role claim.
 */
function matches(allowedSet, role, specificRole) {
  const roleOk = Boolean(role) && allowedSet.has(role);
  const ownerOk = allowedSet.has('OWNER') && specificRole === 'OWNER';
  return roleOk || ownerOk;
}

/** Read the caller's current role, memoised for the lifetime of the request. */
async function resolveDbRole(req) {
  if (req.user._dbRole !== undefined) return req.user._dbRole;

  const row = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      role: { select: { code: true } },
      specificRole: { select: { code: true } },
    },
  });

  req.user._dbRole = row
    ? { role: row.role?.code ?? null, specificRole: row.specificRole?.code ?? null }
    : null;
  return req.user._dbRole;
}

function forbidden() {
  return new ApiError(403, 'You do not have permission to perform this action.', {
    code: 'FORBIDDEN',
  });
}

module.exports = requireRole;
