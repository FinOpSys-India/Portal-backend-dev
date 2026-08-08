'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const requireAuth = require('./requireAuth');
const requireRole = require('./requireRole');
const { consumeStreamTicket } = require('../services/realtimeService');

/**
 * Authentication for the admin event stream, which needs two doors because the
 * browser API that consumes it can only walk through one of them.
 *
 *   Authorization: Bearer …   the normal door. Used by anything that can set a
 *                             header — fetch + ReadableStream, a server-side
 *                             consumer, curl, the test suite.
 *   ?ticket=…                 for `new EventSource(url)`, which cannot set
 *                             headers at all. The ticket is single-use, expires
 *                             in a minute, and grants nothing but this stream —
 *                             see realtimeService for why the access token
 *                             itself must not be put in a URL.
 *
 * Either way the answer is checked against the DATABASE, not against a claim:
 * the user must exist, be ACTIVE, and hold the ADMIN role at the moment the
 * stream opens. A connection is long-lived, so this is also the moment to be
 * strict — a socket opened on a stale claim would go on receiving events for as
 * long as it stayed open.
 */
const adminOnly = requireRole('ADMIN');

/** Only what is needed to decide, plus the identity to attach to req.user. */
const STREAM_USER_SELECT = {
  id: true,
  email: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
};

function requireAdminStream(req, res, next) {
  if (req.headers.authorization) {
    // Reuse the ordinary chain verbatim rather than re-implementing it: token
    // verification, the password-rotation check, and the role gate's stale-claim
    // recovery all apply to the stream exactly as they do to every other route.
    return requireAuth(req, res, (err) => (err ? next(err) : adminOnly(req, res, next)));
  }
  return authenticateWithTicket(req, res, next);
}

async function authenticateWithTicket(req, res, next) {
  const raw = Array.isArray(req.query?.ticket) ? req.query.ticket[0] : req.query?.ticket;
  const userId = consumeStreamTicket(raw);

  if (!userId) {
    return next(
      new ApiError(401, 'A valid stream ticket is required.', { code: 'INVALID_STREAM_TICKET' })
    );
  }

  let row;
  try {
    row = await prisma.user.findUnique({ where: { id: userId }, select: STREAM_USER_SELECT });
  } catch (err) {
    logger.error(`[${req.id}] Stream ticket lookup failed: ${err.message}`);
    return next(new ApiError(503, 'The service is not ready.', { code: 'SERVICE_UNAVAILABLE' }));
  }

  if (!row) {
    return next(new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' }));
  }
  if (row.status !== 'ACTIVE') {
    return next(new ApiError(403, 'This account cannot be used.', { code: 'ACCOUNT_INACTIVE' }));
  }
  if (row.role?.code !== 'ADMIN') {
    // The ticket was minted for an admin and this user is not one any more.
    logger.warn(`[${req.id}] Stream ticket for user ${userId} redeemed after losing ADMIN; refusing.`);
    return next(
      new ApiError(403, 'You do not have permission to perform this action.', { code: 'FORBIDDEN' })
    );
  }

  req.user = {
    id: row.id,
    email: row.email,
    role: row.role.code,
    specificRole: row.specificRole?.code ?? null,
    issuedAt: null,
    _dbRole: { role: row.role.code, specificRole: row.specificRole?.code ?? null },
  };

  return next();
}

module.exports = requireAdminStream;
