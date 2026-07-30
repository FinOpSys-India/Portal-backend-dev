'use strict';

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { hashPassword, verifyPassword } = require('../utils/password');
const { generatePasswordResetToken, hashPasswordResetToken } = require('../utils/tokens');
const { generateOtp, digestOtp, verifyOtp, hashContext, maskEmail } = require('../utils/otp');
const { sendPasswordResetOtpEmail, sendPasswordChangedEmail } = require('./emailService');

/*
 * Forgotten-password flow, in three requests:
 *
 *   1. request  — POST /auth/password-reset          { email }
 *      Look the address up. If it belongs to an active account, mint a
 *      PASSWORD_RESET_EMAIL_OTP challenge and email the code.
 *
 *   2. verify   — POST /auth/password-reset/otp      { action: 'verify', challengeId, otp }
 *      Check the code. On success consume the challenge and mint a single-use,
 *      short-lived reset ticket. (action: 'resend' re-sends the code instead.)
 *
 *   3. confirm  — POST /auth/password-reset/confirm  { resetToken, password }
 *      Redeem the ticket, write the new hash, and revoke every existing session.
 *
 * The ticket in step 2 is the load-bearing part. Without it, step 3 would have
 * to trust a client-supplied user id or re-accept the OTP, and "I verified the
 * code" would be a claim the client makes rather than one the server proved.
 *
 * NOT DONE HERE — deliberately: no step of this flow ever logs the user in. A
 * completed reset returns no access token, no refresh token and no session; the
 * user signs in afterwards through the normal password + OTP path. Recovering an
 * account and authenticating are separate acts, and folding them together would
 * turn one compromised mailbox into an immediate live session.
 */

const RESET_PURPOSE = 'PASSWORD_RESET_EMAIL_OTP';

/** Statuses from which a password may be reset. */
function canResetPassword(user) {
  // ACTIVE only. An INVITED user has no password to reset — they must finish the
  // invitation, which sets one. HIBERNATED accounts are intentionally out of
  // service, and letting one reset its way back in would route around whatever
  // decision hibernated it.
  return Boolean(user) && user.status === 'ACTIVE';
}

/**
 * Step one. Send a reset code to the address, if it belongs to an account that
 * can use one.
 *
 * The response is identical whether or not the email is registered: same status,
 * same body shape, same challenge id (a throwaway one for the miss). That is the
 * point — a forgotten-password endpoint is unauthenticated and takes an
 * arbitrary address, so any observable difference between hit and miss turns it
 * into a free "does this person have an account here?" oracle. The same reasoning
 * already governs login, which answers INVALID_CREDENTIALS to an unknown email
 * and a wrong password alike.
 *
 * The consequence to keep in mind when reading the code below: this function must
 * not throw on any account-specific condition. A 404 for an unknown address, or a
 * 503 when the mail fails to send, would each re-open the oracle by making the
 * miss distinguishable — so a delivery failure is logged and recorded on the
 * challenge, not raised.
 *
 * RESIDUAL, accepted: the hit path does database writes and an SMTP round trip
 * that the miss path does not, so the two differ in latency. Closing that
 * properly means making the response independent of delivery — the transactional
 * outbox already noted in authService.deliverOtp — rather than padding with a
 * sleep, which only adds a second signal to measure.
 *
 * @param {{ email: string, context?: { ip?: string, userAgent?: string } }} params
 * @returns {{ challengeId: string, maskedEmail: string, expiresInSeconds: number,
 *             resendAvailableInSeconds: number }}
 */
