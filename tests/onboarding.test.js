'use strict';

/**
 * Integration tests for the post-signup onboarding flow, driven through the real
 * Express app with Prisma mocked — no database required. Each test stages the
 * exact user/role/company state a scenario needs and asserts on the HTTP
 * response and the writes the service issued.
 *
 * The `mock`-prefixed name is required: jest.mock is hoisted above the imports,
 * and its factory may only close over variables whose names begin with "mock".
 *
 * Note the routes are mounted at `/api/onboarding` (app.js currently mounts the
 * router aggregator at `/`).
 *
 * There is no `customers` table any more (db/schema/13_drop_customers.sql): a
 * company belongs directly to its owner, so onboarding assigns a role and
 * collects a profile. The company step itself lives at POST /onboarding/company
 * and is covered by tests/company.onboarding.test.js, not here.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  role: { findUnique: jest.fn() },
  specificRole: { findUnique: jest.fn() },
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
const { signAccessToken } = require('../src/utils/tokens');

const USER_ID = 42;
const USER_EMAIL = 'owner@finopsys.ai';

/** A Bearer header for a valid access token, as requireAuth expects. */
function auth(userId = USER_ID, email = USER_EMAIL, role = 'CUSTOMER', specificRole = 'OWNER') {
  return `Bearer ${signAccessToken({ userId, email, role, specificRole })}`;
}

/**
 * The `ownedCompanies` shape STATUS_SELECT asks for: the id, plus the ACTIVE
 * subscriptions Prisma has already filtered down to at most one. An empty
 * `subscriptions` array is a company that has not been paid for.
 *
 * @param {boolean} paid  Whether this company has an ACTIVE subscription.
 */
function company(paid, id = 1) {
  return { id, subscriptions: paid ? [{ id: 500 }] : [] };
}

/**
 * A user row shaped like STATUS_SELECT: an owner with the profile half-filled
 * and no company yet, which is the state right after sign-up and the one most
 * scenarios start from.
 */
function statusUser(overrides = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    jobTitle: null,
    status: 'ACTIVE',
    role: { code: 'CUSTOMER' },
    specificRole: { code: 'OWNER' },
    ownedCompanies: [],
    ...overrides,
  };
}

/** The same owner with all three steps behind them: profile, company, payment. */
function completedOwner(overrides = {}) {
  return statusUser({
    phone: '+1 555 000 1111',
    jobTitle: 'Chief Technology Officer',
    ownedCompanies: [company(true)],
    ...overrides,
  });
}

/** A user carrying no role at all — the only state provision() may promote. */
function unroledUser(overrides = {}) {
  return statusUser({ role: null, specificRole: null, ...overrides });
}

function validProfile(overrides = {}) {
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+1 555 123 4567',
    jobTitle: 'Chief Technology Officer',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.role.findUnique.mockResolvedValue({ id: 4 });
  mockPrisma.specificRole.findUnique.mockResolvedValue({ id: 1 });
  /*
   * requireAuth reads the user on EVERY authenticated request (it checks status
   * and password-rotation freshness), so this default has to be present or every
   * request 401s before reaching the route. Tests that care about the row set
   * their own value; those that only exercise validation rely on this one.
   *
   * It is set per test rather than once, because jest.clearAllMocks() clears
   * calls but NOT implementations — without this, a value set by one test would
   * silently satisfy the next, which is how this file used to pass.
   */
  mockPrisma.user.findUnique.mockResolvedValue(statusUser());
});

