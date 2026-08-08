'use strict';

/**
 * Integration tests for admin company-account management: the management-page
 * read, accounting-manager assignment/removal, company-creation inheritance, and
 * the real-time channel — through the real Express app with Prisma mocked.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  company: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  companySubscription: { findMany: jest.fn() },
  companySpecialistAssignment: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  specificRole: { findMany: jest.fn() },
  address: { create: jest.fn() },
  companyAddress: { create: jest.fn() },
  idempotencyKey: { findUnique: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const http = require('http');

const request = require('supertest');
const app = require('../src/app');
const { signAccessToken } = require('../src/utils/tokens');
const realtime = require('../src/services/realtimeService');

const ADMIN_ID = 1;
const OWNER_ID = 42;
const MANAGER_ID = 55;
const OTHER_MANAGER_ID = 56;
const COMPANY_ID = 900;

function auth({ userId = ADMIN_ID, role = 'ADMIN', specificRole = null } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

function person(id, first, last, role, { status = 'ACTIVE', specificRole = null } = {}) {
  return {
    id,
    firstName: first,
    lastName: last,
    email: `${first}.${last}@finopsys.ai`.toLowerCase(),
    status,
    role: { code: role },
    specificRole: specificRole ? { code: specificRole } : null,
  };
}

function company(overrides = {}) {
  return {
    id: COMPANY_ID,
    ownerUserId: OWNER_ID,
    accountingManagerUserId: null,
    companyName: 'ABC Aerospace LLC',
    companyType: 'LIMITED_LIABILITY_COMPANY',
    companyEmail: 'a@b.com',
    companyPhone: '+1 555 123 4567',
    employeeCount: 25,
    lastYearRevenue: '1500000.00',
    revenueCurrency: 'USD',
    status: 'ACTIVE',
    onboardingCompleted: true,
    createdAt: new Date('2026-07-24T00:00:00Z'),
    updatedAt: new Date('2026-07-24T00:00:00Z'),
    owner: { id: OWNER_ID, firstName: 'John', lastName: 'Smith' },
    accountingManager: null,
    ...overrides,
  };
}

/** The joined manager shape the company reads return. */
function managerPerson(id = MANAGER_ID) {
  return { id, firstName: 'Sarah', lastName: 'Jones', email: 'sarah.jones@finopsys.ai' };
}

function stageUsers(map) {
  mockPrisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(map[where.id] ?? null));
}

/**
 * An ACTIVE subscription shaped as listActiveSubscriptionsForCompanies returns
 * it: line items joined to their plan and, through it, to the service the plan
 * sells. Mirrors the real seeded catalog — payroll is a base plan plus two
 * quantity add-ons.
 */
