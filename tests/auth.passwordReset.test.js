'use strict';

/**
 * Integration tests for the forgotten-password flow:
 *   POST /api/auth/password-reset          (request a code)
 *   POST /api/auth/password-reset/otp      (verify | resend)
 *   POST /api/auth/password-reset/confirm  (set the new password)
 *
 * Prisma and the email service are mocked; the real OTP and token utils run, so
 * a staged challenge holds a digest the service will actually accept and a
 * staged ticket is found by the same hash the service computes.
 */

const crypto = require('crypto');

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  loginChallenge: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  passwordResetTicket: {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  refreshToken: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const mockSendResetOtp = jest.fn();
const mockSendPasswordChanged = jest.fn();
jest.mock('../src/services/emailService', () => ({
  sendPasswordResetOtpEmail: mockSendResetOtp,
  sendPasswordChangedEmail: mockSendPasswordChanged,
  sendOtpEmail: jest.fn(),
  sendInvitationEmail: jest.fn(),
  verifyEmailConnection: jest.fn(),
}));

const bcrypt = require('bcrypt');
const request = require('supertest');
const app = require('../src/app');
const { digestOtp } = require('../src/utils/otp');
const { hashPasswordResetToken } = require('../src/utils/tokens');

const REQUEST_URL = '/api/auth/password-reset';
const OTP_URL = '/api/auth/password-reset/otp';
const CONFIRM_URL = '/api/auth/password-reset/confirm';

const EMAIL = 'user@finopsys.ai';
const OTP = '012345'; // leading zero on purpose
const NEW_PASSWORD = 'BrandNewPass1';
const OLD_PASSWORD = 'OldPassword1';
// Cost 4 rather than the configured 12: verification reads the cost from the
// hash itself, so a cheap fixture keeps the suite fast without changing the code
// path under test.
const OLD_PASSWORD_HASH = bcrypt.hashSync(OLD_PASSWORD, 4);

function uuid() {
  return crypto.randomUUID();
}

/** A 96-char hex string — the shape generatePasswordResetToken() produces. */
function rawResetToken() {
  return crypto.randomBytes(48).toString('hex');
}

function activeUser(overrides = {}) {
  return {
    id: 1,
    email: EMAIL,
    firstName: 'Ada',
    status: 'ACTIVE',
    passwordHash: OLD_PASSWORD_HASH,
    ...overrides,
  };
}

function resetChallenge(id, overrides = {}) {
  return {
    id,
    userId: 1,
    purpose: 'PASSWORD_RESET_EMAIL_OTP',
    otpDigest: digestOtp(id, OTP),
    expiresAt: new Date(Date.now() + 300 * 1000),
    failedAttempts: 0,
    resendCount: 0,
    lastSentAt: new Date(Date.now() - 120 * 1000),
    usedAt: null,
    invalidatedAt: null,
    user: activeUser(),
    ...overrides,
  };
}

function resetTicket(overrides = {}) {
  return {
    id: uuid(),
    userId: 1,
    expiresAt: new Date(Date.now() + 600 * 1000),
    usedAt: null,
    user: activeUser(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendResetOtp.mockResolvedValue({ messageId: 'test' });
  mockSendPasswordChanged.mockResolvedValue({ messageId: 'test' });
  mockPrisma.loginChallenge.create.mockResolvedValue({});
  mockPrisma.loginChallenge.update.mockResolvedValue({});
  mockPrisma.loginChallenge.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.passwordResetTicket.create.mockResolvedValue({});
  mockPrisma.passwordResetTicket.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
  mockPrisma.user.update.mockResolvedValue({});
});

describe('POST /api/auth/password-reset — request a code', () => {
  it('issues a challenge and emails a reset code for an active account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser());

    const res = await request(app).post(REQUEST_URL).send({ email: EMAIL });

    expect(res.status).toBe(202);
    expect(res.body.data.otpRequired).toBe(true);
    expect(res.body.data.maskedEmail).toBe('u**r@finopsys.ai');
    expect(res.body.data.expiresInSeconds).toBe(300);

    // Bound to the reset purpose, never the login one.
    const created = mockPrisma.loginChallenge.create.mock.calls[0][0].data;
    expect(created.purpose).toBe('PASSWORD_RESET_EMAIL_OTP');
    expect(created.userId).toBe(1);
    expect(mockSendResetOtp).toHaveBeenCalledTimes(1);

    // The code goes to the address on the account, not one from the request.
    expect(mockSendResetOtp.mock.calls[0][0].recipientEmail).toBe(EMAIL);
    // The plain OTP is never echoed to the client.
    expect(JSON.stringify(res.body)).not.toContain(mockSendResetOtp.mock.calls[0][0].otp);
  });

  it('refuses an unregistered email with 404, writing nothing and sending nothing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app).post(REQUEST_URL).send({ email: 'nobody@finopsys.ai' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMAIL_NOT_REGISTERED');
    expect(mockPrisma.loginChallenge.create).not.toHaveBeenCalled();
    expect(mockSendResetOtp).not.toHaveBeenCalled();
  });

  it('keeps a non-ACTIVE account indistinguishable from a resettable one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser());
    const hit = await request(app).post(REQUEST_URL).send({ email: EMAIL });

    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(activeUser({ status: 'HIBERNATED' }));
    const decoy = await request(app).post(REQUEST_URL).send({ email: EMAIL });

    expect(decoy.status).toBe(hit.status);
    expect(decoy.body.message).toBe(hit.body.message);
    expect(Object.keys(decoy.body.data).sort()).toEqual(Object.keys(hit.body.data).sort());
    expect(decoy.body.data.maskedEmail).toBe(hit.body.data.maskedEmail);
    // Only the random challenge id differs.
    expect(decoy.body.data.challengeId).not.toBe(hit.body.data.challengeId);
  });

  it('gives a non-ACTIVE account the silent decoy rather than the 404', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser({ status: 'HIBERNATED' }));

    const res = await request(app).post(REQUEST_URL).send({ email: EMAIL });

    expect(res.status).toBe(202);
    expect(mockPrisma.loginChallenge.create).not.toHaveBeenCalled();
    expect(mockSendResetOtp).not.toHaveBeenCalled();
  });

  it('still answers 202 when the mail provider is down, rather than leaking the hit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser());
    mockSendResetOtp.mockRejectedValue(new Error('SMTP unavailable'));

    const res = await request(app).post(REQUEST_URL).send({ email: EMAIL });

    expect(res.status).toBe(202);
    // The failure is recorded on the challenge for us to see.
    expect(mockPrisma.loginChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deliveryStatus: 'FAILED' } })
    );
  });

  it('normalises the email before lookup', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser());

    await request(app).post(REQUEST_URL).send({ email: '  User@FinOpSys.AI  ' });

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: EMAIL } })
    );
  });

  it('rejects a malformed email with 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post(REQUEST_URL).send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields.email).toBeDefined();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const res = await request(app).post(REQUEST_URL).send({ email: EMAIL, userId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.fields._).toMatch(/userId/);
  });
});

