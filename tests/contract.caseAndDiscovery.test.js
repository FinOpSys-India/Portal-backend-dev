'use strict';

/**
 * Two things are covered here, because both are contract-wide rather than
 * belonging to any one feature:
 *
 *   1. Key casing. Requests accept snake_case AND camelCase; responses are
 *      always camelCase. The API used to be split down the middle — auth and
 *      onboarding in camelCase, company and billing in snake_case — so a client
 *      could not apply one convention, and a global case transform would
 *      silently corrupt whichever half it was not written for.
 *
 *   2. The discovery endpoints. GET /companies and GET /users did not exist, and
 *      without them the frontend could not rediscover a companyId after a page
 *      refresh, nor find a userId to put in an assignment field. Those screens
 *      were unbuildable, not merely awkward.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  company: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  companySubscription: { findFirst: jest.fn(), findMany: jest.fn() },
  address: { create: jest.fn(), update: jest.fn() },
  companyAddress: { findFirst: jest.fn(), create: jest.fn() },
  $queryRaw: jest.fn(async () => [{ ok: 1 }]),
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
const { signAccessToken } = require('../src/utils/tokens');
const { toCamelDeep, detectCaseCollisions } = require('../src/utils/caseTransform');

const USER_ID = 42;
const COMPANY_ID = 900;

function auth({ role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId: USER_ID, email: 'owner@finopsys.ai', role, specificRole })}`;
}

function callerUser(overrides = {}) {
  return {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
    passwordChangedAt: null,
    role: { code: 'CUSTOMER' },
    specificRole: { code: 'OWNER' },
    ...overrides,
  };
}

function companyRow(overrides = {}) {
  return {
    id: COMPANY_ID,
    companyName: 'ABC Aerospace LLC',
    companyType: 'LIMITED_LIABILITY_COMPANY',
    companyEmail: 'accounts@abcaerospace.com',
    companyPhone: '+1 555 123 4567',
    employeeCount: 25,
    lastYearRevenue: '1500000.00',
    revenueCurrency: 'USD',
    ownerUserId: USER_ID,
    accountingManagerUserId: null,
    status: 'ACTIVE',
    onboardingCompleted: true,
    deletedAt: null,
    createdAt: new Date('2026-07-24T00:00:00Z'),
    updatedAt: new Date('2026-07-24T00:00:00Z'),
    owner: { id: USER_ID, firstName: 'Ada', lastName: 'Lovelace' },
    accountingManager: null,
    addresses: [
      {
        address: {
          id: 500,
          line1: '123 Main Street',
          line2: null,
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          country: 'United States',
          countryCode: 'US',
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findUnique.mockResolvedValue(callerUser());
  mockPrisma.company.findFirst.mockResolvedValue(companyRow());
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
  // Every company read now carries active services, the billing date and the
  // team. Default to "nothing bought, nobody staffed"; the tests that care opt in.
  mockPrisma.companySubscription.findMany.mockResolvedValue([]);
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
});

/* -------------------------------------------------------------------------- */
/* the case-transform utility                                                 */
/* -------------------------------------------------------------------------- */

