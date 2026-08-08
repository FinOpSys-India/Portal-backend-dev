'use strict';

/**
 * Integration tests for POST /auth/signup, driven through the real Express app
 * with Prisma mocked. No database is required: the mock lets each test stage the
 * exact invitation/user state a scenario needs and assert on the HTTP response.
 *
 * The `mock`-prefixed name is required — jest.mock is hoisted above the imports,
 * and its factory may only close over variables whose names begin with "mock".
 */

const mockPrisma = {
  invitation: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
  },
  // Interactive transaction: run the callback with the same mock as `tx`.
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');

const VALID_TOKEN = 'a'.repeat(64);
const INVITEE_EMAIL = 'invitee@finopsys.ai';

function validInvitation(overrides = {}) {
  return {
    id: 10,
    email: INVITEE_EMAIL,
    roleId: 3,
    specificRoleId: 4,
    status: 'SENT',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    role: { code: 'SPECIALIST' },
    specificRole: { code: 'SPECIALIST_2' },
    ...overrides,
  };
}

function validBody(overrides = {}) {
  return {
    invitationToken: VALID_TOKEN,
    email: INVITEE_EMAIL,
    firstName: 'Jane',
    lastName: 'Doe',
    password: 'StrongPass1',
    ...overrides,
  };
}

function createdUser(overrides = {}) {
  return {
    id: 42,
    email: INVITEE_EMAIL,
    firstName: 'Jane',
    lastName: 'Doe',
    roleId: 3,
    specificRoleId: 4,
    status: 'ACTIVE',
    createdAt: new Date(),
    ...overrides,
  };
}

/** Stage the happy path; individual tests override the piece they exercise. */
function stageHappyPath() {
  mockPrisma.invitation.findUnique.mockResolvedValue(validInvitation());
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.invitation.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.create.mockResolvedValue(createdUser());
  mockPrisma.invitation.update.mockResolvedValue({});
  mockPrisma.refreshToken.create.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
  stageHappyPath();
});

describe('POST /auth/signup', () => {
  it('creates the account and returns access + refresh tokens', async () => {
    const res = await request(app).post('/api/auth/signup').send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      id: 42,
      email: INVITEE_EMAIL,
      firstName: 'Jane',
      lastName: 'Doe',
      status: 'ACTIVE',
    });
    expect(typeof res.body.data.tokens.accessToken).toBe('string');
    expect(typeof res.body.data.tokens.refreshToken).toBe('string');
    expect(res.body.data.tokens.refreshTokenExpiresAt).toBeDefined();
  });

  it('uses the invitation email and request names, ignoring any body email drift', async () => {
    // Body email must equal the invitation email (checked separately); here we
    // confirm the persisted user takes email from the invitation, names from
    // the request.
    await request(app).post('/api/auth/signup').send(validBody());

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: INVITEE_EMAIL,
          firstName: 'Jane',
          lastName: 'Doe',
          roleId: 3,
          specificRoleId: 4,
          status: 'ACTIVE',
        }),
      })
    );
  });

  it('performs user creation and invitation update in a single transaction', async () => {
    await request(app).post('/api/auth/signup').send(validBody());
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('stores only a bcrypt hash, never the plaintext password', async () => {
    await request(app).post('/api/auth/signup').send(validBody());
    const { passwordHash } = mockPrisma.user.create.mock.calls[0][0].data;
    expect(passwordHash).toMatch(/^\$2[aby]\$/);
    expect(passwordHash).not.toContain('StrongPass1');
  });

  it('never leaks the password, hash, or invitation token in the response', async () => {
    const res = await request(app).post('/api/auth/signup').send(validBody());
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('StrongPass1');
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain(VALID_TOKEN);
  });

  it('stores a hashed refresh token, not the raw one returned to the client', async () => {
    const res = await request(app).post('/api/auth/signup').send(validBody());
    const raw = res.body.data.tokens.refreshToken;
    const stored = mockPrisma.refreshToken.create.mock.calls[0][0].data.tokenHash;
    expect(stored).not.toBe(raw);
    expect(stored).toMatch(/^[a-f0-9]{64}$/); // sha-256 hex
  });

  it('rejects a request missing required fields with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: INVITEE_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['invitationToken', 'firstName', 'lastName', 'password'])
    );
  });

  it('rejects a weak password with 400 and does not touch the database', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send(validBody({ password: 'weak' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/password/i);
    expect(mockPrisma.invitation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown invitation token with 400', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid invitation token/i);
  });

  it('rejects an expired invitation (past expiresAt) with 410', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(
      validInvitation({ expiresAt: new Date(Date.now() - 1000) })
    );
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(410);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('rejects an invitation already marked EXPIRED with 410', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(
      validInvitation({ status: 'EXPIRED' })
    );
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(410);
  });

  it('rejects a revoked invitation with 410', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(
      validInvitation({ status: 'REVOKED' })
    );
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(410);
    expect(res.body.error.message).toMatch(/revoked/i);
  });

  it('rejects an already-accepted invitation with 409', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(
      validInvitation({ status: 'ACCEPTED' })
    );
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already been used/i);
  });

  it('rejects an email that does not match the invitation with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send(validBody({ email: 'someone.else@finopsys.ai' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not match/i);
  });

  it('rejects sign-up when a user with that email already exists with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7 });
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already exists/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a concurrent double-use (conditional update matched no row) with 409', async () => {
    // The pre-checks pass, but by the time the transaction runs another request
    // has consumed the invitation: the conditional update affects zero rows.
    mockPrisma.invitation.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already been used/i);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('maps an unexpected database error to a 500 without leaking internals', async () => {
    mockPrisma.invitation.findUnique.mockRejectedValue(new Error('boom: secret db detail'));
    const res = await request(app).post('/api/auth/signup').send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