function subscription({ companyId = COMPANY_ID, services = ['BOOKKEEPING', 'PAYROLL'] } = {}) {
  const items = [];
  if (services.includes('BOOKKEEPING')) {
    items.push({
      quantity: 1,
      servicePlan: {
        planCode: 'BOOKKEEPING_STARTER', planName: 'Bookkeeping Starter', isAddOn: false,
        quantityEnabled: false, quantityLabel: null,
        specialization: { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
      },
    });
  }
  if (services.includes('PAYROLL')) {
    const payroll = { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll' };
    items.push(
      { quantity: 1, servicePlan: { planCode: 'PAYROLL_BASE', planName: 'Payroll Base', isAddOn: false, quantityEnabled: false, quantityLabel: null, specialization: payroll } },
      { quantity: 3, servicePlan: { planCode: 'PAYROLL_W2_EMPLOYEE', planName: 'W-2 Employee Add-On', isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of W-2 Employees', specialization: payroll } },
      // Quantity 0 — the row survives for history but the company is not paying
      // for contractors, so it must not be reported as part of the service.
      { quantity: 0, servicePlan: { planCode: 'PAYROLL_1099_CONTRACTOR', planName: '1099 Contractor Add-On', isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of 1099 Contractors', specialization: payroll } }
    );
  }
  if (services.includes('TAX')) {
    items.push({
      quantity: 1,
      servicePlan: {
        planCode: 'TAX_UNDER_500K', planName: 'Tax Under 500K', isAddOn: false,
        quantityEnabled: false, quantityLabel: null,
        specialization: { id: 3, specializationCode: 'TAX', specializationName: 'Tax' },
      },
    });
  }
  return {
    id: 7001,
    companyId,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-07-30T05:09:21Z'),
    currentPeriodEnd: new Date('2026-08-30T05:09:21Z'),
    cancelAtPeriodEnd: false,
    items,
  };
}

/**
 * A subscription carrying the PRICES captured at purchase, which is what the
 * manager's view reports — never the catalog's current list price.
 */
function pricedSubscription() {
  const payroll = { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll' };
  return {
    id: 7001,
    companyId: COMPANY_ID,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-07-30T05:09:21Z'),
    currentPeriodEnd: new Date('2026-08-30T05:09:21Z'),
    cancelAtPeriodEnd: false,
    items: [
      {
        quantity: 1, unitAmount: '249.00', currency: 'USD',
        servicePlan: {
          planCode: 'BOOKKEEPING_GROWTH', planName: 'Bookkeeping Growth', isAddOn: false,
          quantityEnabled: false, quantityLabel: null, billingInterval: 'MONTH',
          specialization: { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
        },
      },
      {
        quantity: 1, unitAmount: '99.00', currency: 'USD',
        servicePlan: {
          planCode: 'PAYROLL_BASE', planName: 'Payroll Base', isAddOn: false,
          quantityEnabled: false, quantityLabel: null, billingInterval: 'MONTH',
          specialization: payroll,
        },
      },
      {
        quantity: 3, unitAmount: '15.00', currency: 'USD',
        servicePlan: {
          planCode: 'PAYROLL_W2_EMPLOYEE', planName: 'W-2 Employee Add-On', isAddOn: true,
          quantityEnabled: true, quantityLabel: 'Number of W-2 Employees', billingInterval: 'MONTH',
          specialization: payroll,
        },
      },
    ],
  };
}

/** A specialist user, with the specific role that decides which service they serve. */
function specialist(id, first, last, specificRole, { status = 'ACTIVE' } = {}) {
  return person(id, first, last, 'SPECIALIST', { status, specificRole });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
  // Defaults: no subscriptions, no assignments. Individual tests opt in.
  mockPrisma.companySubscription.findMany.mockResolvedValue([]);
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.companySpecialistAssignment.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.specificRole.findMany.mockResolvedValue([]);
  realtime.reset();
});

/* ------------------------ GET /admin/company-accounts --------------------- */

describe('GET /admin/company-accounts', () => {
  it('returns companies with their manager and the eligible list exactly once', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findMany.mockResolvedValue([
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() }),
      company({ id: 901, accountingManagerUserId: null, accountingManager: null }),
    ]);
    mockPrisma.company.count.mockResolvedValue(2);
    mockPrisma.user.findMany.mockResolvedValue([
      person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
      person(OTHER_MANAGER_ID, 'Ravi', 'Patel', 'ACCOUNTING_MANAGER'),
    ]);

    const res = await request(app).get('/api/admin/company-accounts').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.companies).toHaveLength(2);

    // The assigned company names its manager AND their email, so the row can be
    // drawn without a second request.
    expect(res.body.data.companies[0].accountingManager).toMatchObject({
      userId: MANAGER_ID,
      firstName: 'Sarah',
      email: 'sarah.jones@finopsys.ai',
    });
    // The unassigned one says so explicitly rather than omitting the key.
    expect(res.body.data.companies[1].accountingManager).toBeNull();

    // The eligible collection is returned ONCE, alongside the companies — not
    // duplicated onto every row.
    expect(res.body.data.accountingManagers).toHaveLength(2);
    expect(res.body.data.companies[0].accountingManagers).toBeUndefined();
    expect(res.body.data.pagination).toMatchObject({ total: 2, hasMore: false });

    // Only ACTIVE users holding the role are offered.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACTIVE', role: { code: 'ACCOUNTING_MANAGER' } },
      })
    );
  });

  it('returns active services, the billing date and the team for each row', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findMany.mockResolvedValue([
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() }),
    ]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.companySubscription.findMany.mockResolvedValue([subscription()]);
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      {
        id: 8001, companyId: COMPANY_ID, specialistUserId: 77,
        specialist: { id: 77, firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@finopsys.ai' },
        specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
      },
    ]);

    const res = await request(app).get('/api/admin/company-accounts').set('Authorization', auth());
    const row = res.body.data.companies[0];

    expect(res.status).toBe(200);

    // Grouped by SERVICE, not by plan: payroll is three line items but one service.
    expect(row.activeServices.map((s) => s.specializationCode).sort()).toEqual(['BOOKKEEPING', 'PAYROLL']);
    const payroll = row.activeServices.find((s) => s.specializationCode === 'PAYROLL');
    expect(payroll.planCode).toBe('PAYROLL_BASE');
    // The head count arrives named, with the label the catalog already stores.
    expect(payroll.addOns).toEqual([
      expect.objectContaining({
        planCode: 'PAYROLL_W2_EMPLOYEE',
        component: 'employees',
        quantityLabel: 'Number of W-2 Employees',
        quantity: 3,
      }),
    ]);
    // Zero contractors is not a service the company has.
    expect(payroll.addOns.some((a) => a.component === 'contractors')).toBe(false);

    // Billing date = the end of the paid period.
    expect(row.billing).toMatchObject({ subscriptionId: 7001, status: 'ACTIVE' });
    expect(row.billing.currentPeriodEnd).toBe('2026-08-30T05:09:21.000Z');

    // Team: owner + accounting manager + specialists, and a server-side count.
    expect(row.teamMembers.owner.userId).toBe(OWNER_ID);
    expect(row.teamMembers.accountingManager.userId).toBe(MANAGER_ID);
    expect(row.teamMembers.specialists[0]).toMatchObject({ userId: 77, firstName: 'Jane' });
    expect(row.teamMemberCount).toBe(3);

    // Batched: one query for every company's subscription, one for every team —
    // not one pair per row.
    expect(mockPrisma.companySubscription.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.companySpecialistAssignment.findMany).toHaveBeenCalledTimes(1);
  });

  it('reports a company with no subscription as having no services or billing date', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findMany.mockResolvedValue([company()]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/admin/company-accounts').set('Authorization', auth());
    const row = res.body.data.companies[0];

    // Onboarded but never checked out is a real state, not an error.
    expect(row.activeServices).toEqual([]);
    expect(row.billing).toBeNull();
    expect(row.teamMemberCount).toBe(1); // the owner
  });

  it('never returns a password hash or login-security column', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findMany.mockResolvedValue([company()]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER')]);

    const res = await request(app).get('/api/admin/company-accounts').set('Authorization', auth());

    const body = JSON.stringify(res.body);
    for (const forbidden of ['passwordHash', 'password_hash', 'lockedUntil', 'failedLoginAttempts', 'lastLoginIpHash']) {
      expect(body).not.toContain(forbidden);
    }
    // The select itself is what guarantees it — assert on the query too, so a
    // future `include: { user: true }` cannot pass this test by luck.
    const select = mockPrisma.user.findMany.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
  });

  it('refuses an ACCOUNTING_MANAGER — their view is /accounting-manager/companies (403)', async () => {
    // This screen is the ADMIN's appointment table: every company, plus the
    // eligible managers for the assign control. A manager's own accounts are a
    // different, richer endpoint.
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });

    const res = await request(app)
      .get('/api/admin/company-accounts')
      .set('Authorization', auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER' }));

    expect(res.status).toBe(403);
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
  });

  it('refuses a customer (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });

    const res = await request(app)
      .get('/api/admin/company-accounts')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }));

    expect(res.status).toBe(403);
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller (401)', async () => {
    const res = await request(app).get('/api/admin/company-accounts');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('refuses a caller whose token claims ADMIN but whose database row does not', async () => {
    // Authorization is the backend's decision, taken against the database. A
    // forged or stale claim is not enough, and neither is a hidden frontend route.
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });

    const res = await request(app)
      .get('/api/admin/company-accounts')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'ADMIN' }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_ROLE_REQUIRED');
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
  });
});

