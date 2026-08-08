'use strict';

const { prisma } = require('../config/prisma');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} = require('../utils/tokens');
const { hashContext } = require('../utils/otp');

/**
 * Refresh-token lifecycle: issue, rotate, revoke.
 *
 * Until now tokens were minted at login and stored, and then nothing ever
 * consumed them — there was no /auth/refresh and no /auth/logout. The practical
 * consequences were that a user was hard-logged-out the moment their access
 * token expired with no way back, and that "sign out" could only clear client
 * state while the server-side session stayed valid. The access-token TTL had
 * been widened to over ten hours to make the first problem tolerable, which made
 * the second one worse.
 *
 * THE ROTATION RULE
 * -----------------
 * Every refresh is single-use. Presenting a token revokes it and returns a new
 * one in the same family. The client is expected to discard the old value
 * immediately, so the old value should never be seen again.
 *
 * THE REUSE RULE
 * --------------
 * If a token that has ALREADY been rotated is presented, a copy is in
 * circulation — either the legitimate client replayed it (a bug, or a lost race
 * between two tabs) or someone stole it. We cannot tell which, and that is
 * precisely why the response has to be severe: revoke the entire family. If it
 * was a theft, the attacker is cut off and so is the victim, who logs in again.
 * If it was a bug, the user logs in again. Keeping the session alive to be
 * convenient in the second case would mean keeping it alive for the attacker in
 * the first.
 */

const REVOKED_REASON = {
  ROTATED: 'rotated',
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  REUSE_DETECTED: 'reuse_detected',
  PASSWORD_RESET: 'password_reset',
};

/** One generic error for every refresh failure. */
function invalidRefreshToken() {
  return new ApiError(401, 'Your session has expired. Please sign in again.', {
    code: 'REFRESH_TOKEN_INVALID',
  });
}

/** Fields needed to validate a presented token and mint its successor. */
const TOKEN_SELECT = {
  id: true,
  userId: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
  replacedById: true,
  user: {
    select: {
      id: true,
      email: true,
      status: true,
      role: { select: { code: true } },
      specificRole: { select: { code: true } },
    },
  },
};

/**
 * Persist a freshly minted refresh token. Used by sign-up, OTP verification, and
 * rotation, so every token in the system is created the same way.
 *
 * @param {object} tx      Prisma client or transaction client.
 * @param {object} params
 * @returns {Promise<object>} the created row
 */
function persistRefreshToken(tx, { userId, refresh, context = {}, replacesId = null }) {
  return tx.refreshToken.create({
    data: {
      userId,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      familyId: refresh.familyId,
      createdIpHash: hashContext(context.ip),
      userAgentHash: hashContext(context.userAgent),
      ...(replacesId ? {} : {}),
    },
  });
}

/**
 * Revoke every unrevoked token in a family.
 *
 * The family-wide sweep is what makes reuse detection meaningful: revoking only
 * the replayed row would leave the successor the attacker (or the victim) is
 * already holding perfectly usable.
 */
