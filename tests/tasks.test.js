'use strict';

/**
 * Integration tests for the task endpoints, through the real Express app with
 * Prisma mocked.
 *
 * THE CASES WORTH HAVING are the ones where the SERVER decides something the
 * request did not say, and — more than in any other suite here — the ones
 * covering the two rules the DATABASE was deliberately not asked to hold:
 *
 *   1. A task falls AFTER its project's deadline. There is no CHECK for it (the
 *      comparison crosses tables), so if these tests do not hold the line,
 *      nothing does.
 *
 *   2. Only the project's assigned specialist may file or move a task. The
 *      composite foreign key that would have pinned a task's specialist to its
 *      project's was dropped, so this is code-only too.
 *
 * Both were traded away for simpler DDL. That trade is only safe while these
 * pass.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  project: { findFirst: jest.fn() },
  projectTask: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
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

const request = require('supertest');
const app = require('../src/app');
const { signAccessToken } = require('../src/utils/tokens');

const OWNER_ID = 42;
const MANAGER_ID = 55;
const TEAMMATE_ID = 61;
const BOOKKEEPER_ID = 77;
const OTHER_SPECIALIST_ID = 78;
const COMPANY_ID = 900;
const OTHER_COMPANY_ID = 901;
const PROJECT_ID = 300;
const TASK_ID = 700;

// The project is due 2026-12-31, so every valid task deadline below is in 2027.
// That relationship is the subject of half this file — keep the two in view.
const PROJECT_DEADLINE = '2026-12-31';
const VALID_TASK_DEADLINE = '2027-01-15';

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const ownerAuth = () => auth();
const managerAuth = () => auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null });
const adminAuth = () => auth({ userId: 1, role: 'ADMIN', specificRole: null });
const specialistAuth = () => auth({ userId: BOOKKEEPER_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' });
const otherSpecialistAuth = () =>
  auth({ userId: OTHER_SPECIALIST_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' });

/*
 * `phone`, `jobTitle` and `ownedCompanies` are here for requirePaidAccount,
 * which gates /tasks exactly as it gates /projects: an OWNER with a half-filled
 * profile or an unpaid company is refused with a 402 before any route runs. The
 * paywall has its own suite; here it is a precondition, not the subject.
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

/** A row as projectRepository.findProjectForAccess returns it. */
function projectAccessRow(overrides = {}) {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    createdByUserId: OWNER_ID,
    assignedSpecialistUserId: BOOKKEEPER_ID,
    status: 'ACTIVE',
    // The bound every task deadline is measured against.
    deadlineDate: new Date(`${PROJECT_DEADLINE}T00:00:00.000Z`),
    ...overrides,
  };
}

/** A row as projectTaskRepository's TASK_SELECT returns it. */
function taskRow(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    taskName: 'Reconcile October bank feed',
    description: 'Match the Chase feed against the ledger and clear exceptions.',
    status: 'TODO',
    deadlineDate: new Date(`${VALID_TASK_DEADLINE}T00:00:00.000Z`),
    specialistUserId: BOOKKEEPER_ID,
    createdByUserId: BOOKKEEPER_ID,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    project: {
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      projectName: 'Q4 Books Close',
      status: 'ACTIVE',
      deadlineDate: new Date(`${PROJECT_DEADLINE}T00:00:00.000Z`),
      company: { id: COMPANY_ID, companyName: 'ABC Aerospace LLC' },
    },
    specialist: {
      id: BOOKKEEPER_ID,
      firstName: 'Ada',
      lastName: 'Hopper',
      email: 'ada@finopsys.ai',
      jobTitle: 'Bookkeeping Specialist',
      avatarKey: null,
      specificRole: { code: 'SPECIALIST_3' },
    },
    createdBy: {
      id: BOOKKEEPER_ID,
      firstName: 'Ada',
      lastName: 'Hopper',
      email: 'ada@finopsys.ai',
      jobTitle: 'Bookkeeping Specialist',
      avatarKey: null,
    },
    ...overrides,
  };
}