/* ------------------- GET /accounting-manager/companies -------------------- */

describe('GET /accounting-manager/companies', () => {
  it('returns the manager’s accounts with priced plans, billing and members', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findMany.mockResolvedValue([
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() }),
    ]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.companySubscription.findMany.mockResolvedValue([pricedSubscription()]);
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      {
        id: 8001, companyId: COMPANY_ID, specialistUserId: 71, assignedAt: new Date('2026-08-01T00:00:00Z'),
        specialist: { id: 71, firstName: 'Bea', lastName: 'Books', email: 'bea.books@finopsys.ai', jobTitle: 'Bookkeeping Specialist' },
        specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
      },
    ]);

    const res = await request(app)
      .get('/api/accounting-manager/companies')
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    const [account] = res.body.data.companies;
    expect(account.accessRole).toBe('ACCOUNTING_MANAGER');

    // Priced plans, from the amount captured at PURCHASE.
    const bookkeeping = account.servicePlans.find((s) => s.specializationCode === 'BOOKKEEPING');
    expect(bookkeeping).toMatchObject({ planCode: 'BOOKKEEPING_GROWTH', currency: 'USD' });
    expect(bookkeeping.lines[0]).toMatchObject({
      unitAmountMinor: 24900,
      quantity: 1,
      totalAmountMinor: 24900,
      billingInterval: 'MONTH',
    });

    // Payroll: base + a per-employee line, totalled across the service.
    const payroll = account.servicePlans.find((s) => s.specializationCode === 'PAYROLL');
    expect(payroll.lines).toHaveLength(2);
    expect(payroll.totalAmountMinor).toBe(9900 + 3 * 1500);

    // Billing period.
    expect(account.billing.currentPeriodEnd).toBe('2026-08-30T05:09:21.000Z');

    // Members, with the job title and when the assignment started.
    expect(account.members.owner.userId).toBe(OWNER_ID);
    expect(account.members.accountingManager.userId).toBe(MANAGER_ID);
    expect(account.members.specialists[0]).toMatchObject({
      userId: 71,
      jobTitle: 'Bookkeeping Specialist',
    });
    expect(account.members.specialists[0].specializations[0]).toMatchObject({
      assignmentId: 8001,
      specializationCode: 'BOOKKEEPING',
      assignedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(account.members.total).toBe(3);

    // Scoped to the accounts this user MANAGES — not the broader "can see" rule.
    const [args] = mockPrisma.company.findMany.mock.calls[0];
    expect(args.where.accountingManagerUserId).toBe(MANAGER_ID);
    expect(args.where.OR).toBeUndefined();
  });

  it('never returns a password hash or login-security column', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findMany.mockResolvedValue([
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() }),
    ]);
    mockPrisma.company.count.mockResolvedValue(1);
    mockPrisma.companySubscription.findMany.mockResolvedValue([pricedSubscription()]);

    const res = await request(app)
      .get('/api/accounting-manager/companies')
      .set('Authorization', managerAuth());

    const body = JSON.stringify(res.body);
    for (const forbidden of ['passwordHash', 'password_hash', 'lockedUntil', 'failedLoginAttempts', 'lastLoginIpHash']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('refuses an ADMIN — the admin table is theirs, this is not (403)', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });

    const res = await request(app)
      .get('/api/accounting-manager/companies')
      .set('Authorization', auth());

    expect(res.status).toBe(403);
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
  });

  it('refuses a customer (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });

    const res = await request(app)
      .get('/api/accounting-manager/companies')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }));

    expect(res.status).toBe(403);
  });
});

