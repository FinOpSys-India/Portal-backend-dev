'use strict';

/**
 * Regression tests for the CSRF gate itself, as distinct from the two session
 * endpoints that happen to use it (those are covered in auth.session.test.js).
 *
 * What these pin down is the thing that was actually fragile: the guard used to
 * be opt-in, named by hand on /auth/refresh and /auth/logout. Coverage was
 * complete only because those were the only two cookie-authenticated routes, and
 * nothing would have failed if a third had been added without it. The gate is
 * now mounted across the API prefix, and the tests below assert that from the
 * OUTSIDE — against a route that has never mentioned CSRF — so removing the
 * global mount breaks a test instead of quietly widening the attack surface.
 */

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
const { signAccessToken } = require('../src/utils/tokens');

const RAW_TOKEN = 'f'.repeat(96);
const CSRF = 'c'.repeat(64);

const bearer = () =>
  `Bearer ${signAccessToken({
    userId: 42,
    email: 'user@finopsys.ai',
    role: 'CUSTOMER',
    specificRole: 'OWNER',
  })}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findUnique.mockResolvedValue(null);
});

/* -------------------------------------------------------------------------- */

describe('the CSRF gate is mounted globally, not per route', () => {
  /*
   * POST /projects is the proof. It is an ordinary Bearer-authenticated route
   * that has never referenced CSRF, and it sits behind requireAuth — so if the
   * gate were still opt-in this request would reach requireAuth and answer 401
   * AUTH_REQUIRED. A 403 CSRF_TOKEN_INVALID instead means the gate ran first,
   * on a route nobody remembered to annotate. That is the whole point.
   */
  it('rejects a cookie-borne write to a route that never opted in', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .send({ name: 'forged' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('rejects a mismatched header on that same route', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .set('x-csrf-token', 'd'.repeat(64))
      .send({ name: 'forged' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('names the cookie and header the client is expected to use', async () => {
    // A 403 with no indication of WHAT was missing is the kind of error that
    // costs an afternoon of integration work, so the codes are part of the
    // contract rather than incidental.
    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`])
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({
      cookieName: config.security.csrfCookieName,
      headerName: config.security.csrfHeaderName,
    });
  });

  it('lets a matching header through to the route it was guarding', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .set('x-csrf-token', CSRF)
      .send({ name: 'ok' });

    // It still fails auth — there is no Bearer token — but it fails DOWNSTREAM
    // of the gate, which is what distinguishes "CSRF passed" from "CSRF ran".
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });
});

/* -------------------------------------------------------------------------- */

describe('the CSRF gate stays out of the way where it does not apply', () => {
  it('ignores Bearer-authenticated writes, which are not forgeable', async () => {
    // The browser does not attach an Authorization header by itself, so there is
    // no ambient credential to abuse and no reason to demand a CSRF token. If
    // this ever 403s, every non-browser API client is broken.
    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`])
      .set('Authorization', bearer())
      .send({});

    expect(res.body.error?.code).not.toBe('CSRF_TOKEN_INVALID');
  });

  it('ignores writes that carry no cookie at all', async () => {
    const res = await request(app).post('/api/projects').send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('ignores safe methods', async () => {
    const res = await request(app)
      .get('/api/projects')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`, `csrfToken=${CSRF}`]);

    expect(res.body.error?.code).not.toBe('CSRF_TOKEN_INVALID');
  });

  it('lets login through for a visitor holding a stale refresh cookie', async () => {
    /*
     * The lockout this guards against: the CSRF cookie is readable by design, so
     * it can be cleared on its own — by an extension, a partial cookie purge, a
     * browser setting — leaving a `refreshToken` cookie with no CSRF token beside
     * it. The gate keys off the refresh cookie's presence, so without the
     * exemption login itself would answer 403, and login is precisely the request
     * that would have repaired the state.
     */
    const res = await request(app)
      .post('/api/auth/login')
      .set('Cookie', [`refreshToken=${RAW_TOKEN}`])
      .send({ email: 'user@finopsys.ai', password: 'Whatever1!' });

    expect(res.status).not.toBe(403);
    expect(res.body.error?.code).not.toBe('CSRF_TOKEN_INVALID');
  });
});
