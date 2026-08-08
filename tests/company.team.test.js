'use strict';

/**
 * Integration tests for the company team endpoints — accounting-manager
 * assignment, specialist assignment/removal, and the team/specialist reads —
 * through the real Express app with Prisma mocked.
 */

const mockPrisma = {
  user: { findUnique: jest.fn() },
  company: { findFirst: jest.fn(), update: jest.fn() },
  specialization: { findMany: jest.fn() },
  companySpecialistAssignment: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
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
const SPECIALIST_ID = 77;
const COMPANY_ID = 900;

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

function managerAuth() {
  return auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null });
}

function person(id, first, last, role, specificRole = null) {
  return { id, firstName: first, lastName: last, status: 'ACTIVE', role: { code: role }, specificRole: specificRole ? { code: specificRole } : null };
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

/** Route user.findUnique lookups by id so caller and target resolve distinctly. */
function stageUsers(map) {
  mockPrisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(map[where.id] ?? null));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
});

/* --------------------- PUT accounting-manager ---------------------------- */

describe('PUT /companies/:id/accounting-manager', () => {
  it('assigns a valid accounting manager as ADMIN (200)', async () => {
    stageUsers({
      [OWNER_ID]: person(OWNER_ID, 'Root', 'Admin', 'ADMIN', null),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.company.update.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth({ role: 'ADMIN', specificRole: null }))
      .send({ accounting_manager_user_id: MANAGER_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.company.accountingManagerUserId).toBe(MANAGER_ID);
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COMPANY_ID }, data: { accountingManagerUserId: MANAGER_ID } })
    );
  });

  it('rejects a user without the ACCOUNTING_MANAGER role (422)', async () => {
    stageUsers({
      [OWNER_ID]: person(OWNER_ID, 'Root', 'Admin', 'ADMIN', null),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'SPECIALIST'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth({ role: 'ADMIN', specificRole: null }))
      .send({ accounting_manager_user_id: MANAGER_ID });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ACCOUNTING_MANAGER_ROLE');
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller, even one who owns the company (403)', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER') });
    mockPrisma.company.findFirst.mockResolvedValue(company({ ownerUserId: 999 })); // owned by someone else

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accounting_manager_user_id: MANAGER_ID });

    // FORBIDDEN, not COMPANY_ACCESS_DENIED: the route gate now turns away any
    // non-admin before ownership is even considered.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for a missing company', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'Root', 'Admin', 'ADMIN', null) });
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth({ role: 'ADMIN', specificRole: null }))
      .send({ accounting_manager_user_id: MANAGER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMPANY_NOT_FOUND');
  });

  it('refuses the company OWNER — assigning staff is an ADMIN decision', async () => {
    /*
     * Deliberately narrower than every other company write. An accounting
     * manager is internal staff, and who serves which account is a staffing
     * decision — not something a customer makes about their own company by
     * attaching whichever manager they like.
     */
    stageUsers({
      [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER'),
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth())
      .send({ accounting_manager_user_id: MANAGER_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('blocks a non-owner/admin token at the role gate (403 FORBIDDEN)', async () => {
    // The gate re-checks the database on a claim miss — that is what stops a
    // merely STALE token from being refused — so the DB has to agree here for
    // the refusal to stand.
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'SPECIALIST', null) });

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/accounting-manager`)
      .set('Authorization', auth({ role: 'SPECIALIST', specificRole: null }))
      .send({ accounting_manager_user_id: MANAGER_ID });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });
});

/* ------------------------ POST specialists ------------------------------- */

describe('POST /companies/:id/specialists', () => {
  const specs = [
    { id: 1, specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping', isActive: true },
    { id: 2, specializationCode: 'PAYROLL', specializationName: 'Payroll', isActive: true },
  ];

  /*
   * Staffing specialists belongs to the company's OWN accounting manager — not
   * the owner, not an admin — so the caller here is MANAGER_ID and the company
   * names them as its manager.
   */
  function stageSpecialistOk() {
    stageUsers({
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
      [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER'),
      [SPECIALIST_ID]: person(SPECIALIST_ID, 'Jane', 'Doe', 'SPECIALIST'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));
    mockPrisma.specialization.findMany.mockResolvedValue(specs);
    mockPrisma.companySpecialistAssignment.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 1000 + data.specializationId,
        companyId: data.companyId,
        specialistUserId: data.specialistUserId,
        specializationId: data.specializationId,
        assignmentStatus: 'ACTIVE',
        assignedAt: new Date('2026-07-24T00:00:00Z'),
        unassignedAt: null,
        specialization: specs.find((s) => s.id === data.specializationId),
      })
    );
  }

  it('creates one assignment per specialization (201)', async () => {
    stageSpecialistOk();
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]); // none active yet

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ specialist_user_id: SPECIALIST_ID, specialization_codes: ['BOOKKEEPING', 'PAYROLL'] });

    expect(res.status).toBe(201);
    expect(res.body.data.assignments).toHaveLength(2);
    expect(res.body.data.assignments.map((a) => a.specializationCode).sort()).toEqual(['BOOKKEEPING', 'PAYROLL']);
    expect(res.body.data.skipped).toEqual([]);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('skips an already-active assignment instead of duplicating it', async () => {
    stageSpecialistOk();
    // BOOKKEEPING (spec id 1) is already active.
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      { id: 999, companyId: COMPANY_ID, specialistUserId: SPECIALIST_ID, specializationId: 1, assignmentStatus: 'ACTIVE' },
    ]);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ specialist_user_id: SPECIALIST_ID, specialization_codes: ['BOOKKEEPING', 'PAYROLL'] });

    expect(res.status).toBe(201);
    expect(res.body.data.assignments).toHaveLength(1);
    expect(res.body.data.assignments[0].specializationCode).toBe('PAYROLL');
    expect(res.body.data.skipped).toContain('BOOKKEEPING');
    expect(mockPrisma.companySpecialistAssignment.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown specialization code (400)', async () => {
    stageSpecialistOk();
    mockPrisma.specialization.findMany.mockResolvedValue([specs[0]]); // only BOOKKEEPING resolves

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ specialist_user_id: SPECIALIST_ID, specialization_codes: ['BOOKKEEPING', 'NOPE'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SPECIALIZATION');
    expect(res.body.error.details.unknown).toEqual(['NOPE']);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a user without the SPECIALIST role (422)', async () => {
    stageUsers({
      [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
      [SPECIALIST_ID]: person(SPECIALIST_ID, 'Jane', 'Doe', 'CUSTOMER', 'TEAM'),
    });
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ specialist_user_id: SPECIALIST_ID, specialization_codes: ['BOOKKEEPING'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_SPECIALIST_ROLE');
  });

  it('rejects an empty specialization_codes array (400)', async () => {
    // Rejected by the validator before any query, but requireAuth still looks
    // the caller up.
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/specialists`)
      .set('Authorization', managerAuth())
      .send({ specialist_user_id: SPECIALIST_ID, specialization_codes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.specializationCodes).toBeDefined();
  });
});

/* -------------------------------- team ----------------------------------- */

describe('GET /companies/:id/team', () => {
  it('returns owner, accounting manager, and specialists grouped by user', async () => {
    stageUsers({ [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER') });
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ accountingManagerUserId: MANAGER_ID, accountingManager: { id: MANAGER_ID, firstName: 'Sarah', lastName: 'Jones' } })
    );
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      { id: 8001, specialistUserId: SPECIALIST_ID, specialist: { id: SPECIALIST_ID, firstName: 'Jane', lastName: 'Doe' }, specialization: { specializationCode: 'BOOKKEEPING' } },
      { id: 8002, specialistUserId: SPECIALIST_ID, specialist: { id: SPECIALIST_ID, firstName: 'Jane', lastName: 'Doe' }, specialization: { specializationCode: 'PAYROLL' } },
    ]);

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/team`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.companyId).toBe(COMPANY_ID);
    expect(res.body.data.owner).toMatchObject({ userId: OWNER_ID, firstName: 'John', lastName: 'Smith' });
    expect(res.body.data.accountingManager).toMatchObject({ userId: MANAGER_ID, firstName: 'Sarah', lastName: 'Jones' });
    expect(res.body.data.specialists).toHaveLength(1);
    expect(res.body.data.specialists[0]).toMatchObject({ userId: SPECIALIST_ID, firstName: 'Jane', lastName: 'Doe' });
    // Each specialization now carries its own assignmentId. The team payload
    // previously dropped it, so a "remove" button rendered from this response
    // had no id to send and the client had to call the specialists endpoint too.
    expect(res.body.data.specialists[0].specializations.map((s) => s.specializationCode).sort())
      .toEqual(['BOOKKEEPING', 'PAYROLL']);
    expect(res.body.data.specialists[0].specializations.every((s) => typeof s.assignmentId === 'number')).toBe(true);
  });

  it('denies read access to an unrelated user (403)', async () => {
    const OUTSIDER = 88;
    stageUsers({ [OUTSIDER]: person(OUTSIDER, 'Nobody', 'Special', 'SPECIALIST') });
    mockPrisma.company.findFirst.mockResolvedValue(company()); // owned by OWNER_ID
    mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null); // no assignment

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/team`)
      .set('Authorization', auth({ userId: OUTSIDER, role: 'SPECIALIST', specificRole: null }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });
});