/* --------------- GET /companies/:id/specialist-options -------------------- */

/**
 * Staffing specialists belongs to the company's OWN accounting manager — not to
 * an admin, and not to the owner. These suites therefore act as MANAGER_ID, and
 * the company fixture names them as its accounting manager.
 */
function managerAuth(userId = MANAGER_ID) {
  return auth({ userId, role: 'ACCOUNTING_MANAGER', specificRole: null });
}

/** A company staffed by MANAGER_ID, which is what makes the writes below legal. */
function managedCompany(overrides = {}) {
  return company({
    accountingManagerUserId: MANAGER_ID,
    accountingManager: managerPerson(),
    ...overrides,
  });
}

describe('GET /companies/:id/specialist-options', () => {
  const BOOKKEEPER = 71;
  const PAYROLL_SPECIALIST = 72;
  const TAX_SPECIALIST = 73;

  function stageOptions({ services = ['BOOKKEEPING', 'PAYROLL'], assigned = [], companyOverrides = {} } = {}) {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(managedCompany(companyOverrides));
    mockPrisma.companySubscription.findMany.mockResolvedValue([subscription({ services })]);
    // The directory returns everyone eligible for ANY of the required roles; the
    // service is what splits them per service.
    mockPrisma.user.findMany.mockResolvedValue([
      specialist(BOOKKEEPER, 'Bea', 'Books', 'SPECIALIST_3'),
      specialist(PAYROLL_SPECIALIST, 'Pat', 'Pay', 'SPECIALIST_1'),
      specialist(TAX_SPECIALIST, 'Tia', 'Tax', 'SPECIALIST_2'),
    ]);
    mockPrisma.specificRole.findMany.mockResolvedValue([
      { id: 3, code: 'SPECIALIST_1', name: 'Payroll Specialist' },
      { id: 5, code: 'SPECIALIST_3', name: 'Bookkeeping Specialist' },
    ]);
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue(assigned);
  }

  it('returns one dropdown per active service, each with its OWN eligible list', async () => {
    stageOptions();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    // Two active services -> two assignments required. The server counts, not the client.
    expect(res.body.data.requiredAssignmentCount).toBe(2);

    const bookkeeping = res.body.data.services.find((s) => s.specializationCode === 'BOOKKEEPING');
    const payroll = res.body.data.services.find((s) => s.specializationCode === 'PAYROLL');

    expect(bookkeeping.requiredSpecificRole).toBe('SPECIALIST_3');
    expect(bookkeeping.requiredSpecificRoleName).toBe('Bookkeeping Specialist');
    expect(payroll.requiredSpecificRole).toBe('SPECIALIST_1');

    // A Tax Specialist must never appear in the bookkeeping dropdown — the lists
    // are separated by the server, not filtered by the client.
    expect(bookkeeping.eligibleSpecialists.map((u) => u.userId)).toEqual([BOOKKEEPER]);
    expect(payroll.eligibleSpecialists.map((u) => u.userId)).toEqual([PAYROLL_SPECIALIST]);
    expect(JSON.stringify(res.body)).not.toContain(String(TAX_SPECIALIST));

    // Only ACTIVE specialists holding one of the required roles were queried.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          role: { code: 'SPECIALIST' },
          specificRole: { code: { in: expect.arrayContaining(['SPECIALIST_3', 'SPECIALIST_1']) } },
        }),
      })
    );
  });

  it('reports who currently holds each service, from the standing column', async () => {
    stageOptions({
      companyOverrides: {
        bookkeepingSpecialistUserId: BOOKKEEPER,
        bookkeepingSpecialist: { id: BOOKKEEPER, firstName: 'Bea', lastName: 'Books', email: 'bea.books@finopsys.ai' },
      },
      assigned: [
        {
          id: 8001, companyId: COMPANY_ID, specializationId: 1, specialistUserId: BOOKKEEPER,
          specialist: { id: BOOKKEEPER, firstName: 'Bea', lastName: 'Books', email: 'bea.books@finopsys.ai' },
          specialization: { specializationCode: 'BOOKKEEPING' },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth());

    const bookkeeping = res.body.data.services.find((s) => s.specializationCode === 'BOOKKEEPING');
    const payroll = res.body.data.services.find((s) => s.specializationCode === 'PAYROLL');
    // The assignment row supplies the assignmentId; the column decides WHO.
    expect(bookkeeping.assigned).toEqual([
      expect.objectContaining({ assignmentId: 8001, userId: BOOKKEEPER, email: 'bea.books@finopsys.ai' }),
    ]);
    expect(payroll.assigned).toEqual([]);
  });

  it('prefers the standing column over a stale assignment row', async () => {
    /*
     * company_specialist_assignments deliberately permits several ACTIVE rows for
     * one specialization — it is a record of work, not of responsibility — so
     * reading the dropdown's current value from it would mean picking a winner.
     * companies.bookkeeping_specialist_user_id is the answer to "exactly one".
     */
    stageOptions({
      companyOverrides: {
        bookkeepingSpecialistUserId: BOOKKEEPER,
        bookkeepingSpecialist: { id: BOOKKEEPER, firstName: 'Bea', lastName: 'Books', email: 'bea.books@finopsys.ai' },
      },
      assigned: [
        {
          id: 8001, companyId: COMPANY_ID, specializationId: 1, specialistUserId: BOOKKEEPER,
          specialist: { id: BOOKKEEPER, firstName: 'Bea', lastName: 'Books', email: 'bea.books@finopsys.ai' },
          specialization: { specializationCode: 'BOOKKEEPING' },
        },
        {
          id: 8002, companyId: COMPANY_ID, specializationId: 1, specialistUserId: 99,
          specialist: { id: 99, firstName: 'Stale', lastName: 'Row', email: 'stale@finopsys.ai' },
          specialization: { specializationCode: 'BOOKKEEPING' },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth());

    const bookkeeping = res.body.data.services.find((s) => s.specializationCode === 'BOOKKEEPING');
    expect(bookkeeping.assigned).toHaveLength(1);
    expect(bookkeeping.assigned[0].userId).toBe(BOOKKEEPER);
  });

  it('returns no services for a company with no active subscription', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findFirst.mockResolvedValue(managedCompany());

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.requiredAssignmentCount).toBe(0);
    expect(res.body.data.services).toEqual([]);
  });

  it('404s for a company that does not exist', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMPANY_NOT_FOUND');
  });

  it('lets an ADMIN read it, but only to look', async () => {
    // An admin already sees the team on the company table, so the picker is not
    // secret from them. The WRITE is what they cannot do — see the PUT suite.
    stageOptions();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.requiredAssignmentCount).toBe(2);
  });

  it('refuses an accounting manager who is not on this account (403)', async () => {
    stageOptions();
    stageUsers({ [OTHER_MANAGER_ID]: person(OTHER_MANAGER_ID, 'Ravi', 'Patel', 'ACCOUNTING_MANAGER') });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', managerAuth(OTHER_MANAGER_ID));

    // Holding the role makes you eligible to be assigned; it does not make you
    // responsible for every company in the system.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_COMPANY_ACCOUNTING_MANAGER');
  });

  it('refuses the company owner (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/specialist-options`)
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }));

    expect(res.status).toBe(403);
  });
});