/** A row as projectTaskRepository.findTaskForAccess returns it. */
function taskAccessRow(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    specialistUserId: BOOKKEEPER_ID,
    createdByUserId: BOOKKEEPER_ID,
    status: 'TODO',
    deadlineDate: new Date(`${VALID_TASK_DEADLINE}T00:00:00.000Z`),
    project: {
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      createdByUserId: OWNER_ID,
      assignedSpecialistUserId: BOOKKEEPER_ID,
      deadlineDate: new Date(`${PROJECT_DEADLINE}T00:00:00.000Z`),
      deletedAt: null,
    },
    ...overrides,
  };
}

function stageUsers(map) {
  mockPrisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(map[where.id] ?? null));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

  stageUsers({
    [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER'),
    [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
    [TEAMMATE_ID]: person(TEAMMATE_ID, 'Raj', 'Patel', 'CUSTOMER', 'TEAM'),
    [BOOKKEEPER_ID]: person(BOOKKEEPER_ID, 'Ada', 'Hopper', 'SPECIALIST', 'SPECIALIST_3'),
    [OTHER_SPECIALIST_ID]: person(OTHER_SPECIALIST_ID, 'Rex', 'Ledger', 'SPECIALIST', 'SPECIALIST_3'),
    1: person(1, 'Root', 'Admin', 'ADMIN'),
  });

  mockPrisma.company.findFirst.mockResolvedValue(company());
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);

  mockPrisma.project.findFirst.mockResolvedValue(projectAccessRow());

  mockPrisma.projectTask.findMany.mockResolvedValue([taskRow()]);
  mockPrisma.projectTask.count.mockResolvedValue(1);
  mockPrisma.projectTask.groupBy.mockResolvedValue([{ status: 'TODO', _count: { _all: 1 } }]);
  mockPrisma.projectTask.findFirst.mockResolvedValue(taskRow());
  mockPrisma.projectTask.create.mockResolvedValue(taskRow());
  mockPrisma.projectTask.update.mockResolvedValue(taskRow({ status: 'ACTIVE' }));
});

/* ======================= GET /tasks — the company list ===================== */