describe('caseTransform', () => {
  it('rewrites keys deeply and leaves values untouched', () => {
    const out = toCamelDeep({
      company_id: 1,
      selected_services: { payroll: { employee_count: '12', plan_id: 'payroll_standard' } },
      address_line_1: 'x',
    });

    expect(out).toEqual({
      companyId: 1,
      selectedServices: { payroll: { employeeCount: '12', planId: 'payroll_standard' } },
      addressLine1: 'x',
    });
  });

  it('leaves an already-camelCase key alone, which is what makes both spellings work', () => {
    expect(toCamelDeep({ companyId: 1 })).toEqual({ companyId: 1 });
  });

  it('never rewrites a VALUE — a plan code keeps its underscores', () => {
    const out = toCamelDeep({ price_option_id: 'bookkeeping_option_2', codes: ['FA_Q', 'TAX'] });
    expect(out.priceOptionId).toBe('bookkeeping_option_2');
    expect(out.codes).toEqual(['FA_Q', 'TAX']);
  });

  it('preserves the form-level error key', () => {
    // The validators use `_` for messages that belong to no single field.
    expect(toCamelDeep({ _: 'form level' })).toEqual({ _: 'form level' });
  });

  it('returns a Buffer by reference — the Stripe raw body must survive intact', () => {
    const buf = Buffer.from('{"id":"evt_1"}');
    expect(toCamelDeep({ body: buf }).body).toBe(buf);
  });

  it('flags a body that sends both spellings of one field', () => {
    expect(detectCaseCollisions({ company_id: 1, companyId: 2 })).toContain('companyId');
    expect(detectCaseCollisions({ address: { postal_code: 'a', postalCode: 'b' } })).toContain('address.postalCode');
    expect(detectCaseCollisions({ companyId: 1 })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /companies — the endpoint that makes companyId rediscoverable          */
/* -------------------------------------------------------------------------- */

describe('GET /api/companies', () => {
  it('lists the caller’s companies in camelCase with pagination', async () => {
    mockPrisma.company.findMany.mockResolvedValue([companyRow()]);
    mockPrisma.company.count.mockResolvedValue(1);

    const res = await request(app).get('/api/companies').set('Authorization', auth());

    expect(res.status).toBe(200);
    const [company] = res.body.data.companies;
    expect(company).toMatchObject({
      id: COMPANY_ID,
      companyName: 'ABC Aerospace LLC',
      ownerUserId: USER_ID,
      lastYearRevenue: '1500000.00',
      accessRole: 'OWNER',
    });
    expect(company.primaryAddress).toMatchObject({ addressLine1: '123 Main Street', countryCode: 'US' });
    expect(res.body.data.pagination).toMatchObject({ total: 1, limit: 25, offset: 0, hasMore: false });

    // Nothing snake_case escapes.
    expect(JSON.stringify(res.body)).not.toMatch(/"[a-z]+_[a-z]/);
  });

  it('gives a CUSTOMER their company info, plans, billing date and active services', async () => {
    /*
     * The same enriched row the admin table gets. A customer looking at their own
     * company asks the same questions — what am I paying for, when does it renew,
     * who works on it — and the answer must not depend on which endpoint asked.
     * The caller here is CUSTOMER/OWNER, not an admin.
     */
    mockPrisma.company.findMany.mockResolvedValue([companyRow()]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.companySubscription.findMany.mockResolvedValue([
      {
        id: 7001,
        companyId: COMPANY_ID,
        status: 'ACTIVE',
        currentPeriodStart: new Date('2026-07-30T05:09:21Z'),
        currentPeriodEnd: new Date('2026-08-30T05:09:21Z'),
        cancelAtPeriodEnd: false,
        items: [
          {
            quantity: 1,
            servicePlan: {
              planCode: 'BOOKKEEPING_GROWTH', planName: 'Bookkeeping Growth', isAddOn: false,
              quantityEnabled: false, quantityLabel: null,
              specialization: { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
            },
          },
          {
            quantity: 4,
            servicePlan: {
              planCode: 'PAYROLL_W2_EMPLOYEE', planName: 'W-2 Employee Add-On', isAddOn: true,
              quantityEnabled: true, quantityLabel: 'Number of W-2 Employees',
              specialization: { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll' },
            },
          },
        ],
      },
    ]);
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      {
        id: 8001, companyId: COMPANY_ID, specialistUserId: 22,
        specialist: { id: 22, firstName: 'Grace', lastName: 'Hopper', email: 'grace@finopsys.ai' },
        specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
      },
    ]);

    const res = await request(app).get('/api/companies').set('Authorization', auth());
    const [company] = res.body.data.companies;

    expect(res.status).toBe(200);
    expect(company.accessRole).toBe('OWNER');

    // The plan it is on, per service.
    const bookkeeping = company.activeServices.find((s) => s.specializationCode === 'BOOKKEEPING');
    expect(bookkeeping).toMatchObject({ planCode: 'BOOKKEEPING_GROWTH', planName: 'Bookkeeping Growth' });

    // Payroll head counts, named by the catalog's own label.
    const payroll = company.activeServices.find((s) => s.specializationCode === 'PAYROLL');
    expect(payroll.addOns[0]).toMatchObject({
      component: 'employees',
      quantityLabel: 'Number of W-2 Employees',
      quantity: 4,
    });

    // Billing date.
    expect(company.billing.currentPeriodEnd).toBe('2026-08-30T05:09:21.000Z');

    // Team.
    expect(company.teamMembers.specialists[0]).toMatchObject({ userId: 22, firstName: 'Grace' });
    expect(company.teamMemberCount).toBe(2); // owner + one specialist

    // Still no snake_case, and still no credential material.
    expect(JSON.stringify(res.body)).not.toMatch(/"[a-z]+_[a-z]/);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('scopes the query to companies the caller can actually reach', async () => {
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.company.count.mockResolvedValue(0);

    await request(app).get('/api/companies').set('Authorization', auth());

    const [args] = mockPrisma.company.findMany.mock.calls[0];
    // Owned, managed, or served as an ACTIVE specialist — the same three routes
    // the read-authorization rule recognises, so the list can never show a
    // company the detail call would then refuse.
    expect(args.where.OR).toEqual([
      { ownerUserId: USER_ID },
      { accountingManagerUserId: USER_ID },
      { specialistAssignments: { some: { specialistUserId: USER_ID, assignmentStatus: 'ACTIVE' } } },
    ]);
    expect(args.where.deletedAt).toBeNull();
  });

  it('keeps the access filter when the caller searches', async () => {
    /*
     * Both the access scope and the search want the key `OR`, so spreading them
     * into one object made the second REPLACE the first — a non-admin who typed
     * anything into the search box lost their scoping and matched every company
     * in the database. They are combined with AND now.
     */
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.company.count.mockResolvedValue(0);

    await request(app).get('/api/companies?search=aero').set('Authorization', auth());

    const [args] = mockPrisma.company.findMany.mock.calls[0];
    expect(args.where.AND).toHaveLength(2);
    const [scope, search] = args.where.AND;
    expect(scope.OR).toEqual([
      { ownerUserId: USER_ID },
      { accountingManagerUserId: USER_ID },
      { specialistAssignments: { some: { specialistUserId: USER_ID, assignmentStatus: 'ACTIVE' } } },
    ]);
    expect(search.OR).toEqual([
      { companyName: { contains: 'aero', mode: 'insensitive' } },
      { companyEmail: { contains: 'aero', mode: 'insensitive' } },
    ]);
  });

  it('does not filter by owner for an ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(callerUser({ role: { code: 'ADMIN' }, specificRole: null }));
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.company.count.mockResolvedValue(0);

    await request(app).get('/api/companies').set('Authorization', auth({ role: 'ADMIN', specificRole: null }));

    const [args] = mockPrisma.company.findMany.mock.calls[0];
    expect(args.where.OR).toBeUndefined();
  });

  it('rejects an unsupported sort field rather than forwarding it', async () => {
    const res = await request(app).get('/api/companies?sort=passwordHash').set('Authorization', auth());
    expect(res.status).toBe(400);
    expect(res.body.error.details.allowed).toContain('companyName');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/companies');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/companies/:companyId', () => {
  it('returns the company with its primary address and the caller’s access role', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow());

    const res = await request(app).get(`/api/companies/${COMPANY_ID}`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.company).toMatchObject({ id: COMPANY_ID, accessRole: 'OWNER' });
    expect(res.body.data.company.primaryAddress.city).toBe('Austin');
  });

  it('404s a company the caller cannot see', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}`).set('Authorization', auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMPANY_NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* PATCH / DELETE — company details were previously immutable                 */
/* -------------------------------------------------------------------------- */

describe('PATCH /api/companies/:companyId', () => {
  it('updates named fields and accepts snake_case on the way in', async () => {
    mockPrisma.company.update.mockResolvedValue(companyRow({ companyName: 'ABC Aerospace Inc' }));
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ companyName: 'ABC Aerospace Inc' }));

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_ID}`)
      .set('Authorization', auth())
      .send({ company_name: 'ABC Aerospace Inc', employee_count: 30 });

    expect(res.status).toBe(200);
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { companyName: 'ABC Aerospace Inc', employeeCount: 30 } })
    );
    expect(res.body.data.company.companyName).toBe('ABC Aerospace Inc');
  });

  it('refuses an empty patch', async () => {
    const res = await request(app).patch(`/api/companies/${COMPANY_ID}`).set('Authorization', auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.details.updatable).toContain('companyEmail');
  });

  it('normalises a full US state name to its code', async () => {
    mockPrisma.companyAddress.findFirst.mockResolvedValue({ address: { id: 500 } });
    mockPrisma.address.update.mockResolvedValue({ id: 500 });
    mockPrisma.company.findFirst.mockResolvedValue(companyRow());

    await request(app)
      .patch(`/api/companies/${COMPANY_ID}`)
      .set('Authorization', auth())
      .send({
        address: {
          address_line_1: '1 Congress Ave',
          city: 'Austin',
          // What a person types, rather than what an invoice needs.
          state: 'Texas',
          postal_code: '78701',
          country: 'United States',
          country_code: 'US',
        },
      });

    expect(mockPrisma.address.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'TX' }) })
    );
  });

  it('rejects a postal code that cannot be valid for its country', async () => {
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_ID}`)
      .set('Authorization', auth())
      .send({
        address: {
          address_line_1: '1 Congress Ave',
          city: 'Austin',
          state: 'TX',
          postal_code: 'NOT-A-ZIP',
          country: 'United States',
          country_code: 'US',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.postalCode).toBeDefined();
  });

  it('rejects a country code that is not a real ISO assignment', async () => {
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_ID}`)
      .set('Authorization', auth())
      .send({
        address: {
          address_line_1: '1 Congress Ave',
          city: 'Austin',
          state: 'TX',
          postal_code: '78701',
          country: 'Nowhere',
          country_code: 'XX',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.countryCode).toBeDefined();
  });
});