/* ------------------ PUT /companies/:id/specialists ------------------------ */

describe('PUT /companies/:id/specialists', () => {
  const BOOKKEEPER = 71;
  const PAYROLL_SPECIALIST = 72;
  const TAX_SPECIALIST = 73;

  function stageAssign({ services = ['BOOKKEEPING', 'PAYROLL'], users = {} } = {}) {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
      [OTHER_MANAGER_ID]: person(OTHER_MANAGER_ID, 'Ravi', 'Patel', 'ACCOUNTING_MANAGER'),
      [BOOKKEEPER]: specialist(BOOKKEEPER, 'Bea', 'Books', 'SPECIALIST_3'),
      [PAYROLL_SPECIALIST]: specialist(PAYROLL_SPECIALIST, 'Pat', 'Pay', 'SPECIALIST_1'),
      [TAX_SPECIALIST]: specialist(TAX_SPECIALIST, 'Tia', 'Tax', 'SPECIALIST_2'),
      ...users,
    });
    mockPrisma.company.findFirst.mockResolvedValue(managedCompany());
    mockPrisma.companySubscription.findMany.mockResolvedValue([subscription({ services })]);
    mockPrisma.companySpecialistAssignment.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 9000 + data.specializationId, ...data })
    );
  }

  const bothServices = {
    assignments: [
      { specializationCode: 'BOOKKEEPING', specialistUserId: BOOKKEEPER },
      { specializationCode: 'PAYROLL', specialistUserId: PAYROLL_SPECIALIST },
    ],
  };

  it('saves one specialist per active service in a single transaction', async () => {
    stageAssign();
    const events = [];
    const unsubscribe = realtime.subscribe(fakeStream(events), { userId: ADMIN_ID });

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send(bothServices);
    unsubscribe();

    expect(res.status).toBe(200);
    expect(res.body.data.assignmentCount).toBe(2);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.companySpecialistAssignment.create).toHaveBeenCalledTimes(2);

    // Whoever previously held each service is stood down in the same transaction,
    // so the company is never covered by two specialists for one service.
    expect(mockPrisma.companySpecialistAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: COMPANY_ID, assignmentStatus: 'ACTIVE' }),
        data: expect.objectContaining({ assignmentStatus: 'INACTIVE' }),
      })
    );

    // The standing-specialist columns on `companies` are written in the SAME
    // transaction as the assignment rows, so the grid's per-line columns and the
    // work record can never disagree.
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COMPANY_ID },
        data: { bookkeepingSpecialistUserId: BOOKKEEPER, payrollSpecialistUserId: PAYROLL_SPECIALIST },
      })
    );

    expect(events.some((e) => e.event === 'company.team.changed')).toBe(true);
  });

  it('refuses a specialist whose role does not match the service (422)', async () => {
    stageAssign();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({
        assignments: [
          // A Tax Specialist on the company's bookkeeping.
          { specializationCode: 'BOOKKEEPING', specialistUserId: TAX_SPECIALIST },
          { specializationCode: 'PAYROLL', specialistUserId: PAYROLL_SPECIALIST },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SPECIALIST_ROLE_MISMATCH');
    expect(res.body.error.details).toMatchObject({
      requiredSpecificRole: 'SPECIALIST_3',
      actualSpecificRole: 'SPECIALIST_2',
    });
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses a deactivated specialist (422)', async () => {
    stageAssign({
      users: { [BOOKKEEPER]: specialist(BOOKKEEPER, 'Bea', 'Books', 'SPECIALIST_3', { status: 'HIBERNATED' }) },
    });

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send(bothServices);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INACTIVE_SPECIALIST');
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses a service the company is not paying for (422)', async () => {
    stageAssign({ services: ['BOOKKEEPING'] }); // no payroll

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send(bothServices);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SERVICE_NOT_ACTIVE');
    expect(res.body.error.details.specializationCode).toBe('PAYROLL');
  });

  it('refuses a partial submission that leaves a service unstaffed (422)', async () => {
    stageAssign();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ assignments: [{ specializationCode: 'BOOKKEEPING', specialistUserId: BOOKKEEPER }] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INCOMPLETE_SPECIALIST_ASSIGNMENTS');
    expect(res.body.error.details).toMatchObject({ required: 2, received: 1 });
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects the same service twice, and the same specialist twice (400)', async () => {
    stageAssign();

    const duplicateService = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({
        assignments: [
          { specializationCode: 'BOOKKEEPING', specialistUserId: BOOKKEEPER },
          { specializationCode: 'BOOKKEEPING', specialistUserId: PAYROLL_SPECIALIST },
        ],
      });
    expect(duplicateService.status).toBe(400);
    expect(duplicateService.body.error.details.duplicateSpecializationCode).toBe('BOOKKEEPING');

    const duplicatePerson = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({
        assignments: [
          { specializationCode: 'BOOKKEEPING', specialistUserId: BOOKKEEPER },
          { specializationCode: 'PAYROLL', specialistUserId: BOOKKEEPER },
        ],
      });
    expect(duplicatePerson.status).toBe(400);
    expect(duplicatePerson.body.error.details.duplicateSpecialistUserId).toBe(BOOKKEEPER);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the company owner (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }))
      .send(bothServices);

    expect(res.status).toBe(403);
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN — appointing the manager is theirs, staffing is not', async () => {
    /*
     * The two writes are deliberately held by different people. An admin assigns
     * the ACCOUNTING MANAGER; the manager then staffs their own accounts. If an
     * admin could do both, splitting them would mean nothing.
     */
    stageAssign();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', auth())
      .send(bothServices);

    // Refused at the route's role gate, so the code is the generic FORBIDDEN
    // rather than the service's ACCOUNTING_MANAGER_ROLE_REQUIRED — an admin does
    // not hold the role at all, so they never reach the per-company check.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses an accounting manager who is not on this account (403)', async () => {
    stageAssign();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth(OTHER_MANAGER_ID))
      .send(bothServices);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_COMPANY_ACCOUNTING_MANAGER');
    expect(mockPrisma.companySpecialistAssignment.create).not.toHaveBeenCalled();
  });
});

