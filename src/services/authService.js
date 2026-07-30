'use strict';

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { hashPassword, verifyPassword, verifyPasswordDummy } = require('../utils/password');
const { signAccessToken, generateRefreshToken } = require('../utils/tokens');
const {
  generateOtp,
  digestOtp,
  verifyOtp,
  hashContext,
  maskEmail,
} = require('../utils/otp');
const { sendOtpEmail } = require('./emailService');

const LOGIN_PURPOSE = 'LOGIN_EMAIL_OTP';

/**
 * The single generic error used for every login-credential failure — unknown
 * email, wrong password, or an account that may not log in. Returning one
 * identical response (same code, message, and status) is what stops an attacker
 * probing which emails are registered. A fresh instance per call keeps each
 * error's own request-scoped stack.
 */
function invalidCredentials() {
  return new ApiError(401, 'Invalid email or password.', { code: 'INVALID_CREDENTIALS' });
}

// Invitation statuses from which a sign-up may still proceed. Anything else
// (ACCEPTED, EXPIRED, REVOKED) is terminal and handled as a distinct error.
const ACCEPTABLE_STATUSES = ['PENDING', 'SENT'];

/** Columns safe to return to the client. Excludes passwordHash. */
const USER_PUBLIC_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  roleId: true,
  specificRoleId: true,
  status: true,
  createdAt: true,
};

/**
 * Classify why an invitation cannot be used and throw the matching error.
 * Called only once the row has been fetched, so `invitation` is either a row or
 * null. Kept separate from the happy path so each failure gets a precise,
 * caller-actionable message and status code.
 */
function assertInvitationUsable(invitation, requestEmail) {
  if (!invitation) {
    throw new ApiError(400, 'Invalid invitation token.');
  }
  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(409, 'This invitation has already been used.');
  }
  if (invitation.status === 'REVOKED') {
    throw new ApiError(410, 'This invitation has been revoked.');
  }
  if (invitation.status === 'EXPIRED' || invitation.expiresAt <= new Date()) {
    throw new ApiError(410, 'This invitation has expired.');
  }
  // The email is bound to the invitation and cannot be changed at sign-up. A
  // mismatch means the link and the submitted address disagree — reject rather
  // than silently trusting either one.
  if (invitation.email.toLowerCase() !== requestEmail) {
    throw new ApiError(400, 'The email does not match this invitation.');
  }
}

/**
 * Complete sign-up from an invitation.
 *
 * The whole mutation runs in one transaction so a user is never created without
 * the invitation being consumed, and vice versa. Single-use — including under
 * simultaneous requests — is enforced by a conditional update: the invitation
 * moves out of its acceptable state only if it is still in that state, so of
 * two racing transactions exactly one matches the row and the other sees zero
 * rows affected and is rejected.
 *
 * @returns {{ user: object, accessToken: string, refreshToken: string,
 *             refreshTokenExpiresAt: Date }}
 */
