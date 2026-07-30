'use strict';

const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { verifyAccessToken } = require('../utils/tokens');

/**
 * Authenticate a request from its Bearer access token and expose the verified
 * identity as `req.user`. This is the ONLY source of the caller's user id and
 * email on protected routes — they are read from the signed token, never from
 * the request body or query — so a client cannot act as another user by sending
 * a different id. Routes that need the caller's identity must sit behind this.
 *
 * The token is the same short-lived access token minted by the sign-up and
 * login/OTP flows (see utils/tokens.signAccessToken). Any missing, malformed,
 * expired, or otherwise invalid token is a 401 with a stable code; the
 * underlying jwt error is logged with the request id but never returned.
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
  };
  return next();
}

module.exports = requireAuth;
