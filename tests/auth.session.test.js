'use strict';

/**
 * Integration tests for the session-lifecycle endpoints: /auth/refresh,
 * /auth/logout, /auth/logout-all.
 *
 * None of these existed before. Refresh tokens were minted and stored and then
 * nothing ever consumed them, so a user was hard-logged-out the moment their
 * access token expired, and "sign out" could only clear client state while the
 * server-side session stayed valid.
 */

const crypto = require('crypto');

const mockPrisma = {
  user: { findUnique: jest.fn() },
  refreshToken: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

jest.mock('../src/services/emailService', () => ({
  sendOtpEmail: jest.fn(),
  sendInvitationEmail: jest.fn(),
  sendPasswordResetOtpEmail: jest.fn(),
  sendPasswordChangedEmail: jest.fn(),
  verifyEmailConnection: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { signAccessToken, hashRefreshToken } = require('../src/utils/tokens');

const USER_ID = 42;
const RAW_TOKEN = 'f'.repeat(96);
const FAMILY = crypto.randomUUID();

function auth(overrides = {}) {
  return `Bearer ${signAccessToken({
    userId: USER_ID,
    email: 'user@finopsys.ai',
    role: 'CUSTOMER',
    specificRole: 'OWNER',
    ...overrides,
  })}`;
}

const CSRF = 'c'.repeat(64);

/**
 * A cookie-authenticated request must satisfy the double-submit check: the CSRF
 * token comes back in a readable cookie and must be echoed in a header. An
 * attacker on another origin can cause the cookie to be SENT but cannot READ it,
 * so they cannot produce the header.
 */
function withSession(req) {
  return req
    .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
    .set('x-csrf-token', CSRF);
}

function tokenRow(overrides = {}) {
  return {
    id: 10,
    userId: USER_ID,
    familyId: FAMILY,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    revokedAt: null,
    replacedById: null,
    user: {
      id: USER_ID,
      email: 'user@finopsys.ai',
      status: 'ACTIVE',
      role: { code: 'CUSTOMER' },
      specificRole: { code: 'OWNER' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findUnique.mockResolvedValue({ passwordChangedAt: null, status: 'ACTIVE' });
  mockPrisma.refreshToken.findUnique.mockResolvedValue(tokenRow());
  mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.refreshToken.create.mockResolvedValue({ id: 11 });
  mockPrisma.refreshToken.update.mockResolvedValue({ id: 10 });
});

/* -------------------------------------------------------------------------- */

describe('POST /api/auth/refresh', () => {
  it('exchanges a valid refresh token for a new access token and rotates it', async () => {
    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.expiresInSeconds).toBe(config.auth.accessTokenTtlSeconds);
    // A NEW refresh token, not the one presented: each is single-use.
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).not.toBe(RAW_TOKEN);

    // The presented token is revoked and linked to its successor. That link is
    // what a later replay reads to recognise itself as spent.
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 10, revokedAt: null, replacedById: null }),
        data: expect.objectContaining({ revokedReason: 'rotated' }),
      })
    );
    expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10 }, data: { replacedById: 11 } })
    );

    // The successor stays in the same family, so reuse detection can still cut
    // the whole chain later.
    expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: FAMILY }) })
    );
  });

  it('looks the token up by HASH, never storing or matching the raw value', async () => {
    await withSession(request(app).post('/api/auth/refresh')).send();

    expect(mockPrisma.refreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashRefreshToken(RAW_TOKEN) } })
    );
  });

  it('accepts the token in the body for non-browser clients', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: RAW_TOKEN });
    expect(res.status).toBe(200);
  });

  it('REVOKES THE WHOLE FAMILY when an already-rotated token is replayed', async () => {
    // replacedById is set only by a previous successful rotation, so this token
    // has definitely been redeemed — and the legitimate client discarded it at
    // that moment, which means this presentation came from a copy.
    mockPrisma.refreshToken.findUnique.mockResolvedValue(tokenRow({ replacedById: 11 }));

    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    /*
     * The whole family, not just the replayed row. We cannot tell whether the
     * replay came from the thief or the victim, so keeping either session alive
     * risks keeping the attacker's.
     */
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ familyId: FAMILY, revokedAt: null }),
        data: expect.objectContaining({ revokedReason: 'reuse_detected' }),
      })
    );
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown token', () => mockPrisma.refreshToken.findUnique.mockResolvedValue(null)],
    ['a revoked token', () => mockPrisma.refreshToken.findUnique.mockResolvedValue(tokenRow({ revokedAt: new Date() }))],
    [
      'an expired token',
      () => mockPrisma.refreshToken.findUnique.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1000) })),
    ],
  ])('answers one identical 401 for %s', async (_label, stage) => {
    stage();

    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    // Distinguishing these would tell someone holding a stolen token which case
    // it is; the client's response is "sign in again" either way.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('refuses a token whose account is no longer ACTIVE, and cuts the family', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue(
      tokenRow({ user: { ...tokenRow().user, status: 'HIBERNATED' } })
    );

    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('refuses a cookie-borne refresh with no CSRF header', async () => {
    // The cookie is attached by the browser automatically; the header is not.
    // That asymmetry is the entire protection.
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refuses a cookie-borne refresh whose header does not match the cookie', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .set('x-csrf-token', 'd'.repeat(64))
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('resolves a concurrent double-refresh to exactly one winner', async () => {
    // Two tabs hold the same valid token. The conditional update means one wins;
    // the loser gets the ordinary "sign in again" rather than tripping the
    // family-wide revoke, which would log the user out of everything.
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('sets a fresh HttpOnly cookie and a readable CSRF token', async () => {
    const res = await withSession(request(app).post('/api/auth/refresh')).send();

    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/refreshToken=/);
    expect(cookies).toMatch(/HttpOnly/i);
    // The CSRF cookie must NOT be HttpOnly — the client has to read it to echo
    // it back in the header, which is the entire double-submit mechanism.
    expect(cookies).toMatch(/csrfToken=/);
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
  });
});

/* -------------------------------------------------------------------------- */

describe('POST /api/auth/logout', () => {
  it('revokes the session family and clears the cookies', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 10, userId: USER_ID, familyId: FAMILY });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

    const res = await withSession(request(app).post('/api/auth/logout')).send();

    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(2);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ familyId: FAMILY }),
        data: expect.objectContaining({ revokedReason: 'logout' }),
      })
    );

    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/refreshToken=;/);
  });

  it('answers 200 even with no or an unknown token', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/auth/logout').send();

    /*
     * A logout that 401s because the token had already expired is useless — the
     * client wants the session gone either way — and answering differently for a
     * real and a bogus token would make this an oracle for testing stolen ones.
     */
    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(0);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('revokes every session for the authenticated user', async () => {
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 5 });

    const res = await request(app).post('/api/auth/logout-all').set('Authorization', auth()).send();

    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(5);
    // Identity from the access token, not the cookie — which is what makes this
    // usable when the cookie for this device is already gone.
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, revokedAt: null },
        data: expect.objectContaining({ revokedReason: 'logout_all' }),
      })
    );
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/auth/logout-all').send();
    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */

describe('access tokens issued before a password change', () => {
  it('are rejected as expired', async () => {
    /*
     * The reset flow revokes refresh tokens, but an access token already in
     * someone's hands stays cryptographically valid until it expires. Without
     * this check, "reset the password to lock out whoever compromised my
     * account" left them a working session. users.password_changed_at had been
     * written for exactly this purpose and nothing read it.
     */
    mockPrisma.user.findUnique.mockResolvedValue({
      passwordChangedAt: new Date(Date.now() + 60_000),
      status: 'ACTIVE',
    });

    const res = await request(app).post('/api/auth/logout-all').set('Authorization', auth()).send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('are accepted when issued after the change', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      passwordChangedAt: new Date(Date.now() - 60_000),
      status: 'ACTIVE',
    });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post('/api/auth/logout-all').set('Authorization', auth()).send();

    expect(res.status).toBe(200);
  });
});
