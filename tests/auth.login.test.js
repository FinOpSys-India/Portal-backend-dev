'use strict';

/**
 * Integration tests for POST /api/auth/login (step one of the email-OTP
 * login). Prisma and the email service are mocked, so each test stages the exact
 * account state it needs and asserts on the HTTP response — no database or SMTP.
 *
 * The `mock`-prefixed names are required: jest.mock is hoisted above the imports
 * and its factory may only close over variables whose names begin with "mock".
 */

const bcrypt = require('bcrypt');

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  loginChallenge: {
    updateMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
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

const LOGIN_URL = '/api/auth/login';
const EMAIL = 'user@finopsys.ai';
const PASSWORD = 'StrongPass1';
// A real bcrypt hash of PASSWORD (low cost for test speed); verifyPassword
// compares against it regardless of the stored cost.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function activeUser(overrides = {}) {
  return {
    id: 1,
    email: EMAIL,
    passwordHash: PASSWORD_HASH,
    status: 'ACTIVE',
    failedLoginAttempts: 0,
    lockedUntil: null,
    role: { code: 'CUSTOMER' },
    specificRole: null,
    ...overrides,
  };
}

function stageHappyPath() {
  mockPrisma.user.findUnique.mockResolvedValue(activeUser());
  mockPrisma.loginChallenge.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.user.update.mockResolvedValue({});
  mockPrisma.loginChallenge.create.mockResolvedValue({});
  mockPrisma.loginChallenge.update.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendOtpEmail.mockResolvedValue({ messageId: 'test' });
  stageHappyPath();
});

describe('POST /api/auth/login', () => {
  it('returns a 202 OTP challenge for valid credentials without any tokens', async () => {
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.otpRequired).toBe(true);
    expect(res.body.data.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(res.body.data.expiresInSeconds).toBe(300);
    expect(res.body.data.resendAvailableInSeconds).toBe(60);

    // No session established before OTP.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('accessToken');
    expect(body).not.toContain('refreshToken');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('masks the email and never returns the full address or password', async () => {
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(res.body.data.maskedEmail).toMatch(/\*/);
    expect(res.body.data.maskedEmail).not.toBe(EMAIL);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it('sends the OTP to the registered email and stores only a keyed digest', async () => {
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(mockSendOtpEmail).toHaveBeenCalledTimes(1);
    const emailArg = mockSendOtpEmail.mock.calls[0][0];
    expect(emailArg.recipientEmail).toBe(EMAIL);
    // A six-digit OTP was generated (leading zeroes allowed) and is a string.
    expect(emailArg.otp).toMatch(/^[0-9]{6}$/);

    // The stored digest is an HMAC (64 hex chars), never the raw OTP, and the
    // OTP is not echoed in the response.
    const created = mockPrisma.loginChallenge.create.mock.calls[0][0].data;
    expect(created.otpDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(created.otpDigest).not.toContain(emailArg.otp);
    expect(JSON.stringify(res.body)).not.toContain(emailArg.otp);
  });

  it('invalidates previous open challenges before creating a new one', async () => {
    await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(mockPrisma.loginChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 1, usedAt: null, invalidatedAt: null }),
        data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
      })
    );
  });

  it('returns a generic 401 for an unknown email (no enumeration)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Invalid email or password.');
    expect(mockSendOtpEmail).not.toHaveBeenCalled();
  });

  it('returns the same generic 401 for a wrong password and records the failure', async () => {
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: 'WrongPass9' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Invalid email or password.');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ failedLoginAttempts: 1 }),
      })
    );
    expect(mockSendOtpEmail).not.toHaveBeenCalled();
  });

  it('returns the same generic 401 for a correct password on a non-active account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeUser({ status: 'HIBERNATED' }));
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(mockSendOtpEmail).not.toHaveBeenCalled();
  });

  it('rejects a missing email with a 400 validation error and field detail', async () => {
    const res = await request(app).post(LOGIN_URL).send({ password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields.email).toBeDefined();
    expect(res.body.error.requestId).toMatch(/^req_/);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 503 OTP_DELIVERY_UNAVAILABLE when the email provider fails', async () => {
    mockSendOtpEmail.mockRejectedValue(new Error('smtp down: secret host detail'));
    const res = await request(app).post(LOGIN_URL).send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OTP_DELIVERY_UNAVAILABLE');
    // The provider's raw error must not leak.
    expect(JSON.stringify(res.body)).not.toContain('secret host detail');
  });
});
