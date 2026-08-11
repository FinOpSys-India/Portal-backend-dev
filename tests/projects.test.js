'use strict';

/**
 * Integration tests for the project endpoints — the form's service list, the
 * table, creation with its auto-assignment, and the re-staffing sweep — through
 * the real Express app with Prisma mocked.
 *
 * The cases worth having are the ones where the SERVER decides something the
 * request did not say: which specialist a project lands on, which services may
 * be picked at all, and who is allowed to open one.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySubscriptionItem: { findMany: jest.fn() },
  companySpecialistAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  project: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
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

const OWNER_ID = 42;
const MANAGER_ID = 55;
const TEAMMATE_ID = 61;
const BOOKKEEPER_ID = 77;
const OTHER_BOOKKEEPER_ID = 78;
const TAX_SPECIALIST_ID = 88;
const COMPANY_ID = 900;
const PROJECT_ID = 300;

const BOOKKEEPING_PLAN_ID = 5;
const TAX_PLAN_ID = 9;

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const ownerAuth = () => auth();
const managerAuth = () => auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null });
const adminAuth = () => auth({ userId: 1, role: 'ADMIN', specificRole: null });

/*
 * `phone`, `jobTitle` and `ownedCompanies` are here for requirePaidAccount, which
 * gates every /projects route: it asks onboardingService for the caller's status,
 * and an OWNER whose profile is half-filled or whose company carries no paid
 * subscription is refused with a 402 before any route in this file runs.
 *
 * They are on the shared fixture rather than staged per test because being a paid
 * account is the precondition for all of these tests, not the subject of any of
 * them — the paywall has its own suite. A non-owner passes the gate regardless,
 * so the extra fields are harmless for the manager, admin and specialist cases.
 */
function person(id, first, last, role, specificRole = null, overrides = {}) {
  return {
    id,
    firstName: first,
    lastName: last,
    phone: '+1 555 0100',
    jobTitle: 'Founder',
    status: 'ACTIVE',
    role: { code: role },
    specificRole: specificRole ? { code: specificRole } : null,
    ownedCompanies: [{ id: COMPANY_ID, subscriptions: [{ id: 1 }] }],
    ...overrides,
  };
}

function company(overrides = {}) {
  return {
    id: COMPANY_ID,
    companyName: 'ABC Aerospace LLC',
    ownerUserId: OWNER_ID,
    accountingManagerUserId: MANAGER_ID,
    bookkeepingSpecialistUserId: BOOKKEEPER_ID,
    payrollSpecialistUserId: null,
    taxSpecialistUserId: null,
    ...overrides,
  };
}

