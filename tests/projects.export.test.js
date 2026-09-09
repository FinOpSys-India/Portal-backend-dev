'use strict';

/**
 * Integration tests for the two CSV exports, through the real Express app with
 * Prisma mocked.
 *
 * What is worth asserting on a file endpoint is not the same as on a JSON one.
 * The cases here are the three ways a CSV export goes wrong in a way no status
 * code reveals:
 *
 *   the ESCAPING     a project called `=cmd|'/c calc'!A1` is a formula the
 *                    moment someone opens the download, and a name containing a
 *                    comma silently becomes two columns.
 *   the SCOPE        an export is the one read that hands over an entire book of
 *                    work in a single response, so a specialist seeing a row the
 *                    table would have hidden leaks all of them at once.
 *   the SHAPE        a project with no tasks must still produce a row, and the
 *                    project columns must repeat down the left of every task.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySubscriptionItem: { findMany: jest.fn() },
  companySpecialistAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  project: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  projectTask: { findMany: jest.fn(), count: jest.fn() },
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
const { MAX_ROWS } = require('../src/services/projectExportService');

const OWNER_ID = 42;
const MANAGER_ID = 55;
const BOOKKEEPER_ID = 77;
const OTHER_BOOKKEEPER_ID = 78;
const COMPANY_ID = 900;
const PROJECT_ID = 300;
const BOOKKEEPING_PLAN_ID = 5;

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const ownerAuth = () => auth();
const specialistAuth = (id = BOOKKEEPER_ID) =>
  auth({ userId: id, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' });

// `phone`, `jobTitle` and `ownedCompanies` satisfy requirePaidAccount, which
// gates every /projects route — see the note in projects.test.js.
function person(id, first, last, role, specificRole = null) {
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
    // NUMERIC(5,2) — the driver hands these back as strings, not numbers.
    progressBar: '40.00',
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

/** A row as projectTaskRepository's TASK_SELECT returns it. */
function taskRow(overrides = {}) {
  return {
    id: 700,
    projectId: PROJECT_ID,
    taskName: 'Reconcile bank feed',
    description: null,
    status: 'ACTIVE',
    deadlineDate: new Date('2026-12-20T00:00:00.000Z'),
    specialistUserId: BOOKKEEPER_ID,
    createdByUserId: OWNER_ID,
    createdAt: new Date('2026-08-02T09:00:00Z'),
    updatedAt: new Date('2026-08-02T09:00:00Z'),
    project: {
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      projectName: 'Q4 Books Close',
      status: 'TODO',
      deadlineDate: new Date('2026-12-31T00:00:00.000Z'),
      company: { id: COMPANY_ID, companyName: 'ABC Aerospace LLC' },
    },
    specialist: {
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

/* -------------------------------------------------------------------------- */
/* reading the file back                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Split a CSV response into rows of fields, honouring quotes.
 *
 * Deliberately a real (if small) parser rather than `split(',')`: the escaping
 * is the thing under test, so a test helper that cannot read a quoted field
 * would pass on exactly the files that are broken.
 */
function parseCsv(body) {
  const text = body.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

  mockPrisma.user.findUnique.mockImplementation(({ where }) =>
    Promise.resolve(
      {
        [OWNER_ID]: person(OWNER_ID, 'John', 'Smith', 'CUSTOMER', 'OWNER'),
        [MANAGER_ID]: person(MANAGER_ID, 'Sarah', 'Jones', 'ACCOUNTING_MANAGER'),
        [BOOKKEEPER_ID]: person(BOOKKEEPER_ID, 'Bella', 'Keeper', 'SPECIALIST', 'SPECIALIST_3'),
        [OTHER_BOOKKEEPER_ID]: person(OTHER_BOOKKEEPER_ID, 'Otto', 'Ledger', 'SPECIALIST', 'SPECIALIST_3'),
        1: person(1, 'Root', 'Admin', 'ADMIN'),
      }[where.id] ?? null
    )
  );

  mockPrisma.company.findFirst.mockResolvedValue(company());
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  /*
   * The "is this caller an active specialist on the company?" door, answered per
   * user rather than with a blanket row.
   *
   * A fixed `{ id: 1 }` here would let EVERY caller through it — including the
   * admin, who the project rules refuse on purpose — and the suite would then
   * pass while asserting the opposite of the rule. Only the two bookkeepers are
   * on the bench.
   */
  mockPrisma.companySpecialistAssignment.findFirst.mockImplementation(({ where }) =>
    Promise.resolve(
      [BOOKKEEPER_ID, OTHER_BOOKKEEPER_ID].includes(where.specialistUserId) ? { id: 1 } : null
    )
  );
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.companySubscriptionItem.findMany.mockResolvedValue([]);
  mockPrisma.project.findMany.mockResolvedValue([projectRow()]);
  mockPrisma.project.findFirst.mockResolvedValue(projectRow());
  mockPrisma.projectTask.findMany.mockResolvedValue([taskRow()]);
});

/* -------------------------------------------------------------------------- */
/* GET /projects/export                                                       */
/* -------------------------------------------------------------------------- */

describe('GET /projects/export', () => {
  it('returns the company project list as a downloadable CSV (200)', async () => {
    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    // The file is named after the account it describes, so it is recognisable in
    // a downloads folder without being opened. The colon a reader would write
    // between the two halves is not legal in a filename, so it is a hyphen.
    expect(res.headers['content-disposition']).toMatch(
      /filename\*=UTF-8''ABC%20Aerospace%20LLC%20-%20list%20of%20projects\.csv/
    );
    expect(res.headers['cache-control']).toBe('no-store');

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      '#',
      'Company',
      'Project',
      'Service',
      'Deadline',
      'Status',
      'Progress (%)',
      'Specialist',
      'Created',
    ]);
    expect(rows[1]).toEqual([
      '1',
      'ABC Aerospace LLC',
      'Q4 Books Close',
      'Bookkeeping',
      '2026-12-31',
      'TODO',
      '40',
      'Bella Keeper',
      '2026-08-01',
    ]);
  });

  it('numbers the rows from one, in the order they are written', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ id: 301, projectName: 'A' }),
      projectRow({ id: 302, projectName: 'B' }),
      projectRow({ id: 303, projectName: 'C' }),
    ]);

    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    const rows = parseCsv(res.text).slice(1);
    // A serial number describing this FILE — the row's position, counted from
    // one — not the project's id. It restarts at 1 on every download.
    expect(rows.map((r) => r[0])).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r[2])).toEqual(['A', 'B', 'C']);
  });

  it('carries the company name on every row', async () => {
    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(parseCsv(res.text)[1][1]).toBe('ABC Aerospace LLC');
  });

  it('opens with a UTF-8 BOM and ends its rows with CRLF, so Excel reads it', async () => {
    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text).toMatch(/\r\n$/);
  });

  it('neuters a project name a spreadsheet would run as a formula', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ projectName: "=cmd|'/c calc'!A1" }),
    ]);

    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    // The leading apostrophe is what makes a spreadsheet treat the cell as text.
    // Quoting alone would not: a reader strips the quotes before it looks.
    expect(parseCsv(res.text)[1][2]).toBe("'=cmd|'/c calc'!A1");
  });

  it('keeps a name containing a comma or a quote in one column', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ projectName: 'Q4 Books, "final"' }),
    ]);

    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    const rows = parseCsv(res.text);
    expect(rows[1]).toHaveLength(9);
    expect(rows[1][2]).toBe('Q4 Books, "final"');
  });

  it('leaves the specialist cell empty on an unstaffed project rather than writing "null"', async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      projectRow({ assignedSpecialistUserId: null, assignedSpecialist: null }),
    ]);

    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(parseCsv(res.text)[1][7]).toBe('');
  });

  it('narrows a specialist to their own projects, exactly as the table does', async () => {
    await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}&assigned_specialist_user_id=${OTHER_BOOKKEEPER_ID}`)
      .set('Authorization', specialistAuth());

    // The requested filter is REPLACED by the caller's own id, not merged with
    // it — otherwise the one filter on this endpoint would be the way around the
    // rule it exists to enforce.
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedSpecialistUserId: BOOKKEEPER_ID }),
      })
    );
  });

  it('passes the table filters through to the query', async () => {
    await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}&status=ACTIVE&search=books`)
      .set('Authorization', ownerAuth());

    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: COMPANY_ID,
          deletedAt: null,
          status: 'ACTIVE',
          projectName: { contains: 'books', mode: 'insensitive' },
        }),
      })
    );
  });

  it('refuses limit and offset — an export is the whole result set (400)', async () => {
    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}&limit=10`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires companyId (400)', async () => {
    const res = await request(app).get('/api/projects/export').set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyId).toBeDefined();
  });

  it('refuses an oversized export by name rather than truncating it (400)', async () => {
    mockPrisma.project.findMany.mockResolvedValue(
      Array.from({ length: MAX_ROWS + 1 }, (_, i) => projectRow({ id: i + 1 }))
    );

    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EXPORT_TOO_LARGE');
    expect(res.body.error.details.limit).toBe(MAX_ROWS);
  });

  it('answers a failure with the JSON envelope, not a CSV', async () => {
    const res = await request(app)
      .get(`/api/projects/export?company_id=${COMPANY_ID}`)
      .set('Authorization', auth({ userId: 1, role: 'ADMIN', specificRole: null }));

    // An admin is on no company, so the project read rule refuses them — and the
    // refusal must be readable, not saved to disk as a spreadsheet.
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unauthenticated caller (401)', async () => {
    const res = await request(app).get(`/api/projects/export?company_id=${COMPANY_ID}`);
    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /projects/:projectId/export                                            */
/* -------------------------------------------------------------------------- */

describe('GET /projects/:projectId/export', () => {
  it('returns one row per task with the project repeated down the left (200)', async () => {
    mockPrisma.projectTask.findMany.mockResolvedValue([
      taskRow(),
      taskRow({
        id: 701,
        taskName: 'Close the period',
        status: 'TODO',
        deadlineDate: new Date('2026-12-28T00:00:00.000Z'),
        specialist: null,
        specialistUserId: null,
        createdAt: new Date('2026-08-03T09:00:00Z'),
      }),
    ]);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // The project's own name, spaces and capitals intact.
    expect(res.headers['content-disposition']).toMatch(
      /filename\*=UTF-8''Q4%20Books%20Close\.csv/
    );

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      '#',
      'Company',
      'Project',
      'Service',
      'Project Deadline',
      'Project Status',
      'Project Specialist',
      'Task',
      'Task Status',
      'Task Deadline',
      'Task Specialist',
      'Task Created',
    ]);
    expect(rows).toHaveLength(3);

    expect(rows[1]).toEqual([
      '1', 'ABC Aerospace LLC', 'Q4 Books Close', 'Bookkeeping', '2026-12-31', 'TODO', 'Bella Keeper',
      'Reconcile bank feed', 'ACTIVE', '2026-12-20', 'Bella Keeper', '2026-08-02',
    ]);
    expect(rows[2]).toEqual([
      '2', 'ABC Aerospace LLC', 'Q4 Books Close', 'Bookkeeping', '2026-12-31', 'TODO', 'Bella Keeper',
      'Close the period', 'TODO', '2026-12-28', '', '2026-08-03',
    ]);
  });

  it('still returns a row for a project with no tasks (200)', async () => {
    mockPrisma.projectTask.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    // Header plus one row: the project, with every task column blank. A header
    // and nothing else reads as a failed download.
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(0, 7)).toEqual([
      '1', 'ABC Aerospace LLC', 'Q4 Books Close', 'Bookkeeping', '2026-12-31', 'TODO', 'Bella Keeper',
    ]);
    expect(rows[1].slice(7)).toEqual(['', '', '', '', '']);
  });

  it('exports every task on the project, unfiltered and unpaged', async () => {
    await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', ownerAuth());

    expect(mockPrisma.projectTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID, deletedAt: null },
        skip: 0,
      })
    );
  });

  it('lets the assigned specialist export their own project (200)', async () => {
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', specialistAuth());

    expect(res.status).toBe(200);
  });

  it('404s a specialist on a project they are not staffed on', async () => {
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', specialistAuth(OTHER_BOOKKEEPER_ID));

    // A 404 rather than a 403, matching GET /projects/:id: a 403 would confirm
    // which of the client's projects are real.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    // And it never got as far as reading the work.
    expect(mockPrisma.projectTask.findMany).not.toHaveBeenCalled();
  });

  it('404s a project that is missing or soft-deleted', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('refuses a caller with no route to the company (403)', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ ownerUserId: 999, accountingManagerUserId: 998, bookkeepingSpecialistUserId: null })
    );
    mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/export`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('400s a non-numeric project id rather than reaching the database', async () => {
    const res = await request(app)
      .get('/api/projects/not-a-number/export')
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
  });
});
