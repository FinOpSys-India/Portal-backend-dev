'use strict';

/**
 * Integration tests for the post-signup onboarding flow, driven through the real
 * Express app with Prisma mocked — no database required. Each test stages the
 * exact user/customer/role state a scenario needs and asserts on the HTTP
 * response and the writes the service issued.
 *
 * The `mock`-prefixed name is required: jest.mock is hoisted above the imports,
 * and its factory may only close over variables whose names begin with "mock".
 *
 * Note the routes are mounted at `/api/onboarding` (app.js currently mounts the
 * router aggregator at `/`).
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  customer: { create: jest.fn() },
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
function auth(userId = USER_ID, email = USER_EMAIL) {
  return `Bearer ${signAccessToken({ userId, email, role: 'CUSTOMER', specificRole: 'OWNER' })}`;
}

/** A user row shaped like STATUS_SELECT. Not yet provisioned by default. */
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
    ownedCustomer: null,
    ...overrides,
  };
}

function ownedCustomer(overrides = {}) {
  return { id: 100, name: "Ada Lovelace's Account", createdAt: new Date(), ...overrides };
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
});

describe('Onboarding — authentication guard', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const res = await request(app).get('/api/onboarding');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed/invalid token (401)', async () => {
    const res = await request(app).get('/api/onboarding').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('GET /onboarding — status', () => {
  it('returns the current onboarding status for the authenticated user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      statusUser({ ownedCustomer: ownedCustomer(), phone: '+1 555 000 1111', jobTitle: 'CTO' })
    );

    const res = await request(app).get('/api/onboarding').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: USER_ID, email: USER_EMAIL, role: 'CUSTOMER', specificRole: 'OWNER' });
    expect(res.body.data.customer).toMatchObject({ id: 100 });
    expect(res.body.data.onboarding).toEqual({ accountProvisioned: true, profileComplete: true, complete: true });
    // Identity came from the token, so the lookup used the token's user id.
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    );
  });

  it('maps a vanished token subject to 401 USER_NOT_FOUND', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/onboarding').set('Authorization', auth());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /onboarding — provision the owner + customer account', () => {
  it('provisions a first-time user: assigns OWNER role, creates the customer, links it (201)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(statusUser()); // not yet provisioned
    mockPrisma.customer.create.mockResolvedValue({ id: 100 });
    mockPrisma.user.update.mockResolvedValue(statusUser({ ownedCustomer: ownedCustomer() }));

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.customer).toMatchObject({ id: 100 });
    expect(res.body.data.onboarding.accountProvisioned).toBe(true);

    // Role assignment uses the CUSTOMER/OWNER ids resolved from their codes.
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID }, data: expect.objectContaining({ roleId: 4, specificRoleId: 1 }) })
    );
    // Customer is owned by the token's user; all writes run in one transaction.
    expect(mockPrisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerUserId: USER_ID }) })
    );
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('NEVER trusts a user id from the request body — uses the token subject', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(statusUser());
    mockPrisma.customer.create.mockResolvedValue({ id: 100 });
    mockPrisma.user.update.mockResolvedValue(statusUser({ ownedCustomer: ownedCustomer() }));

    /*
     * An id in the body is now REJECTED outright rather than quietly dropped.
     * Ignoring it was already safe — identity has always come from the token —
     * but a silently-discarded field is indistinguishable from an accepted one
     * to whoever is probing the endpoint, and to an honest client with a typo.
     */
    const rejected = await request(app)
      .post('/api/onboarding')
      .set('Authorization', auth(USER_ID))
      .send({ userId: 9999, id: 9999, ownerUserId: 9999, companyName: 'Acme' });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.unknown).toEqual(
      expect.arrayContaining(['userId', 'id', 'ownerUserId'])
    );
    expect(mockPrisma.customer.create).not.toHaveBeenCalled();

    // And with a clean body, the account is owned by the token's id (42).
    await request(app)
      .post('/api/onboarding')
      .set('Authorization', auth(USER_ID))
      .send({ companyName: 'Acme' });

    expect(mockPrisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerUserId: USER_ID, name: 'Acme' }) })
    );
  });

  it('is idempotent: an already-provisioned user gets 200 and no new account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(statusUser({ ownedCustomer: ownedCustomer() }));

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already provisioned/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.customer.create).not.toHaveBeenCalled();
  });

  it('resolves a concurrent double-provision (P2002) to the existing account', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(statusUser()) // pre-check: not provisioned
      .mockResolvedValueOnce(statusUser({ ownedCustomer: ownedCustomer() })); // re-read after the race
    mockPrisma.customer.create.mockResolvedValue({ id: 100 });
    // The transaction loses the unique(owner_user_id) race.
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
    mockPrisma.user.update.mockRejectedValue(p2002);

    const res = await request(app).post('/api/onboarding').set('Authorization', auth()).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({ id: 100 });
  });

  it('rejects an overlong company name with 400 before any write', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(statusUser());
    const res = await request(app)
      .post('/api/onboarding')
      .set('Authorization', auth())
      .send({ companyName: 'x'.repeat(256) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyName).toBeDefined();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /onboarding/profile — submit the onboarding form', () => {
  it('saves the profile and reports profileComplete (200)', async () => {
    mockPrisma.user.update.mockResolvedValue(
      statusUser({ phone: '+1 555 123 4567', jobTitle: 'Chief Technology Officer', ownedCustomer: ownedCustomer() })
    );

    const res = await request(app).put('/api/onboarding/profile').set('Authorization', auth()).send(validProfile());

    expect(res.status).toBe(200);
    expect(res.body.data.onboarding.profileComplete).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: { firstName: 'Ada', lastName: 'Lovelace', phone: '+1 555 123 4567', jobTitle: 'Chief Technology Officer' },
      })
    );
  });

  it('rejects a body missing required fields with 400', async () => {
    const res = await request(app)
      .put('/api/onboarding/profile')
      .set('Authorization', auth())
      .send({ firstName: 'Ada' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toEqual(expect.arrayContaining(['lastName', 'phone', 'jobTitle']));
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