async function revokeFamily(tx, { familyId, reason, exceptId = null }) {
  if (!familyId) return 0;
  const { count } = await tx.refreshToken.updateMany({
    where: {
      familyId,
      revokedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

/**
 * Exchange a refresh token for a new access token and a rotated refresh token.
 *
 * @param {{ rawToken: string, context?: object, requestId?: string }} params
 * @returns {Promise<{ accessToken, expiresInSeconds, refreshToken, refreshTokenExpiresAt, user }>}
 */
async function rotate({ rawToken, context = {}, requestId }) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    throw invalidRefreshToken();
  }

  const tokenHash = hashRefreshToken(rawToken.trim());

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: TOKEN_SELECT,
  });

  // An unknown hash is either a forgery or a token from a database that has been
  // reset. Neither is actionable by the client beyond "log in again".
  if (!existing) {
    logger.warn(`[${requestId}] Refresh rejected: unknown token.`);
    throw invalidRefreshToken();
  }

  /*
   * REUSE DETECTION. `replacedById` is set only by a previous successful
   * rotation, so a token carrying one has definitely been redeemed already. The
   * legitimate client discarded it at that moment, which means this presentation
   * came from a copy.
   */
  if (existing.replacedById) {
    const revoked = await revokeFamily(prisma, {
      familyId: existing.familyId,
      reason: REVOKED_REASON.REUSE_DETECTED,
    });
    logger.error(
      `[${requestId}] Refresh token REUSE detected for user ${existing.userId}; ` +
        `revoked ${revoked} token(s) in family ${existing.familyId}.`
    );
    logEvent({
      event: 'auth.refresh.reuse_detected',
      status: 'error',
      requestId,
      userId: existing.userId,
      errorCode: 'REFRESH_TOKEN_REUSED',
      detail: `family_revoked:${revoked}`,
    });
    throw invalidRefreshToken();
  }

  if (existing.revokedAt) {
    logger.warn(`[${requestId}] Refresh rejected: token already revoked (user ${existing.userId}).`);
    throw invalidRefreshToken();
  }

  if (existing.expiresAt <= new Date()) {
    logger.info(`[${requestId}] Refresh rejected: token expired (user ${existing.userId}).`);
    throw invalidRefreshToken();
  }

  // The account may have been hibernated since the token was issued.
  if (existing.user.status !== 'ACTIVE') {
    await revokeFamily(prisma, { familyId: existing.familyId, reason: REVOKED_REASON.LOGOUT_ALL });
    throw new ApiError(403, 'This account cannot be used for login.', { code: 'ACCOUNT_INACTIVE' });
  }

  const refresh = generateRefreshToken({ familyId: existing.familyId });

  /*
   * Rotate inside one transaction, guarded by a conditional update. Two tabs
   * refreshing simultaneously both hold the same valid token; without the guard
   * both would rotate it and the loser's successor would be orphaned, and the
   * next request from that tab would look exactly like a reuse. The conditional
   * update means precisely one wins, and the loser gets the ordinary "log in
   * again" rather than tripping the family revoke.
   */
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null, replacedById: null },
      data: { revokedAt: new Date(), revokedReason: REVOKED_REASON.ROTATED, lastUsedAt: new Date() },
    });
    if (count !== 1) {
      // Another request rotated it between our read and this write.
      throw invalidRefreshToken();
    }

    const created = await persistRefreshToken(tx, {
      userId: existing.userId,
      refresh,
      context,
    });

    // Link old -> new. This is what a later replay of the old token reads to
    // recognise itself as spent.
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { replacedById: created.id },
    });

    return created;
  });

  const accessToken = signAccessToken({
    userId: existing.user.id,
    email: existing.user.email,
    role: existing.user.role?.code ?? null,
    specificRole: existing.user.specificRole?.code ?? null,
  });

  logEvent({
    event: 'auth.refresh.rotated',
    status: 'success',
    requestId,
    userId: existing.userId,
  });

  return {
    accessToken,
    expiresInSeconds: config.auth.accessTokenTtlSeconds,
    refreshToken: refresh.rawToken,
    refreshTokenExpiresAt: refresh.expiresAt,
    refreshTokenId: result.id,
    user: {
      id: existing.user.id,
      email: existing.user.email,
      role: existing.user.role?.code ?? null,
      specificRole: existing.user.specificRole?.code ?? null,
      status: existing.user.status,
    },
  };
}

/**
 * Revoke the presented session (logout).
 *
 * Revokes the whole FAMILY, not just the presented row: the family is the
 * session, and leaving its other tokens alive would mean "log out" did not.
 *
 * Deliberately idempotent and non-committal about what it found. A logout that
 * 401s on an already-expired token is useless — the client wants to end the
 * session either way — and reporting whether the token was real turns the
 * endpoint into an oracle for guessing valid tokens.
 */
async function revokeSession({ rawToken, requestId }) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    return { revoked: 0 };
  }

  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken.trim()) },
    select: { id: true, userId: true, familyId: true },
  });
  if (!token) return { revoked: 0 };

  const revoked = await revokeFamily(prisma, {
    familyId: token.familyId,
    reason: REVOKED_REASON.LOGOUT,
  });

  logEvent({
    event: 'auth.logout',
    status: 'success',
    requestId,
    userId: token.userId,
    detail: `revoked:${revoked}`,
  });

  return { revoked, userId: token.userId };
}

/**
 * Revoke every session for a user ("sign out of all devices").
 *
 * Identity comes from the verified access token, never from the refresh cookie,
 * so this works even if the cookie was lost — which is exactly the situation
 * someone reaching for "sign out everywhere" is usually in.
 */
async function revokeAllSessions({ userId, requestId, reason = REVOKED_REASON.LOGOUT_ALL }) {
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  logEvent({
    event: 'auth.logout_all',
    status: 'success',
    requestId,
    userId,
    detail: `revoked:${count}`,
  });

  return { revoked: count };
}

module.exports = {
  rotate,
  revokeSession,
  revokeAllSessions,
  revokeFamily,
  persistRefreshToken,
  REVOKED_REASON,
};