describe('GET /tasks', () => {
  it('returns a company’s tasks with the fields the table renders (200)', async () => {
    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.companyId).toBe(COMPANY_ID);

    const [task] = res.body.data.tasks;
    expect(task).toMatchObject({
      id: TASK_ID,
      projectId: PROJECT_ID,
      taskName: 'Reconcile October bank feed',
      description: 'Match the Chase feed against the ledger and clear exceptions.',
      status: 'TODO',
      companyId: COMPANY_ID,
    });
    // A DATE column leaves as the calendar day it is, never as a timestamp —
    // serialising it as an ISO string is how a deadline renders as the day
    // before to anyone west of UTC.
    expect(task.deadlineDate).toBe(VALID_TASK_DEADLINE);
    // The project's own deadline rides along so a date picker knows its lower
    // bound without a second request.
    expect(task.project.deadlineDate).toBe(PROJECT_DEADLINE);
    expect(task.specialist).toMatchObject({ id: BOOKKEEPER_ID, specificRole: 'SPECIALIST_3' });
  });

  it('scopes the query through the project, since a task has no company column', async () => {
    await request(app).get(`/api/tasks?companyId=${COMPANY_ID}`).set('Authorization', ownerAuth());

    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          // A soft-deleted PROJECT takes its tasks out of the list with it —
          // without this, removing a project would leave its work on screen.
          project: { companyId: COMPANY_ID, deletedAt: null },
        },
      })
    );
  });

  it('narrows to one specialist’s work when asked', async () => {
    await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}&specialistUserId=${BOOKKEEPER_ID}`)
      .set('Authorization', ownerAuth());

    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ specialistUserId: BOOKKEEPER_ID }),
      })
    );
  });

  it('reports every status in the counters, including the empty ones', async () => {
    mockPrisma.projectTask.groupBy.mockResolvedValue([
      { status: 'TODO', _count: { _all: 2 } },
      { status: 'COMPLETED', _count: { _all: 5 } },
    ]);

    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    // ACTIVE is 0 rather than absent: a counter that vanishes at nought makes
    // the UI shift as work is completed.
    expect(res.body.data.statusCounts).toEqual({ TODO: 2, ACTIVE: 0, COMPLETED: 5 });
  });

  it('requires companyId — an unfiltered read would merge two clients (400)', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyId).toBeDefined();
  });

  it('lets a specialist on the account read it, not only the customer (200)', async () => {
    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}`)
      .set('Authorization', specialistAuth());

    expect(res.status).toBe(200);
  });

  it('refuses someone with no connection to the company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ ownerUserId: 999, accountingManagerUserId: 998, bookkeepingSpecialistUserId: null })
    );

    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('refuses an admin, matching projects — rank is not membership (403)', async () => {
    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}`)
      .set('Authorization', adminAuth());

    expect(res.status).toBe(403);
  });

  it('rejects an unknown query parameter rather than ignoring it (400)', async () => {
    const res = await request(app)
      .get(`/api/tasks?companyId=${COMPANY_ID}&assignee=77`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
  });
});

/* ================== GET /projects/:projectId/tasks — per project =========== */

describe('GET /projects/:projectId/tasks', () => {
  it('returns the project’s tasks (200)', async () => {
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/tasks`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.projectId).toBe(PROJECT_ID);
    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: PROJECT_ID, deletedAt: null } })
    );
  });

  it('404s a missing or soft-deleted project before it lists anything', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/tasks`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    // A caller who cannot see the project cannot enumerate its tasks either.
    expect(mockPrisma.projectTask.findMany).not.toHaveBeenCalled();
  });

  it('orders by deadline, soonest first, with id breaking the tie', async () => {
    await request(app).get(`/api/projects/${PROJECT_ID}/tasks`).set('Authorization', ownerAuth());

    // Tasks routinely share a deadline; without the tiebreaker a row can appear
    // on two pages while another is skipped.
    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ deadlineDate: 'asc' }, { id: 'desc' }] })
    );
  });
});

/* ========================= POST /tasks — filing one ======================== */

describe('POST /tasks', () => {
  const body = (overrides = {}) => ({
    projectId: PROJECT_ID,
    taskName: 'Reconcile October bank feed',
    description: 'Match the Chase feed against the ledger and clear exceptions.',
    deadlineDate: VALID_TASK_DEADLINE,
    ...overrides,
  });

  it('lets the project’s assigned specialist file one (201)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body());

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/tasks/${TASK_ID}`);
    expect(res.body.data.id).toBe(TASK_ID);
  });

  it('copies the specialist from the project and the creator from the token', async () => {
    await request(app).post('/api/tasks').set('Authorization', specialistAuth()).send(body());

    /*
     * Neither value is taken from the request. The specialist is copied because
     * the database no longer pins the two together — the composite foreign key
     * was dropped — so this assignment is the only thing making them agree.
     */
    expect(mockPrisma.projectTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: PROJECT_ID,
          specialistUserId: BOOKKEEPER_ID,
          createdByUserId: BOOKKEEPER_ID,
          deadlineDate: new Date(`${VALID_TASK_DEADLINE}T00:00:00.000Z`),
        }),
      })
    );
  });

  /* ---- rule 1: the deadline falls after the project's ---- */

  it('refuses a deadline BEFORE the project’s (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ deadlineDate: '2026-11-01' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEADLINE_BEFORE_PROJECT');
    // The bound is named, so the caller does not have to guess a valid date.
    expect(res.body.error.details.projectDeadlineDate).toBe(PROJECT_DEADLINE);
    expect(mockPrisma.projectTask.create).not.toHaveBeenCalled();
  });

  it('refuses a deadline EQUAL to the project’s — "after" is strict (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ deadlineDate: PROJECT_DEADLINE }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEADLINE_BEFORE_PROJECT');
  });

  it('accepts the very next day (201)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ deadlineDate: '2027-01-01' }));

    expect(res.status).toBe(201);
  });

  it('does NOT require the deadline to be in the future — an overdue project still takes tasks (201)', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(
      projectAccessRow({ deadlineDate: new Date('2020-01-01T00:00:00.000Z') })
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ deadlineDate: '2020-06-01' }));

    // The binding rule is "after the project", not "after today". Applying both
    // would refuse ordinary work filed against an overdue project.
    expect(res.status).toBe(201);
  });

  /* ---- rule 2: only the project's specialist ---- */

  it('refuses the customer who opened the project (403)', async () => {
    const res = await request(app).post('/api/tasks').set('Authorization', ownerAuth()).send(body());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TASK_ACCESS_DENIED');
    expect(mockPrisma.projectTask.create).not.toHaveBeenCalled();
  });

  it('lets the company’s OWN accounting manager file one (201)', async () => {
    const res = await request(app).post('/api/tasks').set('Authorization', managerAuth()).send(body());

    // They run the account, so planning the work on it is theirs.
    expect(res.status).toBe(201);
    expect(mockPrisma.projectTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdByUserId: MANAGER_ID,
          // Still the PROJECT's specialist, not the manager — who filed it and
          // who owns it are different questions.
          specialistUserId: BOOKKEEPER_ID,
        }),
      })
    );
  });

  it('refuses an accounting manager who does not manage THIS company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: 997 }));

    const res = await request(app).post('/api/tasks').set('Authorization', managerAuth()).send(body());

    // Holding ACCOUNTING_MANAGER says what kind of actor they are; being THIS
    // company's manager is what makes the account theirs.
    expect(res.status).toBe(403);
  });

  it('lets the manager file against a project nobody is staffed on yet (201)', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(projectAccessRow({ assignedSpecialistUserId: null }));
    mockPrisma.projectTask.create.mockResolvedValue(taskRow({ specialistUserId: null, specialist: null }));

    const res = await request(app).post('/api/tasks').set('Authorization', managerAuth()).send(body());

    // A null specialist is truthful rather than missing, and
    // backfillSpecialists carries the task to whoever is appointed.
    expect(res.status).toBe(201);
    expect(mockPrisma.projectTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ specialistUserId: null }) })
    );
    expect(res.body.data.specialist).toBeNull();
  });

  it('refuses a DIFFERENT specialist on the same company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ bookkeepingSpecialistUserId: OTHER_SPECIALIST_ID })
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', otherSpecialistAuth())
      .send(body());

    // They can read the account, but the project is not theirs.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TASK_ACCESS_DENIED');
  });

  it('refuses an admin (403)', async () => {
    const res = await request(app).post('/api/tasks').set('Authorization', adminAuth()).send(body());

    expect(res.status).toBe(403);
  });

  it('409s a project nobody is staffed on, rather than a confusing 403', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(
      projectAccessRow({ assignedSpecialistUserId: null })
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROJECT_UNSTAFFED');
  });

  /* ---- the payload ---- */

  it('checks a sent companyId against the project instead of trusting it (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ companyId: OTHER_COMPANY_ID }));

    // Writing to the project's company anyway would hide the client's bug
    // behind a 201.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMPANY_PROJECT_MISMATCH');
  });

  it('accepts a companyId that agrees with the project (201)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ companyId: COMPANY_ID }));

    expect(res.status).toBe(201);
  });

  it('refuses a specialistUserId in the body — it is not the caller’s to choose (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ specialistUserId: OTHER_SPECIALIST_ID }));

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('specialistUserId');
  });

  it('requires a description, matching the NOT NULL column (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ description: '   ' }));

    expect(res.status).toBe(400);
    expect(res.body.error.fields.description).toBeDefined();
  });

  it('requires a non-blank task name (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ taskName: '  ' }));

    expect(res.status).toBe(400);
  });

  it('rejects a date that does not exist (400)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body({ deadlineDate: '2027-02-31' }));

    expect(res.status).toBe(400);
    expect(res.body.error.fields.deadlineDate).toBeDefined();
  });

  it('accepts the snake_case a form encoder sends (201)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send({
        project_id: PROJECT_ID,
        task_name: 'Reconcile October bank feed',
        description: 'Match the Chase feed against the ledger.',
        deadline_date: VALID_TASK_DEADLINE,
      });

    expect(res.status).toBe(201);
  });

  it('404s a project that does not exist (404)', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', specialistAuth())
      .send(body());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});