describe('POST /api/auth/password-reset/otp — verify', () => {
  it('returns a single-use reset token on the correct code, and no session', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(resetChallenge(id));

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(200);
    expect(res.body.data.otpVerified).toBe(true);
    expect(res.body.data.resetToken).toMatch(/^[0-9a-f]{96}$/);
    expect(res.body.data.expiresInSeconds).toBe(600);

    // Verifying a reset code logs nobody in.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.data.accessToken).toBeUndefined();

    // Challenge consumed, ticket persisted as a hash of the returned token.
    expect(mockPrisma.loginChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) })
    );
    const ticketData = mockPrisma.passwordResetTicket.create.mock.calls[0][0].data;
    expect(ticketData.tokenHash).toBe(hashPasswordResetToken(res.body.data.resetToken));
    expect(ticketData.challengeId).toBe(id);
  });

  it('refuses a LOGIN_EMAIL_OTP challenge — a login code cannot reset a password', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(
      resetChallenge(id, { purpose: 'LOGIN_EMAIL_OTP' })
    );

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_NOT_ACTIVE');
    expect(mockPrisma.passwordResetTicket.create).not.toHaveBeenCalled();
  });

  it('rejects an incorrect code with 401 INVALID_OTP and increments attempts', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(resetChallenge(id));

    const res = await request(app)
      .post(OTP_URL)
      .send({ action: 'verify', challengeId: id, otp: '999999' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
    expect(mockPrisma.loginChallenge.update.mock.calls[0][0].data.failedAttempts).toEqual({
      increment: 1,
    });
    expect(mockPrisma.passwordResetTicket.create).not.toHaveBeenCalled();
  });

  it('rejects an expired code with 410 OTP_EXPIRED even when it is correct', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(
      resetChallenge(id, { expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('treats a decoy challenge id like any other dead challenge', async () => {
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(OTP_URL)
      .send({ action: 'verify', challengeId: uuid(), otp: OTP });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_NOT_ACTIVE');
  });

  it('invalidates the challenge and returns 429 once the attempt limit is reached', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(resetChallenge(id, { failedAttempts: 5 }));

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_ATTEMPT_LIMIT_EXCEEDED');
    expect(mockPrisma.loginChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invalidatedAt: expect.any(Date) } })
    );
  });

  it('rejects an otp field on a resend', async () => {
    const res = await request(app)
      .post(OTP_URL)
      .send({ action: 'resend', challengeId: uuid(), otp: OTP });

    expect(res.status).toBe(400);
    expect(res.body.error.fields._).toMatch(/otp/);
  });
});