async function signup({ invitationToken, email, firstName, lastName, password }) {
  const invitation = await prisma.invitation.findUnique({
    where: { token: invitationToken },
    select: {
      id: true,
      email: true,
      roleId: true,
      specificRoleId: true,
      status: true,
      expiresAt: true,
      role: { select: { code: true } },
      specificRole: { select: { code: true } },
    },
  });

  assertInvitationUsable(invitation, email);

  // Fast, friendly pre-check. The unique constraint on users.email is the real
  // guarantee (it also catches a signup that commits between here and the
  // transaction), but this returns a clear 409 for the common case.
  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });
  if (existingUser) {
    throw new ApiError(409, 'An account with this email already exists.');
  }

  const passwordHash = await hashPassword(password);
  const refresh = generateRefreshToken();

  const user = await prisma.$transaction(async (tx) => {
    // Atomic single-use guard: only the transaction that still finds the
    // invitation in an acceptable, unexpired state gets count === 1. A racing
    // transaction blocks on this row, then re-evaluates against the now-ACCEPTED
    // row, matches nothing, and is rejected below.
    const { count } = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        status: { in: ACCEPTABLE_STATUSES },
        expiresAt: { gt: new Date() },
      },
      data: { status: 'ACCEPTED' },
    });
    if (count !== 1) {
      throw new ApiError(409, 'This invitation has already been used.');
    }

    // Email comes from the invitation (immutable); names come from the request.
    // Role and specific role are inherited from the invitation.
    const created = await tx.user.create({
      data: {
        email: invitation.email,
        firstName,
        lastName,
        passwordHash,
        roleId: invitation.roleId,
        specificRoleId: invitation.specificRoleId,
        status: 'ACTIVE',
      },
      select: USER_PUBLIC_FIELDS,
    });

    // Link the invitation to the account it created, completing the record.
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedUserId: created.id },
    });

    await tx.refreshToken.create({
      data: {
        userId: created.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    return created;
  });

  logger.info(`User ${user.id} signed up from invitation ${invitation.id}.`);

  const accessToken = signAccessToken({
    userId: user.id,
    email: user.email,
    role: invitation.role.code,
    specificRole: invitation.specificRole?.code ?? null,
  });

  return {
    user,
    accessToken,
    refreshToken: refresh.rawToken,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

/** Columns needed to authenticate. passwordHash never leaves this module. */
const USER_LOGIN_FIELDS = {
  id: true,
  email: true,
  passwordHash: true,
  status: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
};

/**
 * Step one of login: verify email + password, then — and only then — issue an
 * email-OTP challenge. Deliberately does NOT log the user in: no session, no
 * access token, no refresh token, no last_login update. All it returns is what
 * the client needs to drive the OTP screen.
 *
 * Every credential failure funnels through invalidCredentials() so the response
 * is identical whether the email is unknown, the password is wrong, or the
 * account may not log in. On the unknown-email branch a dummy hash is compared
 * so that path takes about as long as a real one.
 *
 * @param {{ email: string, password: string, context?: { ip?: string, userAgent?: string } }} params
 * @returns {{ challengeId: string, maskedEmail: string, expiresInSeconds: number,
 *             resendAvailableInSeconds: number }}
 */
async function login({ email, password, context = {} }) {
  logger.info(`Login attempt for ${maskEmail(email)}.`);

  const user = await prisma.user.findUnique({
    where: { email },
    select: USER_LOGIN_FIELDS,
  });

  if (!user) {
    // No account: still spend a comparable amount of time so timing does not
    // reveal that the email is unregistered.
    await verifyPasswordDummy(password);
    logger.warn(`Login failed (no such account) for ${maskEmail(email)}.`);
    throw invalidCredentials();
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    await registerFailedPassword(user);
    logger.warn(`Login failed (bad password) for user ${user.id}.`);
    throw invalidCredentials();
  }

  // Password is correct. An account that is locked or not ACTIVE still gets the
  // same generic error — its status is never disclosed to the caller.
  const locked = user.lockedUntil && user.lockedUntil > new Date();
  if (locked || user.status !== 'ACTIVE') {
    logger.warn(`Login blocked (status=${user.status}, locked=${Boolean(locked)}) for user ${user.id}.`);
    throw invalidCredentials();
  }

  logger.info(`Password verified for user ${user.id}; issuing OTP challenge.`);

  const otp = generateOtp();
  const challengeId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000);

  // Invalidate any previous open challenge, clear the failed-password counter,
  // and create the new challenge as one atomic unit.
  await prisma.$transaction(async (tx) => {
    await tx.loginChallenge.updateMany({
      where: { userId: user.id, purpose: LOGIN_PURPOSE, usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    await tx.loginChallenge.create({
      data: {
        id: challengeId,
        userId: user.id,
        purpose: LOGIN_PURPOSE,
        otpDigest: digestOtp(challengeId, otp),
        expiresAt,
        lastSentAt: now,
        deliveryStatus: 'QUEUED',
        requestIpHash: hashContext(context.ip),
        userAgentHash: hashContext(context.userAgent),
      },
    });
  });

  logger.info(`OTP generated for challenge ${challengeId} (user ${user.id}).`);
  await deliverOtp(challengeId, { recipientEmail: user.email, otp, requestedAt: now });

  return {
    challengeId,
    maskedEmail: maskEmail(user.email),
    expiresInSeconds: config.otp.ttlSeconds,
    resendAvailableInSeconds: config.otp.resendCooldownSeconds,
  };
}

/**
 * Record a failed password attempt and, once the threshold is reached, apply a
 * temporary lock (never a permanent one, which could be abused to lock a
 * legitimate user out). Best-effort: a failure to write the counter must not
 * change the generic error the caller ultimately receives.
 */
async function registerFailedPassword(user) {
  const attempts = user.failedLoginAttempts + 1;
  const data = { failedLoginAttempts: attempts };
  if (attempts >= config.auth.maxLoginAttempts) {
    data.lockedUntil = new Date(Date.now() + config.auth.loginLockMinutes * 60 * 1000);
    // Reset the counter alongside the lock so the account is not immediately
    // re-locked on the first attempt after the lock expires.
    data.failedLoginAttempts = 0;
  }
  try {
    await prisma.user.update({ where: { id: user.id }, data });
  } catch (err) {
    logger.error(`Failed to record login failure for user ${user.id}: ${err.message}`);
  }
}

/**
 * Send the OTP email and record delivery status on the challenge. A delivery
 * failure surfaces as a 503 OTP_DELIVERY_UNAVAILABLE with a safe message — the
 * provider's own error is logged internally, never returned.
 *
 * FUTURE — reliability: this sends inline and fails the request if the provider
 * is down. For production, move to a transactional outbox: write the challenge
 * and an "email pending" event in one transaction, commit, then let a worker
 * deliver and retry temporary failures. An automatic retry must resend the SAME
 * OTP (not generate a new one) and be idempotent so a retry can't send twice;
 * only an explicit user resend mints a new code.
 */
async function deliverOtp(challengeId, { recipientEmail, otp, requestedAt }) {
  try {
    await sendOtpEmail({
      recipientEmail,
      otp,
      expiresInMinutes: Math.round(config.otp.ttlSeconds / 60),
      requestedAt,
    });
    await markDelivery(challengeId, 'DELIVERED');
    logger.info(`OTP email queued for challenge ${challengeId}.`);
  } catch (err) {
    await markDelivery(challengeId, 'FAILED');
    logger.error(`OTP email delivery failed for challenge ${challengeId}: ${err.message}`);
    throw new ApiError(503, 'We could not send the verification code. Please try again.', {
      code: 'OTP_DELIVERY_UNAVAILABLE',
    });
  }
}

function markDelivery(challengeId, deliveryStatus) {
  return prisma.loginChallenge
    .update({ where: { id: challengeId }, data: { deliveryStatus } })
    .catch((err) => logger.error(`Could not set delivery status for ${challengeId}: ${err.message}`));
}

/** Fields of a challenge needed for verification, plus its user for token minting. */
const CHALLENGE_VERIFY_FIELDS = {
  id: true,
  userId: true,
  purpose: true,
  otpDigest: true,
  expiresAt: true,
  failedAttempts: true,
  usedAt: true,
  invalidatedAt: true,
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
 * Step two of login: verify the OTP and, on success, actually log the user in —
 * consume the challenge, mint tokens, and stamp last_login. Runs in one
 * transaction so a session is never created without the challenge being
 * consumed, and the consume itself is a conditional update, so of two racing
 * verifications exactly one succeeds.
 *
 * @param {{ challengeId: string, otp: string, context?: { ip?: string } }} params
 * @returns {{ user: object, accessToken: string, expiresInSeconds: number,
 *             refreshToken: string, refreshTokenExpiresAt: Date }}
 */
async function verifyOtpChallenge({ challengeId, otp, context = {} }) {
  return prisma.$transaction(async (tx) => {
    const challenge = await tx.loginChallenge.findUnique({
      where: { id: challengeId },
      select: CHALLENGE_VERIFY_FIELDS,
    });

    // Missing, wrong-purpose, already used, or invalidated → the request is no
    // longer valid. One conflict response covers them all.
    if (
      !challenge ||
      challenge.purpose !== LOGIN_PURPOSE ||
      challenge.usedAt ||
      challenge.invalidatedAt
    ) {
      throw challengeNotActive();
    }

    if (challenge.expiresAt <= new Date()) {
      logger.info(`OTP expired for challenge ${challengeId}.`);
      throw new ApiError(410, 'The verification code has expired. Request a new code.', {
        code: 'OTP_EXPIRED',
      });
    }

    if (challenge.failedAttempts >= config.otp.maxAttempts) {
      await invalidateChallenge(tx, challengeId);
      throw attemptLimitExceeded();
    }

    const match = verifyOtp(challengeId, otp, challenge.otpDigest);
    if (!match) {
      const attempts = challenge.failedAttempts + 1;
      const limitReached = attempts >= config.otp.maxAttempts;
      await tx.loginChallenge.update({
        where: { id: challengeId },
        data: {
          failedAttempts: { increment: 1 },
          ...(limitReached ? { invalidatedAt: new Date() } : {}),
        },
      });
      logger.warn(
        `Incorrect OTP for challenge ${challengeId} (attempt ${attempts}/${config.otp.maxAttempts}).`
      );
      if (limitReached) throw attemptLimitExceeded();
      throw new ApiError(401, 'The verification code is invalid.', { code: 'INVALID_OTP' });
    }

    // Correct code. Consume the challenge with a conditional update: only the
    // transaction that still finds it open marks it used, so a second concurrent
    // verification of the same code affects zero rows and is rejected — never
    // producing two sessions from one OTP.
    const { count } = await tx.loginChallenge.updateMany({
      where: {
        id: challengeId,
        usedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: new Date() },
        failedAttempts: { lt: config.otp.maxAttempts },
      },
      data: { usedAt: new Date() },
    });
    if (count !== 1) {
      throw challengeNotActive();
    }

    // Retire any other open challenge for this user.
    await tx.loginChallenge.updateMany({
      where: {
        userId: challenge.userId,
        purpose: LOGIN_PURPOSE,
        usedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });

    if (challenge.user.status !== 'ACTIVE') {
      // Status changed between login and verification.
      throw new ApiError(403, 'This account cannot be used for login.', {
        code: 'ACCOUNT_INACTIVE',
      });
    }

    // Clear the failed-login state and stamp the successful login.
    await tx.user.update({
      where: { id: challenge.userId },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIpHash: hashContext(context.ip),
      },
    });

    // Only now — after OTP success — are tokens issued and a session created.
    const refresh = generateRefreshToken();
    await tx.refreshToken.create({
      data: {
        userId: challenge.userId,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    const accessToken = signAccessToken({
      userId: challenge.user.id,
      email: challenge.user.email,
      role: challenge.user.role.code,
      specificRole: challenge.user.specificRole?.code ?? null,
    });

    logger.info(`Login completed for user ${challenge.userId} via challenge ${challengeId}.`);

    return {
      user: {
        id: challenge.user.id,
        email: challenge.user.email,
        role: challenge.user.role.code,
      },
      accessToken,
      expiresInSeconds: config.auth.accessTokenTtlSeconds,
      refreshToken: refresh.rawToken,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  });
}

/**
 * Resend the OTP for an existing challenge. Mints a fresh code with a new
 * five-minute expiry and immediately supersedes the old one (same challenge id),
 * so only the newest code ever verifies. Never resets the failed-attempt counter
 * and never issues a session or token.
 *
 * @param {{ challengeId: string, context?: { ip?: string } }} params
 * @returns {{ otpResent: true, expiresInSeconds: number, resendAvailableInSeconds: number }}
 */
async function resendOtpChallenge({ challengeId }) {
  const challenge = await prisma.loginChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      purpose: true,
      failedAttempts: true,
      resendCount: true,
      lastSentAt: true,
      usedAt: true,
      invalidatedAt: true,
      user: { select: { email: true } },
    },
  });

  if (
    !challenge ||
    challenge.purpose !== LOGIN_PURPOSE ||
    challenge.usedAt ||
    challenge.invalidatedAt
  ) {
    throw challengeNotActive();
  }

  // Resend must not become a way around the verification-attempt limit.
  if (challenge.failedAttempts >= config.otp.maxAttempts) {
    throw attemptLimitExceeded();
  }

  const now = new Date();
  const elapsedSeconds = (now.getTime() - challenge.lastSentAt.getTime()) / 1000;
  if (elapsedSeconds < config.otp.resendCooldownSeconds) {
    const retryAfter = Math.ceil(config.otp.resendCooldownSeconds - elapsedSeconds);
    throw new ApiError(429, 'Please wait before requesting another code.', {
      code: 'OTP_RESEND_COOLDOWN',
      headers: { 'Retry-After': String(retryAfter) },
      details: { retryAfterSeconds: retryAfter },
    });
  }

  if (challenge.resendCount >= config.otp.maxResends) {
    throw new ApiError(429, 'Too many codes requested. Please restart the login process.', {
      code: 'OTP_RESEND_LIMIT',
    });
  }

  const otp = generateOtp();
  const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000);

  // Atomic guard against a concurrent resend/verify: only one request can move
  // the row while it is still open and past its cooldown. Replacing the digest
  // here is what makes the previous OTP stop working immediately.
  const { count } = await prisma.loginChallenge.updateMany({
    where: {
      id: challengeId,
      usedAt: null,
      invalidatedAt: null,
      lastSentAt: { lte: new Date(now.getTime() - config.otp.resendCooldownSeconds * 1000) },
      resendCount: { lt: config.otp.maxResends },
      failedAttempts: { lt: config.otp.maxAttempts },
    },
    data: {
      otpDigest: digestOtp(challengeId, otp),
      expiresAt,
      lastSentAt: now,
      resendCount: { increment: 1 },
      deliveryStatus: 'QUEUED',
    },
  });
  if (count !== 1) {
    // Another resend/verify beat us to it.
    throw new ApiError(429, 'Please wait before requesting another code.', {
      code: 'OTP_RESEND_COOLDOWN',
    });
  }

  logger.info(`OTP resent for challenge ${challengeId}.`);
  await deliverOtp(challengeId, { recipientEmail: challenge.user.email, otp, requestedAt: now });

  return {
    otpResent: true,
    expiresInSeconds: config.otp.ttlSeconds,
    resendAvailableInSeconds: config.otp.resendCooldownSeconds,
  };
}

function invalidateChallenge(tx, challengeId) {
  return tx.loginChallenge.update({
    where: { id: challengeId },
    data: { invalidatedAt: new Date() },
  });
}

function challengeNotActive() {
  return new ApiError(409, 'This login verification request is no longer active.', {
    code: 'CHALLENGE_NOT_ACTIVE',
  });
}

function attemptLimitExceeded() {
  return new ApiError(429, 'Too many incorrect attempts. Please restart the login process.', {
    code: 'OTP_ATTEMPT_LIMIT_EXCEEDED',
  });
}

module.exports = { signup, login, verifyOtpChallenge, resendOtpChallenge };