/* ==================== PATCH /tasks/:taskId/status ========================== */

describe('PATCH /tasks/:taskId/status', () => {
  beforeEach(() => {
    mockPrisma.projectTask.findFirst.mockResolvedValue(taskAccessRow());
  });

  it('lets the assigned specialist move it (200)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(mockPrisma.projectTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID }, data: { status: 'ACTIVE' } })
    );
  });

  it('upper-cases what the client sent (200)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(mockPrisma.projectTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'COMPLETED' } })
    );
  });

  it('allows COMPLETED back to ACTIVE — no state machine is imposed (200)', async () => {
    mockPrisma.projectTask.findFirst.mockResolvedValue(taskAccessRow({ status: 'COMPLETED' }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'ACTIVE' });

    // Undoing a mis-click is a correction, not an invalid transition.
    expect(res.status).toBe(200);
  });

  it('lets the company’s OWN accounting manager move it (200)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', managerAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(200);
  });

  it('refuses an accounting manager from a different company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: 997 }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', managerAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(403);
    expect(mockPrisma.projectTask.update).not.toHaveBeenCalled();
  });

  it('refuses a specialist who is not the one on this project (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ bookkeepingSpecialistUserId: OTHER_SPECIALIST_ID })
    );

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', otherSpecialistAuth())
      .send({ status: 'ACTIVE' });

    // They can read the account; the project is not theirs.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TASK_ACCESS_DENIED');
    expect(mockPrisma.projectTask.update).not.toHaveBeenCalled();
  });

  it('refuses an admin (403)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', adminAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(403);
    expect(mockPrisma.projectTask.update).not.toHaveBeenCalled();
  });

  it('refuses the customer who owns the account (403)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', ownerAuth())
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(403);
  });

  it('404s a missing task (404)', async () => {
    mockPrisma.projectTask.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  it('404s a task whose project has since been soft-deleted (404)', async () => {
    mockPrisma.projectTask.findFirst.mockResolvedValue(
      taskAccessRow({
        project: { ...taskAccessRow().project, deletedAt: new Date('2026-08-05T00:00:00Z') },
      })
    );

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'ACTIVE' });

    // It must not be reachable through a door the lists have already closed.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('rejects a status outside the enum (400)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'BLOCKED' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.allowed).toEqual(['TODO', 'ACTIVE', 'COMPLETED']);
  });

  it('requires a status (400)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects a rename smuggled in beside the status (400)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}/status`)
      .set('Authorization', specialistAuth())
      .send({ status: 'ACTIVE', taskName: 'Renamed' });

    // Silently dropping it would be the worst outcome: the request succeeds and
    // the value the user typed was never stored.
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('taskName');
  });
});

/* ============================ GET /tasks/:taskId =========================== */

describe('GET /tasks/:taskId', () => {
  it('returns one task (200)', async () => {
    const res = await request(app)
      .get(`/api/tasks/${TASK_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(TASK_ID);
    expect(res.body.data.deadlineDate).toBe(VALID_TASK_DEADLINE);
  });

  it('404s a missing task (404)', async () => {
    mockPrisma.projectTask.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/tasks/${TASK_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(404);
  });

  it('applies the project read rule, not the task’s own (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ ownerUserId: 999, accountingManagerUserId: 998, bookkeepingSpecialistUserId: null })
    );

    const res = await request(app)
      .get(`/api/tasks/${TASK_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
  });

  it('rejects a non-numeric id (400)', async () => {
    const res = await request(app).get('/api/tasks/abc').set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
  });
});