/* --------------------------- DELETE specialist --------------------------- */

describe('DELETE /companies/:id/specialists/:assignmentId', () => {
  it('soft-removes an active assignment (200)', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));
    mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue({
      id: 44, companyId: COMPANY_ID, specialistUserId: SPECIALIST_ID, specializationId: 1, assignmentStatus: 'ACTIVE',
    });
    mockPrisma.companySpecialistAssignment.update.mockResolvedValue({
      id: 44, companyId: COMPANY_ID, specialistUserId: SPECIALIST_ID, specializationId: 1,
      assignmentStatus: 'INACTIVE', assignedAt: new Date(), unassignedAt: new Date(),
      specialist: { id: SPECIALIST_ID, firstName: 'Jane', lastName: 'Doe' }, specialization: { specializationCode: 'BOOKKEEPING' },
    });

    const res = await request(app).delete(`/api/companies/${COMPANY_ID}/specialists/44`).set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.assignment.assignmentStatus).toBe('INACTIVE');
    expect(mockPrisma.companySpecialistAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 44 }, data: expect.objectContaining({ assignmentStatus: 'INACTIVE' }) })
    );
  });

  it('returns 404 for an assignment not on this company', async () => {
    stageUsers({ [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER') });
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: MANAGER_ID }));
    mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);

    const res = await request(app).delete(`/api/companies/${COMPANY_ID}/specialists/44`).set('Authorization', managerAuth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
  });
});