/* -------------------- PUT /companies/:id/accounting-manager --------------- */

describe('PUT /companies/:id/accounting-manager', () => {
  it('assigns and returns the manager’s name and email for the row', async () => {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.company.update.mockResolvedValue(
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() })
    );

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accountingManagerUserId: MANAGER_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.company.accountingManagerUserId).toBe(MANAGER_ID);
    expect(res.body.data.company.accountingManager).toMatchObject({
      userId: MANAGER_ID,
      firstName: 'Sarah',
      lastName: 'Jones',
      email: 'sarah.jones@finopsys.ai',
    });
    // Validation and write happen in one transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses a manager whose account is not ACTIVE (422)', async () => {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER', { status: 'HIBERNATED' }),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accountingManagerUserId: MANAGER_ID });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INACTIVE_ACCOUNTING_MANAGER');
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('refuses a user who does not exist (404)', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accountingManagerUserId: 12345 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('replaces an existing manager and reports the previous one to listeners', async () => {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [OTHER_MANAGER_ID]: person(OTHER_MANAGER_ID, 'Ravi', 'Patel', 'ACCOUNTING_MANAGER'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() })
    );
    mockPrisma.company.update.mockResolvedValue(
      company({
        accountingManagerUserId: OTHER_MANAGER_ID,
        accountingManager: { id: OTHER_MANAGER_ID, firstName: 'Ravi', lastName: 'Patel', email: 'ravi.patel@finopsys.ai' },
      })
    );

    const events = [];
    const unsubscribe = realtime.subscribe(fakeStream(events), { userId: ADMIN_ID });

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accountingManagerUserId: OTHER_MANAGER_ID });
    unsubscribe();

    expect(res.status).toBe(200);
    expect(res.body.data.company.accountingManagerUserId).toBe(OTHER_MANAGER_ID);

    const assigned = events.find((e) => e.event === 'company.accounting_manager.assigned');
    expect(assigned).toBeDefined();
    expect(assigned.data.previousAccountingManagerUserId).toBe(MANAGER_ID);
    expect(assigned.data.company.accountingManager.userId).toBe(OTHER_MANAGER_ID);
  });
});

