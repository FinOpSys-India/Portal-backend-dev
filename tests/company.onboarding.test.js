'use strict';

/**
 * Integration tests for POST /onboarding/company, driven through the real Express
 * app with Prisma mocked — no database required. Each test stages the exact
 * user/company/idempotency state a scenario needs and asserts on the HTTP
 * response and the writes the service issued.
 *
 * The `mock`-prefixed name is required: jest.mock is hoisted above the imports and
 * its factory may only close over variables whose names begin with "mock".
 */

const mockPrisma = {
  // findFirst is the company-email availability check reading the users table.
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  company: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  customer: { findUnique: jest.fn() },
  address: { create: jest.fn() },
  companyAddress: { create: jest.fn() },
  specialization: { findMany: jest.fn() },
  companySpecialistAssignment: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  idempotencyKey: { findUnique: jest.fn(), create: jest.fn() },
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

/** A Bearer header for an OWNER (CUSTOMER/OWNER) access token by default. */
function auth({ userId = USER_ID, email = USER_EMAIL, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email, role, specificRole })}`;
}

function ownerUser(overrides = {}) {
  return {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
    role: { code: 'CUSTOMER' },
    specificRole: { code: 'OWNER' },
    ...overrides,
  };
}

function companyRow(overrides = {}) {
  return {
    id: 900,
    companyName: 'ABC Aerospace LLC',
    companyType: 'LIMITED_LIABILITY_COMPANY',
    companyEmail: 'accounts@abcaerospace.com',
    companyPhone: '+1 555 123 4567',
    employeeCount: 25,
    lastYearRevenue: '1500000.00',
    revenueCurrency: 'USD',
    ownerUserId: USER_ID,
    accountingManagerUserId: null,
    status: 'ONBOARDING',
    onboardingCompleted: false,
    createdAt: new Date('2026-07-24T00:00:00Z'),
    updatedAt: new Date('2026-07-24T00:00:00Z'),
    ...overrides,
  };
}

function addressRow(overrides = {}) {
  return {
    id: 500,
    line1: '123 Main Street',
    line2: 'Suite 400',
    city: 'Austin',
    state: 'Texas',
    postalCode: '78701',
    country: 'United States',
    countryCode: 'US',
    ...overrides,
  };
}

/** The onboarding form body. Deliberately mixed-case to exercise normalisation. */
function validBody(overrides = {}) {
  return {
    company_name: 'ABC Aerospace LLC',
    company_type: 'LIMITED_LIABILITY_COMPANY',
    company_email: 'Accounts@ABCAerospace.com',
    company_phone: '+1 555 123 4567',
    employee_count: 25,
    last_year_revenue: 1500000.0,
    revenue_currency: 'usd',
    address: {
      address_line_1: '123 Main Street',
      address_line_2: 'Suite 400',
      city: 'Austin',
      state: 'Texas',
      postal_code: '78701',
      country: 'United States',
      country_code: 'us',
    },
    ...overrides,
  };
}

function stageHappyPath() {
  mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
  mockPrisma.customer.findUnique.mockResolvedValue({ id: 55 });
  mockPrisma.address.create.mockResolvedValue(addressRow());
  mockPrisma.company.create.mockResolvedValue(companyRow());
  mockPrisma.companyAddress.create.mockResolvedValue({ id: 700 });
  mockPrisma.company.update.mockResolvedValue(companyRow({ onboardingCompleted: true, status: 'ACTIVE' }));
  mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 1 });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  // clearAllMocks resets call history but NOT implementations, so re-establish
  // the "no prior idempotency record" default each test to avoid bleed.
  mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
  // Default: the company email is free. Both lookups back
  // assertCompanyEmailAvailable — company.findFirst for other companies,
  // user.findFirst for login addresses.
  mockPrisma.company.findFirst.mockResolvedValue(null);
  mockPrisma.user.findFirst.mockResolvedValue(null);
  // The customer account the new company will be linked to.
  mockPrisma.customer.findUnique.mockResolvedValue({ id: 55 });
});

describe('POST /api/onboarding/company — authentication & authorization', () => {
  it('rejects a request with no token (401)', async () => {
    const res = await request(app).post('/api/onboarding/company').send(validBody());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });

  it('rejects a non-owner token at the role gate (403 FORBIDDEN)', async () => {
    // The database agrees with the claim, so the gate's re-check confirms the
    // refusal rather than overturning it.
    mockPrisma.user.findUnique.mockResolvedValue(
      ownerUser({ role: { code: 'SPECIALIST' }, specificRole: null })
    );

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth({ role: 'SPECIALIST', specificRole: null }))
      .send(validBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });

  it('lets a caller through when the token role is STALE but the database says OWNER', async () => {
    /*
     * The case that used to be a dead end. POST /onboarding promotes a user to
     * CUSTOMER/OWNER but the access token they hold was signed before that, so
     * this call — gated on the OWNER claim — refused them, while GET /onboarding
     * simultaneously reported specificRole: "OWNER". Two endpoints disagreeing
     * about one user because one reads the token and the other reads the DB.
     */
    mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
    stageHappyPath();

    const res = await request(app)
      .post('/api/onboarding/company')
      // A pre-promotion token: no OWNER claim anywhere on it.
      .set('Authorization', auth({ role: 'CUSTOMER', specificRole: 'TEAM' }))
      .send(validBody());

    expect(res.status).toBe(201);
    // And the client is told its token is behind, so it can refresh rather than
    // relying on this fallback on every subsequent call.
    expect(res.headers['x-token-stale']).toBe('true');
  });

  it('rejects an owner token whose DB role is no longer OWNER (403 OWNER_ROLE_REQUIRED)', async () => {
    // Token claims OWNER (passes the gate) but the authoritative DB record does not.
    mockPrisma.user.findUnique.mockResolvedValue(ownerUser({ specificRole: { code: 'TEAM' } }));
    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_ROLE_REQUIRED');
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });

  it('maps a vanished token subject to 401 USER_NOT_FOUND', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /api/onboarding/company — happy path', () => {
  it('creates address + company + mapping in one transaction and returns 201', async () => {
    stageHappyPath();

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.company).toMatchObject({
      id: 900,
      ownerUserId: USER_ID,
      status: 'ACTIVE',
      onboardingCompleted: true,
      lastYearRevenue: '1500000.00',
    });
    expect(res.body.data.primaryAddress).toMatchObject({
      id: 500,
      addressLine1: '123 Main Street',
      countryCode: 'US',
    });

    // One transaction wraps every write.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Owner comes from the token, and inputs are normalised (email lower, currency/code upper).
    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerUserId: USER_ID,
          companyEmail: 'accounts@abcaerospace.com',
          revenueCurrency: 'USD',
          lastYearRevenue: '1500000',
        }),
      })
    );
    expect(mockPrisma.address.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ countryCode: 'US' }) })
    );
    // Mapping is the primary business address.
    expect(mockPrisma.companyAddress.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ addressType: 'BUSINESS', isPrimary: true }) })
    );
    // No idempotency record when no key was sent.
    expect(mockPrisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('NEVER accepts owner_user_id from the body — it is rejected as unknown (400)', async () => {
    stageHappyPath();
    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .send(validBody({ owner_user_id: 9999 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('ownerUserId');
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/onboarding/company — company email must be free', () => {
  it('rejects an email another company already uses (409)', async () => {
    stageHappyPath();
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ id: 901 }));

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPANY_EMAIL_IN_USE');
    expect(res.body.error.details.reason).toBe('company');
    // Rejected before the transaction — no address row is left behind.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.address.create).not.toHaveBeenCalled();
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });

  it("rejects an email that is a registered user's login address (409)", async () => {
    stageHappyPath();
    mockPrisma.user.findFirst.mockResolvedValue({ id: 77, email: 'accounts@abcaerospace.com' });

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPANY_EMAIL_IN_USE');
    expect(res.body.error.details.reason).toBe('user');
    expect(mockPrisma.company.create).not.toHaveBeenCalled();
  });

  it('matches case-insensitively, so mixed case cannot slip past', async () => {
    stageHappyPath();

    await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    // The validator lower-cases first; both lookups then ask case-insensitively,
    // so a row stored as 'Accounts@ABCAerospace.com' is still found.
    const expected = { equals: 'accounts@abcaerospace.com', mode: 'insensitive' };
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith({
      where: { companyEmail: expected, deletedAt: null },
    });
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: expected } })
    );
  });

  /*
   * The meta below is copied verbatim from a real P2002 raised by this app's
   * stack (Prisma 7 + @prisma/adapter-pg) against the live index. Note what is
   * NOT there: `meta.target`. The pg adapter leaves it undefined for a functional
   * index, so a hand-invented `{ target: 'companies_company_email_key' }` fixture
   * would pass while the production code never fired.
   */
  const REAL_P2002 = {
    code: 'P2002',
    name: 'PrismaClientKnownRequestError',
    meta: {
      modelName: 'Company',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "companies_company_email_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['lower(company_email::text'] },
        },
      },
    },
  };

  it('maps the unique-index violation from a concurrent request to the same 409', async () => {
    stageHappyPath();
    // Both checks pass, then the other request commits first and the index fires.
    mockPrisma.company.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), REAL_P2002)
    );

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPANY_EMAIL_IN_USE');
  });

  it('also recognises the classic meta.target shape', async () => {
    stageHappyPath();
    mockPrisma.company.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        name: 'PrismaClientKnownRequestError',
        meta: { target: ['company_email'] },
      })
    );

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPANY_EMAIL_IN_USE');
  });

  it('does not mistake the idempotency-key conflict for an email conflict', async () => {
    stageHappyPath();
    const conflict = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
      meta: { target: ['user_id', 'idempotency_key'] },
    });
    mockPrisma.idempotencyKey.create.mockRejectedValue(conflict);
    // The winner's stored response, found after our transaction rolled back.
    mockPrisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ companyId: 900, responseStatus: 201, responseBody: { success: true, replayed: true } });

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-abc')
      .send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.error).toBeUndefined();
  });
});

describe('POST /api/onboarding/company — validation', () => {
  it('rejects a missing required field (400)', async () => {
    const body = validBody();
    delete body.company_name;
    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toContain('companyName');
  });

  it('rejects an invalid email (400)', async () => {
    stageHappyPath();
    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .send(validBody({ company_email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyEmail).toBeDefined();
  });

  it('rejects a negative employee_count (400)', async () => {
    stageHappyPath();
    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .send(validBody({ employee_count: -3 }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields.employeeCount).toBeDefined();
  });

  it('rejects a negative revenue (400)', async () => {
    stageHappyPath();
    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .send(validBody({ last_year_revenue: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields.lastYearRevenue).toBeDefined();
  });

  it('rejects an unknown field inside the address (400)', async () => {
    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .send(validBody({ address: { ...validBody().address, latitude: 30.2 } }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('latitude');
  });
});

describe('POST /api/onboarding/company — idempotency', () => {
  it('replays the stored response on a retry with the same key (no second company)', async () => {
    stageHappyPath();

    const res1 = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-abc')
      .send(validBody());
    expect(res1.status).toBe(201);
    expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledTimes(1);

    // The record the service stored on the first call — feed it back for the retry.
    // The repo calls create({ data }), so the row shape is under `.data`.
    const stored = mockPrisma.idempotencyKey.create.mock.calls[0][0].data;
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(stored);

    const res2 = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-abc')
      .send(validBody());

    expect(res2.status).toBe(201);
    expect(res2.headers['idempotent-replay']).toBe('true');
    expect(res2.body).toEqual(res1.body);
    // Still only one company was ever created.
    expect(mockPrisma.company.create).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key reused with a different payload (422)', async () => {
    stageHappyPath();
    const res1 = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-xyz')
      .send(validBody());
    expect(res1.status).toBe(201);

    const stored = mockPrisma.idempotencyKey.create.mock.calls[0][0].data;
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ ...stored, requestHash: 'a-different-hash' });

    const res2 = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-xyz')
      .send(validBody({ company_name: 'Totally Different Co' }));

    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('resolves a concurrent double-submit (P2002 on the key) to the winner’s response', async () => {
    stageHappyPath();
    // The idempotency insert loses the unique(user_id, key) race inside the tx.
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
    mockPrisma.idempotencyKey.create.mockRejectedValueOnce(p2002);
    // The re-read after the rollback finds the winner's stored response.
    mockPrisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({ responseStatus: 201, responseBody: { success: true, replayed: true }, companyId: 900, requestHash: 'x' });

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'key-race')
      .send(validBody());

    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replay']).toBe('true');
    expect(res.body.replayed).toBe(true);
  });
});

describe('POST /api/onboarding/company — error handling', () => {
  it('rolls back and returns a generic 500 without leaking internals', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
    mockPrisma.address.create.mockRejectedValue(new Error('boom: secret db detail'));

    const res = await request(app).post('/api/onboarding/company').set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('COMPANY_ONBOARDING_FAILED');
    // The raw error message must not surface.
    expect(JSON.stringify(res.body)).not.toMatch(/secret db detail/);
  });
});
