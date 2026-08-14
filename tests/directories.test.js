'use strict';

/**
 * Integration tests for the three people directories added alongside the admin
 * screens — through the real Express app with Prisma mocked:
 *
 *   GET /admin/accounting-managers   ADMIN only; managers + the companies they hold
 *   GET /specialists                 scoped; companyId required for non-admins
 *   GET /customers                   scoped; companyId required for non-admins
 *
 * The scope rule is what most of these assert, because it is the part that is
 * wrong in a way nobody notices: an endpoint that returns TOO MUCH still looks
 * like it works.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  company: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  // The specialist profile carries that person's whole task table on the named
  // company.
  projectTask: { findMany: jest.fn() },
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

const ADMIN_ID = 1;
const MANAGER_ID = 11;
const OWNER_ID = 10;
const SPECIALIST_ID = 13;
const OTHER_SPECIALIST_ID = 15;
const COMPANY_ID = 18;
const OTHER_COMPANY_ID = 17;

function auth({ userId = ADMIN_ID, role = 'ADMIN', specificRole = null } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const adminAuth = () => auth();
const managerAuth = () => auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER' });
const ownerAuth = () => auth({ userId: OWNER_ID, role: 'CUSTOMER', specificRole: 'OWNER' });

function person(id, first, last, role, { status = 'ACTIVE', specificRole = null, specificRoleName = null } = {}) {
  return {
    id,
    firstName: first,
    lastName: last,
    email: `${first}.${last}@finopsys.ai`.toLowerCase(),
    jobTitle: null,
    status,
    role: { code: role },
    specificRole: specificRole ? { code: specificRole, name: specificRoleName } : null,
  };
}

function company(overrides = {}) {
  return {
    id: COMPANY_ID,
    companyName: 'BlueHorizon Executive Aviation LLC',
    companyEmail: 'finance@bluehorizon.com',
    status: 'ACTIVE',
    onboardingCompleted: true,
    deletedAt: null,
    ownerUserId: OWNER_ID,
    accountingManagerUserId: MANAGER_ID,
    bookkeepingSpecialistUserId: null,
    payrollSpecialistUserId: null,
    taxSpecialistUserId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

/** Stage the callers the services load through loadCaller/requireAuth. */
function stageCallers() {
  const map = {
    [ADMIN_ID]: person(ADMIN_ID, 'Root', 'Admin', 'ADMIN'),
    [MANAGER_ID]: person(MANAGER_ID, 'AM', 'User', 'ACCOUNTING_MANAGER'),
    [OWNER_ID]: person(OWNER_ID, 'Shelly', 'Doe', 'CUSTOMER', { specificRole: 'OWNER', specificRoleName: 'Owner' }),
    [SPECIALIST_ID]: person(SPECIALIST_ID, 'Bea', 'Books', 'SPECIALIST', {
      specificRole: 'SPECIALIST_3',
      specificRoleName: 'Bookkeeping Specialist',
    }),
  };
  mockPrisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(map[where.id] ?? null));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.count.mockResolvedValue(0);
  mockPrisma.company.findMany.mockResolvedValue([]);
  mockPrisma.company.findFirst.mockResolvedValue(company());
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockPrisma.projectTask.findMany.mockResolvedValue([]);
  stageCallers();
});

/* -------------------------------------------------------------------------- */
/* GET /admin/accounting-managers                                             */
/* -------------------------------------------------------------------------- */