/* ------------------ DELETE /companies/:id/accounting-manager -------------- */

describe('DELETE /companies/:id/accounting-manager', () => {
  it('removes the assignment and publishes the change (200)', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: managerPerson() })
    );
    mockPrisma.company.update.mockResolvedValue(company({ accountingManagerUserId: null, accountingManager: null }));

    const events = [];
    const unsubscribe = realtime.subscribe(fakeStream(events), { userId: ADMIN_ID });

    const res = await request(app)
      .delete(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth());
    unsubscribe();

    expect(res.status).toBe(200);
    expect(res.body.data.company.accountingManagerUserId).toBeNull();
    expect(res.body.data.company.accountingManager).toBeNull();
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COMPANY_ID }, data: { accountingManagerUserId: null } })
    );

    const removed = events.find((e) => e.event === 'company.accounting_manager.removed');
    expect(removed.data.previousAccountingManagerUserId).toBe(MANAGER_ID);
  });

  it('is idempotent when there is no manager to remove', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .delete(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('refuses the company owner — removal is an ADMIN decision (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }) });
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));

    const res = await request(app)
      .delete(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }));

    expect(res.status).toBe(403);
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });
});

/* --------------------- inheritance at company creation -------------------- */

describe('POST /onboarding/company — accounting-manager inheritance', () => {
  const ownerRow = person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' });

  function body() {
    return {
      companyName: 'Second Venture LLC',
      companyType: 'LIMITED_LIABILITY_COMPANY',
      companyEmail: 'accounts@secondventure.com',
      companyPhone: '+1 555 123 4567',
      employeeCount: 4,
      lastYearRevenue: '250000.00',
      revenueCurrency: 'USD',
      address: {
        addressLine1: '1 Congress Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'United States',
        countryCode: 'US',
      },
    };
  }

  /**
   * company.findFirst backs three different questions here. Route by the shape
   * of the where clause so each gets its own answer.
   */
  function stageOnboarding({ inheritanceSource }) {
    stageUsers({ [OWNER_ID]: ownerRow });
    mockPrisma.company.findFirst.mockImplementation(({ where }) => {
      if (where.companyEmail) return Promise.resolve(null); // email is free
      if (where.accountingManager) return Promise.resolve(inheritanceSource); // inheritance lookup
      return Promise.resolve(null);
    });
    mockPrisma.address.create.mockResolvedValue({ id: 500, line1: '1 Congress Ave', city: 'Austin', country: 'United States' });

    // The finalize update must return the row as the database would — with the
    // columns the insert set, not a fresh default. Track what was created.
    let created = null;
    mockPrisma.company.create.mockImplementation(({ data }) => {
      created = company({ id: 902, ...data, status: 'ONBOARDING' });
      return Promise.resolve(created);
    });
    mockPrisma.companyAddress.create.mockResolvedValue({ id: 701 });
    mockPrisma.company.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...created, ...data })
    );
  }

  it('inherits the manager from the creator’s oldest eligible company', async () => {
    stageOnboarding({
      inheritanceSource: {
        id: 800,
        accountingManagerUserId: MANAGER_ID,
        accountingManager: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
      },
    });

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }))
      .send(body());

    expect(res.status).toBe(201);
    // Assigned as part of the CREATE, inside the same transaction — the company
    // is never briefly unassigned.
    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ accountingManagerUserId: MANAGER_ID }) })
    );
    expect(res.body.data.company.accountingManagerUserId).toBe(MANAGER_ID);
    expect(res.body.data.accountingManager).toMatchObject({ userId: MANAGER_ID, email: 'sarah.jones@finopsys.ai' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // Oldest first, live companies only, and the manager's eligibility is part
    // of the query rather than an afterthought.
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerUserId: OWNER_ID,
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          accountingManager: { is: { status: 'ACTIVE', role: { code: 'ACCOUNTING_MANAGER' } } },
        }),
        orderBy: { createdAt: 'asc' },
      })
    );
  });

  it('creates the company unassigned when the creator has no eligible manager', async () => {
    stageOnboarding({ inheritanceSource: null });

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }))
      .send(body());

    expect(res.status).toBe(201);
    expect(res.body.data.accountingManager).toBeNull();
    const createData = mockPrisma.company.create.mock.calls[0][0].data;
    expect(createData.accountingManagerUserId).toBeUndefined();
  });

  it('does not inherit a manager who has lost the role since that assignment', async () => {
    // The relation filter would not return this row in production; the service
    // re-asserts eligibility on what it is handed, so the rule survives a
    // loosened query too.
    stageOnboarding({
      inheritanceSource: {
        id: 800,
        accountingManagerUserId: MANAGER_ID,
        accountingManager: person(MANAGER_ID, 'Sarah', 'Jones', 'SPECIALIST'),
      },
    });

    const res = await request(app)
      .post('/api/onboarding/company')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }))
      .send(body());

    expect(res.status).toBe(201);
    expect(res.body.data.accountingManager).toBeNull();
    expect(mockPrisma.company.create.mock.calls[0][0].data.accountingManagerUserId).toBeUndefined();
  });
});