async function requestPasswordReset({ email, context = {} }) {
  logger.info(`Password reset requested for ${maskEmail(email)}.`);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, firstName: true, status: true },
  });

  if (!canResetPassword(user)) {
    // Logged so the miss is visible to us, at a level that makes a burst of them
    // stand out — the caller learns nothing.
    logger.warn(
      `Password reset ignored for ${maskEmail(email)} ` +
        `(${user ? `status=${user.status}` : 'no such account'}).`
    );
    return decoyChallenge(email);
  }

  const otp = generateOtp();
  const challengeId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000);

  // Retire any earlier open reset challenge and create the new one atomically, so
  // a user who clicks "forgot password" twice ends up with exactly one live code
  // rather than two that both work. Scoped to RESET_PURPOSE: an in-flight login
  // challenge is a different flow and is left alone.
  await prisma.$transaction(async (tx) => {
    await tx.loginChallenge.updateMany({
      where: { userId: user.id, purpose: RESET_PURPOSE, usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.loginChallenge.create({
      data: {
        id: challengeId,
        userId: user.id,
        purpose: RESET_PURPOSE,
        otpDigest: digestOtp(challengeId, otp),
        expiresAt,
        lastSentAt: now,
        deliveryStatus: 'QUEUED',
        requestIpHash: hashContext(context.ip),
        userAgentHash: hashContext(context.userAgent),
      },
    });
  });

  logger.info(`Reset OTP generated for challenge ${challengeId} (user ${user.id}).`);

  await deliverResetOtp(challengeId, {
    recipientEmail: user.email,
    recipientFirstName: user.firstName,
    otp,
    requestedAt: now,
    // A failure here must not distinguish this branch from the decoy one.
    throwOnFailure: false,
  });

  return {
    challengeId,
    maskedEmail: maskEmail(user.email),
    expiresInSeconds: config.otp.ttlSeconds,
    resendAvailableInSeconds: config.otp.resendCooldownSeconds,
  };
}

/**
 * The response returned for an address that has no resettable account: a random
 * challenge id that was never stored, and the submitted address masked by the
 * same function used on a real one. Nothing is written and nothing is sent.
 *
 * Presenting the caller with an id that verifies against nothing is the intended
 * behaviour — someone probing an unregistered address gets the OTP screen, enters
 * a code, and is told the request is no longer active, which is exactly what they
 * would see after letting a real challenge lapse.
 */
function decoyChallenge(email) {
  return {
    challengeId: crypto.randomUUID(),
    maskedEmail: maskEmail(email),
    expiresInSeconds: config.otp.ttlSeconds,
    resendAvailableInSeconds: config.otp.resendCooldownSeconds,
  };
}

/**
 * Send the reset OTP and record the outcome on the challenge.
 *
 * `throwOnFailure` is false for the initial request (see requestPasswordReset:
 * raising there would leak whether the account exists) and true for a resend,
 * where the caller already holds a real challenge id — the account's existence
 * is not in question by then, so a mail outage may as well be reported honestly.
 * Either way the provider's own error is logged internally and never returned.
 */
async function deliverResetOtp(
  challengeId,
  { recipientEmail, recipientFirstName, otp, requestedAt, throwOnFailure }
) {
  try {
    await sendPasswordResetOtpEmail({
      recipientEmail,
      recipientFirstName,
      otp,
      expiresInMinutes: Math.round(config.otp.ttlSeconds / 60),
      requestedAt,
    });
    await markDelivery(challengeId, 'DELIVERED');
    logger.info(`Reset OTP email queued for challenge ${challengeId}.`);
  } catch (err) {
    await markDelivery(challengeId, 'FAILED');
    logger.error(`Reset OTP delivery failed for challenge ${challengeId}: ${err.message}`);
    if (throwOnFailure) {
      throw new ApiError(503, 'We could not send the verification code. Please try again.', {
        code: 'OTP_DELIVERY_UNAVAILABLE',
      });
    }
    // Swallowed on purpose. The row carries deliveryStatus=FAILED and the error
    // is logged, so the outage is visible to us; the user sees the normal "if an
    // account exists, we sent a code" response and can retry with resend.
  }
}

function markDelivery(challengeId, deliveryStatus) {
  return prisma.loginChallenge
    .update({ where: { id: challengeId }, data: { deliveryStatus } })
    .catch((err) =>
      logger.error(`Could not set delivery status for ${challengeId}: ${err.message}`)
    );
}

/** Fields of a reset challenge needed for verification, plus its user. */
const CHALLENGE_VERIFY_FIELDS = {
  id: true,
  userId: true,
  purpose: true,
  otpDigest: true,
  expiresAt: true,
  failedAttempts: true,
  usedAt: true,
  invalidatedAt: true,
  user: { select: { id: true, email: true, status: true } },
};

/**
 * Step two. Verify the reset code and, on success, mint the ticket that permits
 * setting a new password.
 *
 * Runs in one transaction so a ticket is never created without the challenge
 * being consumed. The consume is a conditional update, so of two racing
 * verifications of the same code exactly one matches the row — one OTP can never
 * yield two tickets.
 *
 * @param {{ challengeId: string, otp: string, context?: { ip?: string, userAgent?: string } }} params
 * @returns {{ resetToken: string, expiresInSeconds: number, maskedEmail: string }}
 */
async function verifyPasswordResetOtp({ challengeId, otp, context = {} }) {
  const ticket = generatePasswordResetToken();

  const result = await prisma.$transaction(async (tx) => {
    const challenge = await tx.loginChallenge.findUnique({
      where: { id: challengeId },
      select: CHALLENGE_VERIFY_FIELDS,
    });

    // Missing (which includes every decoy id handed out for an unknown address),
    // belonging to a different flow, already used, or invalidated. One response
    // covers them all — distinguishing them is what would give the decoy away.
    if (
      !challenge ||
      challenge.purpose !== RESET_PURPOSE ||
      challenge.usedAt ||
      challenge.invalidatedAt
    ) {
      throw challengeNotActive();
    }

    if (challenge.expiresAt <= new Date()) {
      logger.info(`Reset OTP expired for challenge ${challengeId}.`);
      throw new ApiError(410, 'The verification code has expired. Request a new code.', {
        code: 'OTP_EXPIRED',
      });
    }

    if (challenge.failedAttempts >= config.otp.maxAttempts) {
      await tx.loginChallenge.update({
        where: { id: challengeId },
        data: { invalidatedAt: new Date() },
      });
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
        `Incorrect reset OTP for challenge ${challengeId} ` +
          `(attempt ${attempts}/${config.otp.maxAttempts}).`
      );
      if (limitReached) throw attemptLimitExceeded();
      throw new ApiError(401, 'The verification code is invalid.', { code: 'INVALID_OTP' });
    }

    // Correct code. Consume the challenge conditionally: only the transaction
    // that still finds it open marks it used, so a second concurrent
    // verification affects zero rows and is rejected below.
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

    // Status is re-checked here, not just at request time: an account may have
    // been hibernated in the five minutes since the code was sent.
    if (!canResetPassword(challenge.user)) {
      throw new ApiError(403, 'This account cannot reset its password.', {
        code: 'ACCOUNT_INACTIVE',
      });
    }

    // Any other ticket this user has lying around is superseded — finishing a
    // fresh OTP should not leave an older ticket redeemable.
    await tx.passwordResetTicket.updateMany({
      where: { userId: challenge.userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.passwordResetTicket.create({
      data: {
        id: crypto.randomUUID(),
        userId: challenge.userId,
        challengeId,
        tokenHash: ticket.tokenHash,
        expiresAt: ticket.expiresAt,
        requestIpHash: hashContext(context.ip),
        userAgentHash: hashContext(context.userAgent),
      },
    });

    return { userId: challenge.userId, email: challenge.user.email };
  });

  logger.info(`Reset OTP verified for user ${result.userId}; ticket issued.`);

  return {
    // Returned once and never persisted in this form — only its hash is stored.
    resetToken: ticket.rawToken,
    expiresInSeconds: config.passwordReset.ticketTtlSeconds,
    maskedEmail: maskEmail(result.email),
  };
}

/**
 * Step two, alternate action: re-send the code for an existing reset challenge.
 *
 * Mints a fresh code with a new expiry and immediately supersedes the old one on
 * the same challenge row, so only the newest code verifies. Never resets the
 * failed-attempt counter — otherwise "resend" would be an unlimited supply of
 * fresh guesses — and never issues a ticket.
 *
 * @param {{ challengeId: string }} params
 * @returns {{ otpResent: true, expiresInSeconds: number, resendAvailableInSeconds: number }}
 */
async function resendPasswordResetOtp({ challengeId }) {
  const challenge = await prisma.loginChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      userId: true,
      purpose: true,
      failedAttempts: true,
      resendCount: true,
      lastSentAt: true,
      usedAt: true,
      invalidatedAt: true,
      user: { select: { email: true, firstName: true, status: true } },
    },
  });

  if (
    !challenge ||
    challenge.purpose !== RESET_PURPOSE ||
    challenge.usedAt ||
    challenge.invalidatedAt
  ) {
    throw challengeNotActive();
  }

  if (!canResetPassword(challenge.user)) {
    throw new ApiError(403, 'This account cannot reset its password.', {
      code: 'ACCOUNT_INACTIVE',
    });
  }

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
    throw new ApiError(429, 'Too many codes requested. Please restart the password reset.', {
      code: 'OTP_RESEND_LIMIT',
    });
  }

  const otp = generateOtp();
  const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000);

  // Atomic guard against a concurrent resend or verify: only one request can move
  // the row while it is still open and past its cooldown. Replacing the digest
  // here is what makes the previous code stop working immediately.
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
    throw new ApiError(429, 'Please wait before requesting another code.', {
      code: 'OTP_RESEND_COOLDOWN',
    });
  }

  logger.info(`Reset OTP resent for challenge ${challengeId} (user ${challenge.userId}).`);

  await deliverResetOtp(challengeId, {
    recipientEmail: challenge.user.email,
    recipientFirstName: challenge.user.firstName,
    otp,
    requestedAt: now,
    // The caller holds a real challenge id, so the account's existence is already
    // established — reporting a mail outage here leaks nothing.
    throwOnFailure: true,
  });

  return {
    otpResent: true,
    expiresInSeconds: config.otp.ttlSeconds,
    resendAvailableInSeconds: config.otp.resendCooldownSeconds,
  };
}