describe('Onboarding — authentication guard', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const res = await request(app).get('/api/onboarding');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed/invalid token (401)', async () => {
    const res = await request(app)
      .get('/api/onboarding')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('GET /onboarding — status', () => {
  it('reports an owner who has finished all three steps as complete', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(completedOwner());

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      id: USER_ID,
      email: USER_EMAIL,
      role: 'CUSTOMER',
      specificRole: 'OWNER',
    });
    expect(res.body.data.onboarding).toMatchObject({
      isOwner: true,
      profileComplete: true,
      companyCreated: true,
      paymentComplete: true,
      complete: true,
    });
    // Identity came from the token, so the lookup used the token's user id.
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    );
  });

  it('holds an owner back while the profile is unfinished', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(statusUser({ ownedCompanies: [company(true)] }));

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({
      profileComplete: false,
      companyCreated: true,
      paymentComplete: true,
      complete: false,
    });
  });

  /*
   * The company step is what the old status could not see: it derived `complete`
   * from the role and the profile alone, so an owner with no company at all was
   * told they were done and the portal let them into an empty account.
   */
  it('holds an owner back until a company exists, even with a full profile', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(completedOwner({ ownedCompanies: [] }));

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({
      profileComplete: true,
      companyCreated: false,
      paymentComplete: false,
      complete: false,
    });
  });

  /*
   * A company with no ACTIVE subscription is the state an abandoned checkout
   * leaves behind — the company row exists, nothing has been paid for it.
   */
  it('holds an owner back until the company is paid for', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      completedOwner({ ownedCompanies: [company(false)] })
    );

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({
      profileComplete: true,
      companyCreated: true,
      paymentComplete: false,
      complete: false,
    });
  });

  /*
   * One paid company is enough. An owner who has since added a second, unpaid
   * one is an established customer partway through a purchase — throwing them
   * back into onboarding would lock them out of the account they already pay for.
   */
  /*
   * The rule this asserts was once the opposite: ANY paid company completed the
   * owner. That let an owner who had paid for their first company create further
   * ones that were never billed while the portal went on reporting them finished,
   * so nothing ever routed them back to service selection. Every company owned
   * must be paid for.
   */
  it('is incomplete when one company is paid and another is not', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      completedOwner({ ownedCompanies: [company(true, 1), company(false, 2)] })
    );

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.body.data.onboarding).toMatchObject({ paymentComplete: false, complete: false });
  });

  it('completes an owner once every company they own is paid', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      completedOwner({ ownedCompanies: [company(true, 1), company(true, 2)] })
    );

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.body.data.onboarding).toMatchObject({ paymentComplete: true, complete: true });
  });

  /*
   * Two filters the status depends on and cannot verify from a mocked result:
   * soft-deleted companies must not count as the company step, and only ACTIVE
   * subscriptions count as paid (INCOMPLETE is an abandoned checkout, PAST_DUE
   * and UNPAID are lapsed). Prisma applies both, so what is asserted is that both
   * were asked for.
   */
  it('asks Prisma for live companies and ACTIVE subscriptions only', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(completedOwner());

    await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          ownedCompanies: {
            where: { deletedAt: null },
            select: {
              id: true,
              subscriptions: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
            },
          },
        }),
      })
    );
  });

  /*
   * Sign-up is invitation-only, so a teammate arrives holding CUSTOMER/TEAM with
   * no company to create and no bill to settle — no endpoint would ever make
   * companyCreated or paymentComplete true for them. Gating them on either would
   * lock them out of the portal permanently.
   */
  it('completes a teammate on the profile alone', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      completedOwner({ specificRole: { code: 'TEAM' }, ownedCompanies: [] })
    );

    const res = await request(app)
      .get('/api/onboarding')
      .set('Authorization', auth(USER_ID, USER_EMAIL, 'CUSTOMER', 'TEAM'));

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({
      isOwner: false,
      profileComplete: true,
      companyCreated: false,
      paymentComplete: false,
      complete: true,
    });
  });

  it('completes a specialist on the profile alone', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      completedOwner({
        role: { code: 'SPECIALIST' },
        specificRole: { code: 'SPECIALIST_1' },
        ownedCompanies: [],
      })
    );

    const res = await request(app)
      .get('/api/onboarding')
      .set('Authorization', auth(USER_ID, USER_EMAIL, 'SPECIALIST', 'SPECIALIST_1'));

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({ isOwner: false, complete: true });
  });

  it('keeps accountProvisioned as an alias of isOwner for older clients', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(completedOwner());
    const res = await request(app).get('/api/onboarding').set('Authorization', auth());
    expect(res.body.data.onboarding.accountProvisioned).toBe(true);
  });

  it('maps a vanished token subject to 401 USER_NOT_FOUND', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/onboarding').set('Authorization', auth());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /onboarding — assign the owner role', () => {
  it('assigns the CUSTOMER/OWNER pair resolved from role codes (201)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(unroledUser());
    mockPrisma.user.update.mockResolvedValue(statusUser());

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.onboarding.isOwner).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: expect.objectContaining({ roleId: 4, specificRoleId: 1 }),
      })
    );
  });

  /*
   * The promotion invalidates the caller's token, which still claims whatever
   * they were before, so a replacement carrying the new claim is handed back.
   */
  it('returns a replacement access token when the role actually changed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(unroledUser());
    mockPrisma.user.update.mockResolvedValue(statusUser());

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    expect(res.body.data.tokens.expiresInSeconds).toEqual(expect.any(Number));
  });

  it('is idempotent: a user who already holds the owner pair gets 200 and no write', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(completedOwner());

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already provisioned/i);
    expect(res.body.data.onboarding.isOwner).toBe(true);
    expect(res.body.data.tokens).toBeUndefined();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  /*
   * PRIVILEGE ESCALATION. The route is guarded by requireAuth alone, so before
   * the check in provision() any authenticated user could call it and overwrite
   * their own role with the owner pair — and be handed a token carrying the new
   * claim. A user's role is decided by whoever invited them.
   */
  describe('refuses to overwrite a role the caller already holds', () => {
    const others = [
      ['a teammate', 'CUSTOMER', 'TEAM'],
      ['a specialist', 'SPECIALIST', 'SPECIALIST_1'],
      ['an accounting manager', 'ACCOUNTING_MANAGER', null],
      ['an admin', 'ADMIN', null],
    ];

    it.each(others)('rejects %s with 403 and writes nothing', async (_label, role, specific) => {
      mockPrisma.user.findUnique.mockResolvedValue(
        statusUser({
          role: { code: role },
          specificRole: specific ? { code: specific } : null,
        })
      );

      const res = await request(app)
        .post('/api/onboarding')
        .set('Authorization', auth(USER_ID, USER_EMAIL, role, specific))
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ROLE_ALREADY_ASSIGNED');
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      // No replacement token, so the caller cannot walk away with a new claim.
      expect(res.body.data).toBeUndefined();
    });
  });

  /*
   * An id in the body is REJECTED outright rather than quietly dropped. Ignoring
   * it was already safe — identity has always come from the token — but a
   * silently-discarded field is indistinguishable from an accepted one to whoever
   * is probing the endpoint, and to an honest client with a typo.
   */
  it('NEVER trusts a user id from the request body — rejects it with 400', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(unroledUser());

    const res = await request(app)
      .post('/api/onboarding')
      .set('Authorization', auth(USER_ID))
      .send({ userId: 9999, id: 9999, ownerUserId: 9999 });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toEqual(
      expect.arrayContaining(['userId', 'id', 'ownerUserId'])
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  /*
   * The company name belongs to POST /onboarding/company, which owns that step.
   * Accepting it here would give one field two homes.
   */
  it('rejects a company name in the body with 400', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(unroledUser());

    const res = await request(app)
      .post('/api/onboarding')
      .set('Authorization', auth())
      .send({ companyName: 'Acme' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toEqual(expect.arrayContaining(['companyName']));
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('maps a vanished token subject to 401 USER_NOT_FOUND', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('PUT /onboarding/profile — submit the onboarding form', () => {
  it('saves the profile and reports profileComplete (200)', async () => {
    mockPrisma.user.update.mockResolvedValue(completedOwner());

    const res = await request(app)
      .put('/api/onboarding/profile')
      .set('Authorization', auth())
      .send(validProfile());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding.profileComplete).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '+1 555 123 4567',
          jobTitle: 'Chief Technology Officer',
        },
      })
    );
  });

  /*
   * Saving the profile does not finish an owner who still has no company, and the
   * status returned by the write must say so — otherwise a client that trusts
   * this response sends them into a portal with nothing in it.
   */
  it('does not report an owner complete on the profile alone', async () => {
    mockPrisma.user.update.mockResolvedValue(completedOwner({ ownedCompanies: [] }));

    const res = await request(app)
      .put('/api/onboarding/profile')
      .set('Authorization', auth())
      .send(validProfile());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding).toMatchObject({ profileComplete: true, complete: false });
  });

  it('rejects a body missing required fields with 400', async () => {
    const res = await request(app)
      .put('/api/onboarding/profile')
      .set('Authorization', auth())
      .send({ firstName: 'Ada' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['lastName', 'phone', 'jobTitle'])
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone number with 400', async () => {
    const res = await request(app)
      .put('/api/onboarding/profile')
      .set('Authorization', auth())
      .send(validProfile({ phone: 'call-me' }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields.phone).toBeDefined();
  });
});

describe('Onboarding — error handling', () => {
  it('maps an unexpected database error to a 500 without leaking internals', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('boom: secret db detail'));
    const res = await request(app).get('/api/onboarding').set('Authorization', auth());
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // In production the message is replaced with a fixed line (see errorHandler);
    // that redaction is exercised by the error-handler's own behaviour, not here.
  });
});