/* ----------------------------- real-time channel -------------------------- */

describe('admin real-time channel', () => {
  it('issues a stream ticket to an admin only', async () => {
    stageUsers({
      [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
      [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', { specificRole: 'OWNER' }),
    });

    const ok = await request(app).post('/api/admin/events/ticket').set('Authorization', auth());
    expect(ok.status).toBe(201);
    expect(typeof ok.body.data.ticket).toBe('string');

    const denied = await request(app)
      .post('/api/admin/events/ticket')
      .set('Authorization', auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' }));
    expect(denied.status).toBe(403);
  });

  it('refuses to open the stream without a credential', async () => {
    const res = await request(app).get('/api/admin/events');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_STREAM_TICKET');
  });

  it('refuses a stream ticket that has already been used', async () => {
    const { ticket } = realtime.issueStreamTicket(ADMIN_ID);
    expect(realtime.consumeStreamTicket(ticket)).toBe(ADMIN_ID);
    expect(realtime.consumeStreamTicket(ticket)).toBeNull();
  });

  it('refuses a redeemed ticket whose user is no longer an admin', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'CUSTOMER', { specificRole: 'OWNER' }) });
    const { ticket } = realtime.issueStreamTicket(ADMIN_ID);

    const res = await request(app).get(`/api/admin/events?ticket=${ticket}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('delivers a published event to every live subscriber', () => {
    const a = [];
    const b = [];
    const stopA = realtime.subscribe(fakeStream(a), { userId: ADMIN_ID });
    const stopB = realtime.subscribe(fakeStream(b), { userId: 2 });

    expect(realtime.subscriberCount()).toBe(2);
    realtime.publish('company.updated', { company: { id: COMPANY_ID } });

    stopA();
    stopB();
    expect(realtime.subscriberCount()).toBe(0);

    expect(a).toEqual([{ event: 'company.updated', data: { company: { id: COMPANY_ID } } }]);
    expect(b).toEqual(a);
  });

  it('opens a real SSE connection and delivers events over it', async () => {
    stageUsers({ [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN') });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();

    let received = '';
    const req = http.get(
      { port, path: '/api/admin/events', headers: { Authorization: auth(), Accept: 'text/event-stream' } }
    );

    try {
      const res = await new Promise((resolve, reject) => {
        req.once('response', resolve);
        req.once('error', reject);
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      // No intermediary may buffer or cache a stream.
      expect(res.headers['cache-control']).toMatch(/no-cache/);
      expect(res.headers['x-accel-buffering']).toBe('no');

      const untilSeen = (needle) =>
        new Promise((resolve, reject) => {
          const onData = (chunk) => {
            received += chunk;
            if (received.includes(needle)) {
              res.off('data', onData);
              resolve();
            }
          };
          res.on('data', onData);
          setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 4000).unref();
        });

      // The hello frame arrives before anything is published, and tells the
      // client to (re)load the authoritative page data.
      await untilSeen('event: ready');
      expect(received).toContain('retry: 3000');
      expect(received).toContain('"reloadOnConnect":true');

      // A subscriber registered on the real connection receives what is published.
      expect(realtime.subscriberCount()).toBe(1);
      realtime.publish('company.accounting_manager.removed', { company: { id: COMPANY_ID } });
      await untilSeen('event: company.accounting_manager.removed');
      expect(received).toContain(`"id":${COMPANY_ID}`);
    } finally {
      req.destroy();
      await new Promise((resolve) => server.close(resolve));
    }

    /*
     * The connection closing deregisters it — a dropped admin stops being fanned
     * out to. Polled rather than asserted immediately: 'close' fires on the next
     * turns of the event loop, and asserting straight after destroy() would be
     * testing the timing of Node's socket teardown rather than the cleanup.
     */
    for (let i = 0; realtime.subscriberCount() > 0 && i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(realtime.subscriberCount()).toBe(0);
  });

  it('drops a subscriber whose socket has died rather than failing the write', () => {
    const dead = { write: jest.fn(() => { throw new Error('EPIPE'); }) };
    realtime.subscribe(dead, { userId: ADMIN_ID });

    expect(() => realtime.publish('company.updated', { company: { id: 1 } })).not.toThrow();
    expect(realtime.subscriberCount()).toBe(0);
  });
});

/**
 * A stand-in for the SSE response object: collects the frames written to it and
 * parses them back into { event, data }, which is what a client would see.
 */
function fakeStream(sink) {
  return {
    write(chunk) {
      const event = /^event: (.+)$/m.exec(chunk);
      const data = /^data: (.+)$/m.exec(chunk);
      if (event && data) sink.push({ event: event[1], data: JSON.parse(data[1]) });
      return true;
    },
  };
}
