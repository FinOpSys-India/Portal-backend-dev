'use strict';

/**
 * Integration tests for POST /api/auth/otp (step two of login) covering both
 * the `verify` and `resend` actions. Prisma and the email service are mocked; the
 * real OTP util computes digests so a staged challenge holds a digest that the
 * service will actually accept.
 */

const crypto = require('crypto');

const mockPrisma = {
  user: {
    update: jest.fn(),
  },
  loginChallenge: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const mockSendOtpEmail = jest.fn().mockResolvedValue({ messageId: 'test' });
jest.mock('../src/services/emailService', () => ({
  sendOtpEmail: mockSendOtpEmail,
  sendInvitationEmail: jest.fn(),
  verifyEmailConnection: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const { digestOtp } = require('../src/utils/otp');

const OTP_URL = '/api/auth/otp';
const OTP = '012345'; // leading zero on purpose

function makeChallengeId() {
  return crypto.randomUUID();
}

function challenge(id, overrides = {}) {
  return {
    id,
    userId: 1,
    purpose: 'LOGIN_EMAIL_OTP',
    otpDigest: digestOtp(id, OTP),
    expiresAt: new Date(Date.now() + 300 * 1000),
    failedAttempts: 0,
    resendCount: 0,
    lastSentAt: new Date(Date.now() - 120 * 1000),
    usedAt: null,
    invalidatedAt: null,
    user: {
      id: 1,
      email: 'user@finopsys.ai',
      status: 'ACTIVE',
      role: { code: 'CUSTOMER' },
      specificRole: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendOtpEmail.mockResolvedValue({ messageId: 'test' });
  mockPrisma.loginChallenge.update.mockResolvedValue({});
  mockPrisma.loginChallenge.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.update.mockResolvedValue({});
  mockPrisma.refreshToken.create.mockResolvedValue({});
});

describe('POST /api/auth/otp — verify', () => {
  it('logs the user in on a correct OTP: access token in body, refresh token in cookie', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id));

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.user).toEqual({ id: 1, email: 'user@finopsys.ai', role: 'CUSTOMER' });
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.expiresInSeconds).toBe(900);

    // Refresh token is set as an HttpOnly cookie, never in the body.
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/refreshToken=/);
    expect(cookies).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');

    // Challenge consumed and a refresh token persisted.
    expect(mockPrisma.loginChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) })
    );
    expect(mockPrisma.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an incorrect OTP with 401 INVALID_OTP and increments attempts without touching expiry', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id));

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: '999999' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
    const updateData = mockPrisma.loginChallenge.update.mock.calls[0][0].data;
    expect(updateData.failedAttempts).toEqual({ increment: 1 });
    expect(updateData.expiresAt).toBeUndefined();
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an expired OTP with 410 OTP_EXPIRED even when the code is correct', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(
      challenge(id, { expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('rejects a used/unknown challenge with 409 CHALLENGE_NOT_ACTIVE', async () => {
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(OTP_URL)
      .send({ action: 'verify', challengeId: makeChallengeId(), otp: OTP });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_NOT_ACTIVE');
  });

  it('invalidates the challenge and returns 429 once the attempt limit is reached', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id, { failedAttempts: 5 }));

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_ATTEMPT_LIMIT_EXCEEDED');
    expect(mockPrisma.loginChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invalidatedAt: expect.any(Date) }) })
    );
  });

  it('rejects a consumed-by-a-race challenge (conditional update matched no row) with 409', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id));
    mockPrisma.loginChallenge.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: OTP });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_NOT_ACTIVE');
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects OTP values that are not exactly six digits with a 400', async () => {
    const id = makeChallengeId();
    for (const bad of ['12345', '1234567', '12a456', '12 456']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(OTP_URL).send({ action: 'verify', challengeId: id, otp: bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /api/auth/otp — resend', () => {
  it('issues a fresh OTP and returns cooldown/expiry without any token', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id));

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(200);
    expect(res.body.data.otpResent).toBe(true);
    expect(res.body.data.expiresInSeconds).toBe(300);
    expect(res.body.data.resendAvailableInSeconds).toBe(60);
    expect(mockSendOtpEmail).toHaveBeenCalledTimes(1);

    // The digest is replaced (old OTP dies) and the failed-attempt counter is
    // NOT reset by a resend.
    const data = mockPrisma.loginChallenge.updateMany.mock.calls[0][0].data;
    expect(data.otpDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(data.resendCount).toEqual({ increment: 1 });
    expect(data.failedAttempts).toBeUndefined();
    // The freshly generated code is emailed, never returned in the body.
    const sentOtp = mockSendOtpEmail.mock.calls[0][0].otp;
    expect(JSON.stringify(res.body)).not.toContain(sentOtp);
  });

  it('enforces the resend cooldown with 429 OTP_RESEND_COOLDOWN and a Retry-After header', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(
      challenge(id, { lastSentAt: new Date(Date.now() - 5 * 1000) })
    );

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_RESEND_COOLDOWN');
    expect(res.headers['retry-after']).toBeDefined();
    expect(mockSendOtpEmail).not.toHaveBeenCalled();
  });

  it('enforces the maximum resend count with 429', async () => {
    const id = makeChallengeId();
    mockPrisma.loginChallenge.findUnique.mockResolvedValue(challenge(id, { resendCount: 3 }));

    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_RESEND_LIMIT');
  });

  it('rejects a resend request that carries an otp field (strict validation)', async () => {
    const id = makeChallengeId();
    const res = await request(app).post(OTP_URL).send({ action: 'resend', challengeId: id, otp: OTP });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown action with a 400 validation error', async () => {
    const res = await request(app)
      .post(OTP_URL)
      .send({ action: 'delete', challengeId: makeChallengeId() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
