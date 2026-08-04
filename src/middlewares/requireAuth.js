'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { verifyAccessToken } = require('../utils/tokens');

/**
 * Authenticate a request from its Bearer access token and expose the verified
 * identity as `req.user`. This is the ONLY source of the caller's user id and
 * email on protected routes — they are read from the signed token, never from
 * the request body or query — so a client cannot act as another user by sending
 * a different id.
 *
 * The token is the same short-lived access token minted by the sign-up and
 * login/OTP flows (see utils/tokens.signAccessToken). Any missing, malformed,
 * expired, or otherwise invalid token is a 401 with a stable code; the
 * underlying jwt error is logged with the request id but never returned.
 *
 * `req.user` also carries a lazy `resolveRole()`. The role claims baked into a
 * token are a snapshot from the moment it was signed, and onboarding changes a
 * user's role mid-session — see requireRole for why that matters and how it is
 * reconciled without adding a database read to every request.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'Authentication required.', { code: 'AUTH_REQUIRED' }));
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    logger.warn(`[${req.id}] Access token rejected: ${err.message}`);
    const expired = err.name === 'TokenExpiredError';
    return next(
      new ApiError(
        401,
        expired ? 'Your session has expired. Please sign in again.' : 'Invalid authentication token.',
        { code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN' }
      )
    );
  }

  // `sub` is set to String(userId) at signing time; anything non-numeric means a
  // token this service did not issue for a real user.
  const userId = Number(decoded.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.warn(`[${req.id}] Access token has a non-numeric subject: ${decoded.sub}`);
    return next(new ApiError(401, 'Invalid authentication token.', { code: 'INVALID_TOKEN' }));
  }

  req.user = {
    id: userId,
    email: decoded.email ?? null,
    role: decoded.role ?? null,
    specificRole: decoded.specificRole ?? null,
    // Seconds since the epoch, as jsonwebtoken writes it. Used by the
    // password-change check below.
    issuedAt: typeof decoded.iat === 'number' ? decoded.iat : null,
    // Memoised per request, so two authorization checks on one request cost at
    // most one query.
    _dbRole: undefined,
  };

  return checkPasswordRotation(req, next);
}

/**
 * Reject an access token that was issued BEFORE the user last changed their
 * password.
 *
 * Completing a password reset revokes every refresh token, but an access token
 * already in someone's hands stays cryptographically valid until it expires.
 * With no check, "reset the password to lock out whoever compromised my account"
 * did not actually lock them out — it left them a working session for the rest
 * of the token's lifetime. `users.password_changed_at` had been written for
 * exactly this purpose since the reset flow was built, and nothing read it.
 *
 * The read is skipped entirely for tokens with no `iat`, and the column is
 * usually NULL (most users have never reset), so the common path is one indexed
 * primary-key lookup returning a single nullable timestamp.
 */
async function checkPasswordRotation(req, next) {
  if (!req.user.issuedAt) return next();

  let row;
  try {
    row = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordChangedAt: true, status: true },
    });
  } catch (err) {
    // A database blip must not turn every authenticated request into a 401.
    // The token itself is already cryptographically verified; failing open on
    // this specific extra check is the lesser risk.
    logger.error(`[${req.id}] Could not verify token freshness: ${err.message}`);
    return next();
  }

  if (!row) {
    return next(new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' }));
  }

  if (row.status !== 'ACTIVE') {
    return next(new ApiError(403, 'This account cannot be used.', { code: 'ACCOUNT_INACTIVE' }));
  }

  if (row.passwordChangedAt) {
    // `iat` has one-second resolution, so a token signed in the same second as
    // the change is ambiguous. Compare against the floor of the change instant
    // and reject only tokens strictly older, so a legitimate token minted moments
    // before is not thrown away — the reset flow revokes refresh tokens anyway,
    // which bounds how long any such token survives.
    const changedAtSeconds = Math.floor(new Date(row.passwordChangedAt).getTime() / 1000);
    if (req.user.issuedAt < changedAtSeconds) {
      logger.warn(
        `[${req.id}] Access token for user ${req.user.id} predates the last password change; rejecting.`
      );
      return next(
        new ApiError(401, 'Your session has expired. Please sign in again.', {
          code: 'TOKEN_EXPIRED',
        })
      );
    }
  }

  return next();
}

module.exports = requireAuth;