describe('DELETE /api/companies/:companyId', () => {
  it('soft-deletes and archives', async () => {
    mockPrisma.companySubscription.findFirst.mockResolvedValue(null);
    mockPrisma.company.update.mockResolvedValue(companyRow({ status: 'ARCHIVED', deletedAt: new Date() }));

    const res = await request(app).delete(`/api/companies/${COMPANY_ID}`).set('Authorization', auth());

    expect(res.status).toBe(200);
    // A tombstone, not a real delete: subscriptions, payments and assignments
    // all reference this row and the billing history must survive.
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: expect.any(Date), status: 'ARCHIVED' } })
    );
  });

  it('refuses while a subscription is still billing', async () => {
    mockPrisma.companySubscription.findFirst.mockResolvedValue({ id: 5, status: 'ACTIVE' });

    const res = await request(app).delete(`/api/companies/${COMPANY_ID}`).set('Authorization', auth());

    // Archiving a company that is still being charged would leave Stripe billing
    // for something the customer can no longer see.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_STILL_ACTIVE');
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* GET /users — the directory behind the assignment pickers                   */
/* -------------------------------------------------------------------------- */

describe('GET /api/users', () => {
  it('returns ACTIVE users filtered by role, without any secret column', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 22,
        email: 'grace@finopsys.ai',
        firstName: 'Grace',
        lastName: 'Hopper',
        jobTitle: 'Tax Specialist',
        status: 'ACTIVE',
        role: { code: 'SPECIALIST' },
        specificRole: { code: 'SPECIALIST_2' },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(1);

    const res = await request(app).get('/api/users?role=SPECIALIST').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.users[0]).toEqual({
      userId: 22,
      email: 'grace@finopsys.ai',
      firstName: 'Grace',
      lastName: 'Hopper',
      role: 'SPECIALIST',
      specificRole: 'SPECIALIST_2',
      jobTitle: 'Tax Specialist',
      status: 'ACTIVE',
    });

    const [args] = mockPrisma.user.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ status: 'ACTIVE', role: { code: 'SPECIALIST' } });
    // No password hash, no login-security columns, ever.
    expect(args.select.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|failedLoginAttempts|lockedUntil/);
  });

  it('refuses a caller who is neither an admin nor an owner', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      callerUser({ role: { code: 'SPECIALIST' }, specificRole: null })
    );

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', auth({ role: 'SPECIALIST', specificRole: null }));

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unsupported role filter', async () => {
    const res = await request(app).get('/api/users?role=SUPERUSER').set('Authorization', auth());
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* health + error envelope                                                    */
/* -------------------------------------------------------------------------- */

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('reports 503 when the database does not', async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/api/health');

    // The root `GET /` returns a static string without touching anything, so it
    // reports healthy on a process whose database is unreachable — which is the
    // state a load balancer most needs to detect.
    expect(res.status).toBe(503);
    expect(res.body.error.details.database).toBe('down');
  });
});

describe('body-parser failures use the standard error envelope', () => {
  it('reports malformed JSON as a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.com",');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });
});