/**
 * Step three. Redeem the ticket and write the new password.
 *
 * Everything that changes state runs in one transaction: the ticket is consumed,
 * the hash is written, the login lock is cleared, and every existing session is
 * revoked together — a reset that half-applied would be worse than one that
 * failed outright. Revoking sessions is the part that makes this a recovery
 * rather than a formality: if the account was already compromised, changing the
 * password without cutting the attacker's live refresh tokens leaves them signed
 * in.
 *
 * The bcrypt hash is computed *before* the transaction opens. It takes a few
 * hundred milliseconds by design, and holding a database transaction (and its
 * pooled connection) open across it would be a self-inflicted bottleneck.
 *
 * @param {{ resetToken: string, password: string, context?: { ip?: string } }} params
 * @returns {{ passwordUpdated: true, sessionsRevoked: number }}
 */
async function completePasswordReset({ resetToken, password, context = {} }) {
  const ticket = await prisma.passwordResetTicket.findUnique({
    where: { tokenHash: hashPasswordResetToken(resetToken) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: {
        select: { id: true, email: true, firstName: true, status: true, passwordHash: true },
      },
    },
  });

  // Unknown or already redeemed. Both get the same answer: a used ticket is not
  // meaningfully different from a forged one, and saying which is which tells a
  // caller holding a stolen token whether it is still worth racing.
  if (!ticket || ticket.usedAt) {
    logger.warn('Password reset confirm rejected: reset token unknown or already used.');
    throw ticketNotActive();
  }

  if (ticket.expiresAt <= new Date()) {
    logger.info(`Reset ticket ${ticket.id} expired for user ${ticket.userId}.`);
    throw new ApiError(410, 'This password reset request has expired. Please start again.', {
      code: 'RESET_TOKEN_EXPIRED',
    });
  }

  if (!canResetPassword(ticket.user)) {
    throw new ApiError(403, 'This account cannot reset its password.', {
      code: 'ACCOUNT_INACTIVE',
    });
  }

  // Refuse a no-op. Someone who has just recovered an account because they lost
  // access to it should not silently end up with the credential they could not
  // use — and if the account was compromised, re-setting the password the
  // attacker already knows achieves nothing.
  if (await verifyPassword(password, ticket.user.passwordHash)) {
    throw new ApiError(400, 'Choose a password different from your current one.', {
      code: 'PASSWORD_UNCHANGED',
      fields: { password: 'This is already your current password.' },
    });
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    // Conditional consume: only the transaction that still finds the ticket
    // unused and unexpired proceeds, so two racing confirms cannot both write a
    // password — the loser sees zero rows and is rejected.
    const { count } = await tx.passwordResetTicket.updateMany({
      where: { id: ticket.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) {
      throw ticketNotActive();
    }

    await tx.user.update({
      where: { id: ticket.userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        // Completing a reset clears any lockout. This is the intended way out of
        // one: the user proved control of the mailbox, so keeping them locked out
        // over failed guesses that may not even have been theirs serves no one.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Cut every live session. The old password is gone, so anything still holding
    // a refresh token issued under it must sign in again.
    const revoked = await tx.refreshToken.updateMany({
      where: { userId: ticket.userId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Kill any login challenge that was open mid-flight. Its OTP was issued
    // against the old password; letting it complete would hand out a session
    // minted from a credential that no longer exists.
    await tx.loginChallenge.updateMany({
      where: { userId: ticket.userId, usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });

    return revoked.count;
  });

  logger.info(
    `Password reset completed for user ${ticket.userId} ` +
      `(ticket ${ticket.id}, ${sessionsRevoked} session(s) revoked, ip=${
        hashContext(context.ip) ?? 'unknown'
      }).`
  );

  // Best-effort notification, after the commit. This is how the real owner finds
  // out if the reset was not theirs, so it is worth attempting — but the password
  // has already changed, and failing the request now would tell the user their
  // reset did not work when it did.
  try {
    await sendPasswordChangedEmail({
      recipientEmail: ticket.user.email,
      recipientFirstName: ticket.user.firstName,
      changedAt: now,
    });
  } catch (err) {
    logger.error(
      `Password-changed notification failed for user ${ticket.userId}: ${err.message}`
    );
  }

  return { passwordUpdated: true, sessionsRevoked };
}

function challengeNotActive() {
  return new ApiError(409, 'This password reset request is no longer active.', {
    code: 'CHALLENGE_NOT_ACTIVE',
  });
}

function ticketNotActive() {
  return new ApiError(409, 'This password reset request is no longer active.', {
    code: 'RESET_TOKEN_NOT_ACTIVE',
  });
}

function attemptLimitExceeded() {
  return new ApiError(429, 'Too many incorrect attempts. Please restart the password reset.', {
    code: 'OTP_ATTEMPT_LIMIT_EXCEEDED',
  });
}

module.exports = {
  requestPasswordReset,
  verifyPasswordResetOtp,
  resendPasswordResetOtp,
  completePasswordReset,
};