/** Rows as projectRepository.listPurchasedPlans returns them. */
function purchasedPlans() {
  return [
    {
      quantity: 1,
      servicePlan: {
        id: BOOKKEEPING_PLAN_ID,
        planCode: 'BOOKKEEPING_GROWTH',
        planName: 'Bookkeeping — Growth',
        isAddOn: false,
        quantityLabel: null,
        specializationId: 1,
        specialization: { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
      },
    },
    {
      quantity: 12,
      servicePlan: {
        id: 6,
        planCode: 'PAYROLL_W2_EMPLOYEE',
        planName: 'W-2 Employee',
        isAddOn: true,
        quantityLabel: 'Number of W-2 Employees',
        specializationId: 2,
        specialization: { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll' },
      },
    },
    {
      quantity: 1,
      servicePlan: {
        id: 7,
        planCode: 'PAYROLL_BASE',
        planName: 'Payroll — Standard',
        isAddOn: false,
        quantityLabel: null,
        specializationId: 2,
        specialization: { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll' },
      },
    },
  ];
}

/**
 * The tax line, as an extra subscription item.
 *
 * Kept out of the default fixture on purpose: the base company subscribes to
 * bookkeeping and payroll, so a test that adds this one is visibly testing "a
 * company that ALSO has tax" rather than relying on a fixture that quietly
 * carries everything.
 */
function taxPlan() {
  return {
    quantity: 1,
    servicePlan: {
      id: TAX_PLAN_ID,
      planCode: 'TAX_500K_TO_2M',
      planName: 'Tax - $500K to $2M Revenue',
      isAddOn: false,
      quantityLabel: null,
      specializationId: 3,
      specialization: { id: 3, specializationCode: 'TAX', specializationName: 'Tax' },
    },
  };
}

/** A row as projectRepository's PROJECT_SELECT returns it. */
function projectRow(overrides = {}) {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    projectName: 'Q4 Books Close',
    deadlineDate: new Date('2026-12-31T00:00:00.000Z'),
    servicePlanId: BOOKKEEPING_PLAN_ID,
    assignedSpecialistUserId: BOOKKEEPER_ID,
    createdByUserId: OWNER_ID,
    status: 'TODO',
    // NUMERIC(5,2) — the driver hands these back as strings, not numbers, which
    // is the whole reason the DTO converts rather than passing them through.
    progressBar: '0.00',
    description: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    company: { id: COMPANY_ID, companyName: 'ABC Aerospace LLC' },
    servicePlan: {
      id: BOOKKEEPING_PLAN_ID,
      planCode: 'BOOKKEEPING_GROWTH',
      planName: 'Bookkeeping — Growth',
      specialization: { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
    },
    assignedSpecialist: {
      id: BOOKKEEPER_ID,
      firstName: 'Bella',
      lastName: 'Keeper',
      email: 'bella@finopsys.ai',
      jobTitle: 'Bookkeeping Specialist',
      avatarKey: null,
      specificRole: { code: 'SPECIALIST_3' },
    },
    createdBy: {
      id: OWNER_ID,
      firstName: 'John',
      lastName: 'Smith',
      email: 'john@abc.com',
      jobTitle: 'Founder',
      avatarKey: null,
    },
    ...overrides,
  };
}

function stageUsers(map) {
  mockPrisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(map[where.id] ?? null));
}

/*
 * The specialist bench, and a real filter over it.
 *
 * The eligibility query is the half of the auto-assignment that decides whether
 * a candidate MATCHES THE SERVICE, so stubbing it to a fixed array would test
 * nothing. This applies the same three conditions the repository sends —
 * status, role, specific role — against the bench below, which is what lets a
 * test say "put a tax specialist in the bookkeeping column" and get the real
 * answer back.
 */
const BENCH = {
  [BOOKKEEPER_ID]: { id: BOOKKEEPER_ID, status: 'ACTIVE', role: 'SPECIALIST', specificRole: 'SPECIALIST_3' },
  [OTHER_BOOKKEEPER_ID]: { id: OTHER_BOOKKEEPER_ID, status: 'ACTIVE', role: 'SPECIALIST', specificRole: 'SPECIALIST_3' },
  [TAX_SPECIALIST_ID]: { id: TAX_SPECIALIST_ID, status: 'ACTIVE', role: 'SPECIALIST', specificRole: 'SPECIALIST_2' },
};

function stageBench(bench = BENCH) {
  mockPrisma.user.findMany.mockImplementation(({ where }) =>
    Promise.resolve(
      (where.id?.in ?? [])
        .map((id) => bench[id])
        .filter(Boolean)
        .filter((p) => p.status === where.status)
        .filter((p) => p.role === where.role?.code)
        .filter((p) => !where.specificRole || p.specificRole === where.specificRole.code)
        .map((p) => ({ id: p.id }))
    )
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

  stageUsers({
    [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER'),
    [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    [TEAMMATE_ID]: person(TEAMMATE_ID, 'Raj', 'Patel', 'CUSTOMER', 'TEAM'),
    [BOOKKEEPER_ID]: person(BOOKKEEPER_ID, 'Ada', 'Hopper', 'SPECIALIST', 'SPECIALIST_3'),
    1: person(1, 'Root', 'Admin', 'ADMIN'),
  });
  mockPrisma.company.findFirst.mockResolvedValue(company());
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.companySubscriptionItem.findMany.mockResolvedValue(purchasedPlans());
  stageBench();
});

/* ------------------------------ the form list ----------------------------- */

describe('GET /projects/services', () => {
  it('returns one entry per purchased service, keyed by the base plan (200)', async () => {
    const res = await request(app)
      .get(`/api/projects/services?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.services).toEqual([
      expect.objectContaining({
        servicePlanId: BOOKKEEPING_PLAN_ID,
        serviceCode: 'BOOKKEEPING',
        serviceName: 'Bookkeeping',
      }),
      expect.objectContaining({ servicePlanId: 7, serviceCode: 'PAYROLL', serviceName: 'Payroll' }),
    ]);
    // The add-on rides along on its service rather than becoming a service.
    expect(res.body.data.services[1].addOns).toEqual([
      expect.objectContaining({ planCode: 'PAYROLL_W2_EMPLOYEE', quantity: 12 }),
    ]);
  });

  it('includes tax when the company subscribes to it (200)', async () => {
    mockPrisma.companySubscriptionItem.findMany.mockResolvedValue([...purchasedPlans(), taxPlan()]);

    const res = await request(app)
      .get(`/api/projects/services?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.services.map((s) => s.serviceCode)).toEqual([
      'BOOKKEEPING',
      'PAYROLL',
      'TAX',
    ]);
    expect(res.body.data.services[2]).toEqual(
      expect.objectContaining({ specializationId: 3, servicePlanId: TAX_PLAN_ID, serviceName: 'Tax' })
    );
  });

  it('requires companyId (400)', async () => {
    const res = await request(app).get('/api/projects/services').set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyId).toBeDefined();
  });

  it('refuses a caller with no route to the company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ ownerUserId: 999, accountingManagerUserId: 998, bookkeepingSpecialistUserId: null })
    );

    const res = await request(app)
      .get(`/api/projects/services?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });
});

/* -------------------------------- the table ------------------------------- */

describe('GET /projects', () => {
  it('returns the table, the service list, and paging (200)', async () => {
    mockPrisma.project.findMany.mockResolvedValue([projectRow()]);
    mockPrisma.project.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    const [row] = res.body.data.projects;
    expect(row).toEqual(
      expect.objectContaining({
        projectName: 'Q4 Books Close',
        companyName: 'ABC Aerospace LLC',
        // A DATE column, serialised as the calendar day it holds — never an
        // ISO timestamp that a client west of UTC would render as the 30th.
        deadlineDate: '2026-12-31',
        status: 'TODO',
      })
    );
    expect(row.service).toEqual(expect.objectContaining({ serviceCode: 'BOOKKEEPING' }));
    expect(row.createdBy).toEqual(expect.objectContaining({ name: 'John Smith' }));
    // A JSON number, not the Decimal object or the "0.00" string the column
    // yields — this goes straight into a bar width.
    expect(row.progressBar).toBe(0);
    // Who is doing the work, with the KIND of specialist they are — a tax
    // specialist and a bookkeeper are not interchangeable, so the code travels
    // with the name.
    expect(row.specialist).toEqual(
      expect.objectContaining({
        id: BOOKKEEPER_ID,
        name: 'Bella Keeper',
        specificRole: 'SPECIALIST_3',
      })
    );
  });

  /*
   * An unstaffed line is a real state, not missing data, so the field has to be
   * present and null rather than absent — a client that renders "Unassigned"
   * needs something to key off.
   */
  it('reports specialist: null on a project nobody is staffed on', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID, 'Ada', 'Hopper', 'CUSTOMER', 'OWNER'));
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.companySubscriptionItem.findMany.mockResolvedValue(purchasedPlans());
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ assignedSpecialistUserId: null, assignedSpecialist: null }),
    ]);
    mockPrisma.project.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.projects[0].specialist).toBeNull();
    expect(res.body.data.services).toHaveLength(2);
    expect(res.body.data.pagination).toEqual({ total: 1, limit: 25, offset: 0, hasMore: false });
  });

  it('orders by deadline ascending unless told otherwise', async () => {
    mockPrisma.project.findMany.mockResolvedValue([]);
    mockPrisma.project.count.mockResolvedValue(0);

    await request(app).get(`/api/projects?company_id=${COMPANY_ID}`).set('Authorization', ownerAuth());

    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ deadlineDate: 'asc' }, { id: 'desc' }] })
    );
  });

  it('lets a teammate on the account read it (200)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ ownerUserId: 999 }));
    mockPrisma.companyMember.findFirst.mockResolvedValue({ id: 3 });
    mockPrisma.project.findMany.mockResolvedValue([]);
    mockPrisma.project.count.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID, specificRole: 'TEAM' }));

    expect(res.status).toBe(200);
  });

  it('returns the stored progress, decimals and all (200)', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ status: 'ACTIVE', progressBar: '42.50' }),
    ]);
    mockPrisma.project.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.body.data.projects[0].progressBar).toBe(42.5);
    // status and progress are independent — nothing derives one from the other.
    expect(res.body.data.projects[0].status).toBe('ACTIVE');
  });

  it('does not derive progress from status (200)', async () => {
    // COMPLETED at 0% is a state the API reports rather than corrects: the
    // column is the truth, and no rule links the two.
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ status: 'COMPLETED', progressBar: '0.00' }),
    ]);
    mockPrisma.project.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.body.data.projects[0]).toEqual(
      expect.objectContaining({ status: 'COMPLETED', progressBar: 0 })
    );
  });
});

/* ------------------------------- creation --------------------------------- */

describe('POST /projects', () => {
  const body = {
    company_id: COMPANY_ID,
    project_name: 'Q4 Books Close',
    deadline_date: '2026-12-31',
    service_plan_id: BOOKKEEPING_PLAN_ID,
  };

  it('creates a project and auto-assigns the company’s bookkeeping specialist (201)', async () => {
    mockPrisma.project.create.mockResolvedValue(projectRow());

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(201);
    // The assignment is not in the response — it is checked where it actually
    // happens, on the write below.
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: COMPANY_ID,
          projectName: 'Q4 Books Close',
          servicePlanId: BOOKKEEPING_PLAN_ID,
          // The whole point: neither of these came from the request.
          assignedSpecialistUserId: BOOKKEEPER_ID,
          createdByUserId: OWNER_ID,
        }),
      })
    );
    // The deadline is stored as the calendar day, at UTC midnight.
    expect(mockPrisma.project.create.mock.calls[0][0].data.deadlineDate.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z'
    );
  });

  it('accepts a specializationId — the service, not the tier (201)', async () => {
    mockPrisma.project.create.mockResolvedValue(projectRow());

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, service_plan_id: undefined, specialization_id: 1 });

    expect(res.status).toBe(201);
    // Resolved to the tier the company actually bought — the caller never has
    // to know which one that is.
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ servicePlanId: BOOKKEEPING_PLAN_ID }) })
    );
  });

  it('opens a tax project and staffs it with the TAX specialist (201)', async () => {
    // The same company, now also subscribed to tax and staffed on that line.
    mockPrisma.companySubscriptionItem.findMany.mockResolvedValue([...purchasedPlans(), taxPlan()]);
    mockPrisma.company.findFirst.mockResolvedValue(company({ taxSpecialistUserId: TAX_SPECIALIST_ID }));
    mockPrisma.project.create.mockResolvedValue(projectRow());

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, service_plan_id: undefined, specialization_id: 3 });

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          servicePlanId: TAX_PLAN_ID,
          // The tax column, not the bookkeeping one — the service picks the line.
          assignedSpecialistUserId: TAX_SPECIALIST_ID,
        }),
      })
    );
    // And the eligibility filter asked for the tax specialist kind.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ specificRole: { code: 'SPECIALIST_2' } }),
      })
    );
  });

  it('refuses a specializationId the company does not pay for (400)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, service_plan_id: undefined, specialization_id: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SERVICE_NOT_PURCHASED');
    // The available set comes back so the client can correct itself.
    expect(res.body.error.details.available).toEqual([
      expect.objectContaining({ specializationId: 1, serviceCode: 'BOOKKEEPING' }),
      expect.objectContaining({ specializationId: 2, serviceCode: 'PAYROLL' }),
    ]);
  });

  it('refuses two ways of naming the same service at once (400)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, specialization_id: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.details.received).toEqual(['servicePlanId', 'specializationId']);
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('accepts a serviceCode instead of a plan id (201)', async () => {
    mockPrisma.project.create.mockResolvedValue(projectRow());

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', managerAuth())
      .send({ ...body, service_plan_id: undefined, service_code: 'bookkeeping' });

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ servicePlanId: BOOKKEEPING_PLAN_ID }) })
    );
  });

  it('falls back to an ACTIVE assignment when the standing column is empty (201)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ bookkeepingSpecialistUserId: null }));
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      { specialistUserId: OTHER_BOOKKEEPER_ID, assignedAt: new Date('2026-07-01T00:00:00Z') },
    ]);
    mockPrisma.project.create.mockResolvedValue(projectRow());

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignedSpecialistUserId: OTHER_BOOKKEEPER_ID }),
      })
    );
  });

  it('does not assign a specialist whose service does not match (201, unassigned)', async () => {
    // A tax specialist sitting in the bookkeeping column — a stale assignment,
    // or a role changed after the fact. Assigning them would read as staffed
    // while the work sits with someone who cannot do it.
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ bookkeepingSpecialistUserId: TAX_SPECIALIST_ID })
    );
    mockPrisma.project.create.mockResolvedValue(projectRow({ assignedSpecialistUserId: null }));

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedSpecialistUserId: null }) })
    );
  });

  it('skips a specialist whose account is no longer ACTIVE (201, unassigned)', async () => {
    stageBench({
      ...BENCH,
      [BOOKKEEPER_ID]: { ...BENCH[BOOKKEEPER_ID], status: 'HIBERNATED' },
    });
    mockPrisma.project.create.mockResolvedValue(projectRow({ assignedSpecialistUserId: null }));

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedSpecialistUserId: null }) })
    );
  });

  it('picks exactly one — the standing specialist outranks the assignment rows (201)', async () => {
    // Both are eligible bookkeepers on this company. The column is the answer to
    // "who is THE specialist", so it wins, and only one id is ever written.
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      { specialistUserId: OTHER_BOOKKEEPER_ID, assignedAt: new Date('2026-07-01T00:00:00Z') },
    ]);
    mockPrisma.project.create.mockResolvedValue(projectRow());

    await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignedSpecialistUserId: BOOKKEEPER_ID }),
      })
    );
  });

  it('only ever considers specialists on THIS company', async () => {
    mockPrisma.project.create.mockResolvedValue(projectRow());

    await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    // The assignment lookup is scoped to the company AND the specialization —
    // both halves of "according to service and company".
    expect(mockPrisma.companySpecialistAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: COMPANY_ID, specializationId: 1, assignmentStatus: 'ACTIVE' },
      })
    );
    // And the shortlist is filtered to the specialist kind that serves it.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          role: { code: 'SPECIALIST' },
          specificRole: { code: 'SPECIALIST_3' },
        }),
      })
    );
  });

  it('creates the project unassigned when nobody is staffed (201)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ bookkeepingSpecialistUserId: null }));
    mockPrisma.project.create.mockResolvedValue(projectRow({ assignedSpecialistUserId: null }));

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedSpecialistUserId: null }) })
    );
  });

  it('refuses a service the company does not pay for (400)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, service_plan_id: TAX_PLAN_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SERVICE_NOT_PURCHASED');
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('refuses a company with no active subscription (409)', async () => {
    mockPrisma.companySubscriptionItem.findMany.mockResolvedValue([]);

    const res = await request(app).post('/api/projects').set('Authorization', ownerAuth()).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_ACTIVE_SERVICES');
  });

  it('refuses an ADMIN — projects are opened by managers and customers (403)', async () => {
    const res = await request(app).post('/api/projects').set('Authorization', adminAuth()).send(body);

    expect(res.status).toBe(403);
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  /*
   * An admin is refused on READ too, which is the part that does not follow from
   * the create rule and so is worth its own case: a project and its attachments
   * are the client's working material, and access to them comes from being on
   * the company rather than from rank.
   */
  it('refuses an ADMIN reading the projects table (403)', async () => {
    const res = await request(app)
      .get(`/api/projects?company_id=${COMPANY_ID}`)
      .set('Authorization', adminAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
    expect(mockPrisma.project.findMany).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN opening one project (403)', async () => {
    // The project resolves — the refusal is the access rule, not a missing row.
    mockPrisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID, companyId: COMPANY_ID });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('refuses an accounting manager who does not manage this company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: 999 }));

    const res = await request(app).post('/api/projects').set('Authorization', managerAuth()).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('rejects a date that does not exist (400)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, deadline_date: '2026-02-31' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.deadlineDate).toBe('That date does not exist.');
  });

  it('rejects a specialist supplied in the body (400)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', ownerAuth())
      .send({ ...body, assigned_specialist_user_id: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

/* -------------------------------- updating -------------------------------- */

describe('PATCH /projects/:projectId', () => {
  beforeEach(() => {
    mockPrisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      createdByUserId: OWNER_ID,
      assignedSpecialistUserId: BOOKKEEPER_ID,
      status: 'TODO',
    });
  });

  it('lets the assigned specialist move the status (200)', async () => {
    mockPrisma.project.update.mockResolvedValue(projectRow({ status: 'ACTIVE' }));

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', auth({ userId: BOOKKEEPER_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' }))
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
  });

  it('sets the progress bar, passing a string to the NUMERIC column (200)', async () => {
    mockPrisma.project.update.mockResolvedValue(projectRow({ status: 'ACTIVE', progressBar: '65.50' }));

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth())
      .send({ status: 'ACTIVE', progress_bar: 65.5 });

    expect(res.status).toBe(200);
    expect(res.body.data.progressBar).toBe(65.5);
    // A string, never a float, on the way to Decimal.
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE', progressBar: '65.5' } })
    );
  });

  it.each([
    [101, 'Progress cannot exceed 100.'],
    [-5, 'Progress cannot be negative.'],
    ['abc', 'Use a number from 0 to 100, with at most 2 decimals.'],
    [33.333, 'Use a number from 0 to 100, with at most 2 decimals.'],
  ])('rejects progressBar %p (400)', async (value, detail) => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth())
      .send({ progress_bar: value });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.progressBar).toBe(detail);
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
  });

  it('accepts the boundaries 0 and 100 (200)', async () => {
    mockPrisma.project.update.mockResolvedValue(projectRow({ status: 'COMPLETED', progressBar: '100.00' }));

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth())
      .send({ progress_bar: 100 });

    expect(res.status).toBe(200);
    expect(res.body.data.progressBar).toBe(100);
  });

  it('refuses an unrelated caller (403)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID, specificRole: 'TEAM' }))
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROJECT_ACCESS_DENIED');
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
  });

  it('refuses to move a project to another service (400)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth())
      .send({ service_plan_id: TAX_PLAN_ID });

    expect(res.status).toBe(400);
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
  });

  it('404s on a project that does not exist', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});

/* ------------------------- the re-staffing sweep -------------------------- */

describe('POST /projects/sync-specialists', () => {
  it('fills in projects that were opened while nobody was staffed (200)', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      {
        id: PROJECT_ID,
        servicePlan: { specialization: { id: 1, specializationCode: 'BOOKKEEPING' } },
      },
      // No tax specialist on this company, so this one stays unassigned.
      { id: 301, servicePlan: { specialization: { id: 3, specializationCode: 'TAX' } } },
    ]);
    mockPrisma.project.update.mockResolvedValue({ id: PROJECT_ID, assignedSpecialistUserId: BOOKKEEPER_ID });

    const res = await request(app)
      .post('/api/projects/sync-specialists')
      .set('Authorization', managerAuth())
      .send({ company_id: COMPANY_ID });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ companyId: COMPANY_ID, assigned: 1, remaining: 1 });
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROJECT_ID },
        data: { assignedSpecialistUserId: BOOKKEEPER_ID },
      })
    );
  });

  it('only ever looks at live, unassigned projects', async () => {
    mockPrisma.project.findMany.mockResolvedValue([]);

    await request(app)
      .post('/api/projects/sync-specialists')
      .set('Authorization', managerAuth())
      .send({ company_id: COMPANY_ID });

    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: COMPANY_ID,
          deletedAt: null,
          assignedSpecialistUserId: null,
          // COMPLETED is absent: naming a specialist on finished work they never
          // touched would be a false record.
          status: { in: ['TODO', 'ACTIVE'] },
        },
      })
    );
  });

  it('refuses a customer — staffing is not the account holder’s decision (403)', async () => {
    const res = await request(app)
      .post('/api/projects/sync-specialists')
      .set('Authorization', ownerAuth())
      .send({ company_id: COMPANY_ID });

    expect(res.status).toBe(403);
  });
});