describe('GET /admin/accounting-managers', () => {
  function stageManagers(managers) {
    mockPrisma.user.findMany.mockResolvedValue(managers);
    mockPrisma.user.count.mockResolvedValue(managers.length);
  }

  it('returns each manager with the companies on their book', async () => {
    stageManagers([
      {
        ...person(MANAGER_ID, 'AM', 'User', 'ACCOUNTING_MANAGER'),
        managedCompanies: [
          { id: OTHER_COMPANY_ID, companyName: 'AeroVista Charter Services LLC', companyEmail: 'a@v.com', status: 'ACTIVE', onboardingCompleted: true, createdAt: new Date() },
          { id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', companyEmail: 'f@b.com', status: 'ACTIVE', onboardingCompleted: true, createdAt: new Date() },
        ],
      },
    ]);

    const res = await request(app).get('/api/admin/accounting-managers').set('Authorization', adminAuth());

    expect(res.status).toBe(200);
    const [row] = res.body.data.accountingManagers;
    expect(row).toMatchObject({ userId: MANAGER_ID, fullName: 'AM User', email: 'am.user@finopsys.ai', companyCount: 2 });
    expect(row.companies.map((c) => c.companyId)).toEqual([OTHER_COMPANY_ID, COMPANY_ID]);
  });

  it('keeps a manager with an empty book in the report', async () => {
    stageManagers([{ ...person(12, 'AM2', 'User', 'ACCOUNTING_MANAGER'), managedCompanies: [] }]);

    const res = await request(app).get('/api/admin/accounting-managers').set('Authorization', adminAuth());

    // A manager holding nothing is exactly who a rebalancing admin is looking
    // for; dropping them would make the report reassuring rather than useful.
    expect(res.status).toBe(200);
    expect(res.body.data.accountingManagers).toHaveLength(1);
    expect(res.body.data.accountingManagers[0].companyCount).toBe(0);
  });

  it('counts companies from the list it returns, not a separate query', async () => {
    stageManagers([
      {
        ...person(MANAGER_ID, 'AM', 'User', 'ACCOUNTING_MANAGER'),
        managedCompanies: [{ id: COMPANY_ID, companyName: 'X', companyEmail: 'x@y.com', status: 'ACTIVE', onboardingCompleted: true, createdAt: new Date() }],
      },
    ]);

    const res = await request(app).get('/api/admin/accounting-managers').set('Authorization', adminAuth());

    const [row] = res.body.data.accountingManagers;
    expect(row.companyCount).toBe(row.companies.length);
  });

  it('excludes soft-deleted companies in the JOIN', async () => {
    stageManagers([{ ...person(MANAGER_ID, 'AM', 'User', 'ACCOUNTING_MANAGER'), managedCompanies: [] }]);

    await request(app).get('/api/admin/accounting-managers').set('Authorization', adminAuth());

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          managedCompanies: expect.objectContaining({ where: { deletedAt: null } }),
        }),
      })
    );
  });

  it('queries only ACTIVE managers unless asked otherwise', async () => {
    await request(app).get('/api/admin/accounting-managers').set('Authorization', adminAuth());

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', role: { code: 'ACCOUNTING_MANAGER' } }),
      })
    );
  });

  it('includes deactivated managers on request', async () => {
    await request(app)
      .get('/api/admin/accounting-managers?includeInactive=true')
      .set('Authorization', adminAuth());

    // A deactivated manager still holding live companies is precisely what an
    // admin needs to find — those accounts are unstaffed.
    const [call] = mockPrisma.user.findMany.mock.calls;
    expect(call[0].where.status).toBeUndefined();
  });

  it('refuses a non-admin even with a role claim in the token', async () => {
    const res = await request(app).get('/api/admin/accounting-managers').set('Authorization', managerAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/admin/accounting-managers');

    expect(res.status).toBe(401);
  });

  it('rejects an unsupported sort field', async () => {
    const res = await request(app)
      .get('/api/admin/accounting-managers?sort=companyCount')
      .set('Authorization', adminAuth());

    // Sorting by a joined collection's size cannot honour the soft-delete filter
    // the counts use, so the order and the numbers would disagree.
    expect(res.status).toBe(400);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown query parameter', async () => {
    const res = await request(app).get('/api/admin/accounting-managers?foo=1').set('Authorization', adminAuth());

    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /specialists                                                           */
/* -------------------------------------------------------------------------- */

describe('GET /specialists', () => {
  /**
   * The directory issues several findMany calls against the same models with
   * different shapes, so the mocks discriminate on the query rather than on call
   * order — order-dependent mocks break the moment two independent reads are
   * moved into one Promise.all.
   */
  function stageSpecialists({ users = [], assignments = [], standing = [], scopeIds = [] } = {}) {
    mockPrisma.user.findMany.mockResolvedValue(users);
    mockPrisma.user.count.mockResolvedValue(users.length);

    mockPrisma.companySpecialistAssignment.findMany.mockImplementation(({ distinct }) =>
      Promise.resolve(distinct ? scopeIds.map((id) => ({ specialistUserId: id })) : assignments)
    );

    mockPrisma.company.findMany.mockImplementation(({ select }) =>
      Promise.resolve(select?.companyName ? standing : [])
    );
  }

  const bookkeeper = () =>
    person(SPECIALIST_ID, 'Bea', 'Books', 'SPECIALIST', {
      specificRole: 'SPECIALIST_3',
      specificRoleName: 'Bookkeeping Specialist',
    });

  const assignment = (userId = SPECIALIST_ID) => ({
    specialistUserId: userId,
    company: { id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', status: 'ACTIVE' },
    specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
  });

  it('gives an admin every specialist, including unassigned ones', async () => {
    stageSpecialists({
      users: [
        bookkeeper(),
        person(OTHER_SPECIALIST_ID, 'Pat', 'Pay', 'SPECIALIST', { specificRole: 'SPECIALIST_1', specificRoleName: 'Payroll Specialist' }),
      ],
      assignments: [assignment()],
    });

    const res = await request(app).get('/api/specialists').set('Authorization', adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.specialists).toHaveLength(2);

    const [bea, pat] = res.body.data.specialists;
    expect(bea).toMatchObject({ fullName: 'Bea Books', serviceSpeciality: 'Bookkeeping Specialist', companyCount: 1 });
    // An unassigned specialist is still a specialist: the standing title survives
    // even when there is no company to show.
    expect(pat).toMatchObject({ serviceSpeciality: 'Payroll Specialist', companyCount: 0, specialities: [] });
  });

  it('requires companyId from a non-admin', async () => {
    const res = await request(app).get('/api/specialists').set('Authorization', managerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMPANY_ID_REQUIRED');
    expect(res.body.error.fields.companyId).toBeDefined();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses the company filter from an admin', async () => {
    // The admin roll is the whole roll. A filter on an admin token is the
    // frontend sending the manager's query, not a narrower question.
    const res = await request(app)
      .get(`/api/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', adminAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMPANY_FILTER_NOT_SUPPORTED');
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses an owner of the very company being asked about', async () => {
    // Reading the company is deliberately NOT enough — staffing is the
    // manager's view. The owner's team screen is GET /companies/:id/team.
    const res = await request(app)
      .get(`/api/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('scopes a manager to the named company', async () => {
    stageSpecialists({ users: [bookkeeper()], assignments: [assignment()], scopeIds: [SPECIALIST_ID] });

    const res = await request(app)
      .get(`/api/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.specialists).toHaveLength(1);
    expect(res.body.data.filters.companyId).toBe(COMPANY_ID);
    // The outer query was restricted to the ids reachable through that company.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [SPECIALIST_ID] } }) })
    );
  });

  it('refuses a company the caller cannot read', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ id: OTHER_COMPANY_ID, ownerUserId: 999, accountingManagerUserId: 888 })
    );

    const res = await request(app)
      .get(`/api/specialists?companyId=${OTHER_COMPANY_ID}`)
      .set('Authorization', managerAuth());

    // The global company filter must only ever NARROW a caller's scope.
    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty list when the company has no specialists', async () => {
    stageSpecialists({ scopeIds: [] });

    const res = await request(app)
      .get(`/api/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.specialists).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
    // "Restricted to nothing" must not degrade into "unrestricted".
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('counts a specialist attached by a standing column, not only by assignment', async () => {
    stageSpecialists({
      users: [bookkeeper()],
      standing: [
        {
          id: COMPANY_ID,
          companyName: 'BlueHorizon Executive Aviation LLC',
          status: 'ACTIVE',
          bookkeepingSpecialistUserId: SPECIALIST_ID,
          payrollSpecialistUserId: null,
          taxSpecialistUserId: null,
        },
      ],
    });

    const res = await request(app).get('/api/specialists').set('Authorization', adminAuth());

    const [row] = res.body.data.specialists;
    expect(row.companyCount).toBe(1);
    expect(row.specialities.map((s) => s.code)).toEqual(['BOOKKEEPING']);
  });

  it('folds the two attachment mechanisms together instead of listing a company twice', async () => {
    stageSpecialists({
      users: [bookkeeper()],
      assignments: [assignment()],
      standing: [
        {
          id: COMPANY_ID,
          companyName: 'BlueHorizon Executive Aviation LLC',
          status: 'ACTIVE',
          bookkeepingSpecialistUserId: SPECIALIST_ID,
          payrollSpecialistUserId: null,
          taxSpecialistUserId: null,
        },
      ],
    });

    const res = await request(app).get('/api/specialists').set('Authorization', adminAuth());

    const [row] = res.body.data.specialists;
    // The most correctly-configured account — assigned AND holding the column —
    // must not be the one that renders duplicate rows.
    expect(row.companies).toHaveLength(1);
    expect(row.companies[0].services).toEqual(['BOOKKEEPING']);
    expect(row.specialities).toHaveLength(1);
    // The joined name wins over the bare code when both sources describe it.
    expect(row.specialities[0].name).toBe('Bookkeeping');
  });

  it('rejects a malformed companyId before touching the database', async () => {
    const res = await request(app).get('/api/specialists?companyId=abc').set('Authorization', adminAuth());

    expect(res.status).toBe(400);
    expect(mockPrisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an unknown query parameter', async () => {
    const res = await request(app).get('/api/specialists?foo=1').set('Authorization', adminAuth());

    expect(res.status).toBe(400);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/specialists');

    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /specialists/:userId                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /specialists/:userId', () => {
  const profile = (overrides = {}) => ({
    ...person(SPECIALIST_ID, 'Bea', 'Books', 'SPECIALIST', {
      specificRole: 'SPECIALIST_3',
      specificRoleName: 'Bookkeeping Specialist',
    }),
    phone: '+1 555 0100',
    avatarKey: null,
    createdAt: new Date('2026-01-04T00:00:00Z'),
    address: {
      id: 7,
      line1: '900 Biscayne Blvd',
      line2: 'Suite 400',
      city: 'Miami',
      state: 'FL',
      postalCode: '33132',
      country: 'United States',
      countryCode: 'US',
    },
    ...overrides,
  });

  /**
   * `user.findFirst` is the profile lookup and `user.findUnique` is the caller,
   * so the two must not be staged with one mock — a test that returns the
   * profile for both would authorise the request as the specialist themselves.
   */
  const task = (id, taskName, status) => ({
    id,
    projectId: 5,
    taskName,
    description: null,
    status,
    deadlineDate: new Date('2026-09-30T00:00:00Z'),
    specialistUserId: SPECIALIST_ID,
    createdByUserId: MANAGER_ID,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    project: {
      id: 5,
      companyId: COMPANY_ID,
      projectName: 'Q3 Close',
      status: 'ACTIVE',
      deadlineDate: new Date('2026-10-31T00:00:00Z'),
      company: { id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC' },
    },
    specialist: null,
    createdBy: null,
  });

  function stageProfile({ specialist = profile(), attached = true, tasks = [] } = {}) {
    mockPrisma.user.findFirst.mockResolvedValue(specialist);
    mockPrisma.companySpecialistAssignment.findMany.mockImplementation(({ distinct }) =>
      Promise.resolve(
        distinct
          ? (attached ? [{ specialistUserId: SPECIALIST_ID }] : [])
          : [
              {
                specialistUserId: SPECIALIST_ID,
                company: { id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', status: 'ACTIVE' },
                specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' },
              },
            ]
      )
    );
    mockPrisma.projectTask.findMany.mockResolvedValue(tasks);
  }

  it('gives a manager the profile, the address and the whole task table', async () => {
    stageProfile({ tasks: [task(1, 'Reconcile bank', 'TODO'), task(2, 'Post journals', 'ACTIVE')] });

    const res = await request(app)
      .get(`/api/specialists/${SPECIALIST_ID}?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.specialist).toMatchObject({
      userId: SPECIALIST_ID,
      fullName: 'Bea Books',
      phone: '+1 555 0100',
      serviceSpeciality: 'Bookkeeping Specialist',
      taskCount: 2,
    });
    expect(res.body.data.specialist.address).toMatchObject({ city: 'Miami', postalCode: '33132' });
    // Four columns and nothing else: the profile has already said whose work
    // this is and which account it is on, so assignee, creator, project and the
    // audit timestamps would only repeat the page back to itself.
    expect(res.body.data.specialist.tasks[0]).toEqual({
      id: 1,
      taskName: 'Reconcile bank',
      description: null,
      status: 'TODO',
      // A DATE column must leave as YYYY-MM-DD, never as an ISO timestamp.
      deadlineDate: '2026-09-30',
    });

    // The profile shows the PERSON: the company block belongs to the company
    // screens, and duplicating it here would be a second copy to keep in step.
    expect(res.body.data.specialist.companies).toBeUndefined();
    expect(res.body.data.specialist.companyCount).toBeUndefined();

    // The tasks are THIS specialist's on THIS company, not the whole board.
    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          specialistUserId: SPECIALIST_ID,
          project: expect.objectContaining({ companyId: COMPANY_ID }),
        }),
      })
    );
  });

  it('404s a specialist who does not work the manager\'s company', async () => {
    stageProfile({ attached: false });

    const res = await request(app)
      .get(`/api/specialists/${SPECIALIST_ID}?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    // A 404 rather than a 403: a 403 would confirm the id is a real specialist.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SPECIALIST_NOT_FOUND');
  });

  it('404s a user who is not a specialist at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/specialists/${OWNER_ID}?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(404);
  });

  it('gives an admin the unscoped profile, with no tasks', async () => {
    stageProfile();

    const res = await request(app).get(`/api/specialists/${SPECIALIST_ID}`).set('Authorization', adminAuth());

    expect(res.status).toBe(200);
    // Null rather than empty, and the difference is the point: empty would claim
    // the specialist has no work, when the admin view names no company for the
    // work to belong to. The task endpoints refuse an admin outright.
    expect(res.body.data.specialist.tasks).toBeNull();
    expect(res.body.data.specialist.taskCount).toBeNull();
    expect(mockPrisma.projectTask.findMany).not.toHaveBeenCalled();
  });

  it('applies the same scope rules as the list', async () => {
    stageProfile();

    const [managerNoFilter, adminFiltered, owner] = await Promise.all([
      request(app).get(`/api/specialists/${SPECIALIST_ID}`).set('Authorization', managerAuth()),
      request(app)
        .get(`/api/specialists/${SPECIALIST_ID}?companyId=${COMPANY_ID}`)
        .set('Authorization', adminAuth()),
      request(app)
        .get(`/api/specialists/${SPECIALIST_ID}?companyId=${COMPANY_ID}`)
        .set('Authorization', ownerAuth()),
    ]);

    expect(managerNoFilter.status).toBe(400);
    expect(managerNoFilter.body.error.code).toBe('COMPANY_ID_REQUIRED');
    expect(adminFiltered.status).toBe(400);
    expect(adminFiltered.body.error.code).toBe('COMPANY_FILTER_NOT_SUPPORTED');
    expect(owner.status).toBe(403);
  });

  it('rejects a malformed id and an unknown query parameter', async () => {
    const [badId, badQuery] = await Promise.all([
      request(app).get('/api/specialists/abc').set('Authorization', adminAuth()),
      request(app).get(`/api/specialists/${SPECIALIST_ID}?limit=5`).set('Authorization', adminAuth()),
    ]);

    expect(badId.status).toBe(400);
    expect(badQuery.status).toBe(400);
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* GET /customers                                                             */
/* -------------------------------------------------------------------------- */

describe('GET /customers', () => {
  function customer(id, first, last, companies = []) {
    return {
      ...person(id, first, last, 'CUSTOMER', { specificRole: 'OWNER', specificRoleName: 'Owner' }),
      ownedCompanies: companies,
    };
  }

  function stageCustomers({ users = [], owners = [] } = {}) {
    mockPrisma.user.findMany.mockResolvedValue(users);
    mockPrisma.user.count.mockResolvedValue(users.length);
    mockPrisma.company.findMany.mockImplementation(({ distinct }) =>
      Promise.resolve(distinct ? owners.map((ownerUserId) => ({ ownerUserId })) : [])
    );
  }

  it('gives an admin every customer with the companies they own', async () => {
    stageCustomers({
      users: [
        customer(OWNER_ID, 'Shelly', 'Doe', [
          { id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', status: 'ACTIVE' },
          { id: OTHER_COMPANY_ID, companyName: 'AeroVista Charter Services LLC', status: 'ACTIVE' },
        ]),
      ],
    });

    const res = await request(app).get('/api/customers').set('Authorization', adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.customers[0]).toMatchObject({
      userId: OWNER_ID,
      fullName: 'Shelly Doe',
      email: 'shelly.doe@finopsys.ai',
      specificRole: 'OWNER',
      specificRoleName: 'Owner',
      companyCount: 2,
    });
  });

  it('requires companyId from an accounting manager', async () => {
    const res = await request(app).get('/api/customers').set('Authorization', managerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMPANY_ID_REQUIRED');
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('returns only that company on the row when scoped', async () => {
    stageCustomers({
      users: [customer(OWNER_ID, 'Shelly', 'Doe', [{ id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', status: 'ACTIVE' }])],
      owners: [OWNER_ID],
    });

    const res = await request(app)
      .get(`/api/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.customers[0].companies.map((c) => c.companyId)).toEqual([COMPANY_ID]);
    // The nested companies are filtered too — a manager must not learn the
    // customer's other accounts through this endpoint.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          ownedCompanies: expect.objectContaining({
            where: { deletedAt: null, id: { in: [COMPANY_ID] } },
          }),
        }),
      })
    );
  });

  it('refuses a company the manager does not serve', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ id: OTHER_COMPANY_ID, ownerUserId: 999, accountingManagerUserId: 888 })
    );

    const res = await request(app)
      .get(`/api/customers?companyId=${OTHER_COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('lets an owner read the customers of their own company', async () => {
    stageCustomers({
      users: [customer(OWNER_ID, 'Shelly', 'Doe', [{ id: COMPANY_ID, companyName: 'BlueHorizon Executive Aviation LLC', status: 'ACTIVE' }])],
      owners: [OWNER_ID],
    });

    const res = await request(app)
      .get(`/api/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.customers).toHaveLength(1);
  });

  it('returns an empty list for a company with no customer users', async () => {
    stageCustomers({ owners: [] });

    const res = await request(app)
      .get(`/api/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.customers).toEqual([]);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('queries CUSTOMER users only', async () => {
    await request(app).get('/api/customers').set('Authorization', adminAuth());

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: { code: 'CUSTOMER' }, status: 'ACTIVE' }) })
    );
  });

  it('rejects an unknown query parameter', async () => {
    const res = await request(app).get('/api/customers?foo=1').set('Authorization', adminAuth());

    expect(res.status).toBe(400);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/customers');

    expect(res.status).toBe(401);
  });
});