describe('POST /api/auth/password-reset/otp — resend', () => {
  it('mints a fresh code and supersedes the old digest on the same challenge', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(resetChallenge(id));

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(200);
    expect(res.body.data.otpResent).toBe(true);
    const data = mockPrisma.loginChallenge.updateMany.mock.calls[0][0].data;
    expect(data.otpDigest).toBeDefined();
    expect(data.otpDigest).not.toBe(digestOtp(id, OTP));
    expect(data.resendCount).toEqual({ increment: 1 });
    // A resend must never hand back fresh guesses.
    expect(data.failedAttempts).toBeUndefined();
    expect(mockSendResetOtp).toHaveBeenCalledTimes(1);
  });

  it('enforces the cooldown with 429 and a Retry-After header', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(
      resetChallenge(id, { lastSentAt: new Date(Date.now() - 5 * 1000) })
    );

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_RESEND_COOLDOWN');
    expect(res.headers['retry-after']).toBeDefined();
    expect(mockSendResetOtp).not.toHaveBeenCalled();
  });

  it('reports a delivery failure honestly — the account is already known to exist', async () => {
    const id = uuid();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(resetChallenge(id));
    mockSendResetOtp.mockRejectedValue(new Error('SMTP unavailable'));

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OTP_DELIVERY_UNAVAILABLE');
  });
});

describe('POST /api/auth/password-reset/confirm — set the new password', () => {
  it('stores the new hash, clears the lock, and revokes every session', async () => {
    const token = rawResetToken();
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(resetTicket());

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.passwordUpdated).toBe(true);
    expect(res.body.data.sessionsRevoked).toBe(2);

    // Looked up by hash — the raw token is never stored.
    expect(mockPrisma.passwordResetTicket.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashPasswordResetToken(token) } })
    );

    const userData = mockPrisma.user.update.mock.calls[0][0].data;
    expect(await bcrypt.compare(NEW_PASSWORD, userData.passwordHash)).toBe(true);
    expect(userData.passwordChangedAt).toBeInstanceOf(Date);
    expect(userData.failedLoginAttempts).toBe(0);
    expect(userData.lockedUntil).toBeNull();

    // Sessions cut, in-flight login challenges killed, ticket consumed.
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The reason is recorded alongside the timestamp so a revoked session can
        // be told apart from one the user ended deliberately.
        data: { revokedAt: expect.any(Date), revokedReason: 'password_reset' },
      })
    );
    expect(mockPrisma.loginChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invalidatedAt: expect.any(Date) } })
    );
    expect(mockPrisma.passwordResetTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usedAt: expect.any(Date) } })
    );

    // Recovering an account does not sign you in.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.data.accessToken).toBeUndefined();

    expect(mockSendPasswordChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown or already-used ticket with 409', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: NEW_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESET_TOKEN_NOT_ACTIVE');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a used ticket with the same 409 as an unknown one', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(
      resetTicket({ usedAt: new Date() })
    );

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: NEW_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESET_TOKEN_NOT_ACTIVE');
  });

  it('rejects an expired ticket with 410 RESET_TOKEN_EXPIRED', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(
      resetTicket({ expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: NEW_PASSWORD });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('RESET_TOKEN_EXPIRED');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to set the password that is already in use', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(resetTicket());

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: OLD_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_UNCHANGED');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('applies the sign-up password policy', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(resetTicket());

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.requirements).toEqual(
      expect.arrayContaining(['be at least 8 characters', 'contain an uppercase letter'])
    );
    // Rejected before any lookup — a bad password costs no database work.
    expect(mockPrisma.passwordResetTicket.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a confirmPassword that does not match', async () => {
    const res = await request(app).post(CONFIRM_URL).send({
      resetToken: rawResetToken(),
      password: NEW_PASSWORD,
      confirmPassword: 'BrandNewPass2',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.confirmPassword).toMatch(/do not match/);
  });

  it('rejects a malformed reset token before touching the database', async () => {
    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: 'nope', password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.resetToken).toBeDefined();
    expect(mockPrisma.passwordResetTicket.findUnique).not.toHaveBeenCalled();
  });

  it('never echoes the submitted password back in an error', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: NEW_PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain(NEW_PASSWORD);
  });

  it('still succeeds when the notification email fails', async () => {
    mockPrisma.passwordResetTicket.findUnique.mockResolvedValue(resetTicket());
    mockSendPasswordChanged.mockRejectedValue(new Error('SMTP unavailable'));

    const res = await request(app)
      .post(CONFIRM_URL)
      .send({ resetToken: rawResetToken(), password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.passwordUpdated).toBe(true);
  });
});
