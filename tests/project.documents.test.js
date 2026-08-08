'use strict';

/**
 * Integration tests for the project-document endpoints — upload, list, download
 * and delete — through the real Express app with Prisma mocked.
 *
 * Real multipart bodies are posted, so multer actually runs and actually writes
 * files. That is the point: the rules worth testing here (the type allowlist, the
 * generated storage name, the cleanup after a rejected upload) are enforced by
 * the middleware and the filesystem, and a test that stubbed them out would
 * assert nothing about the behaviour that matters.
 *
 * The uploads go to a temporary directory, set BEFORE the app is required so
 * config picks it up, and the whole tree is removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DOCUMENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-docs-'));
process.env.UPLOAD_DOCUMENTS_DIR = DOCUMENTS_DIR;

const mockPrisma = {
  user: { findUnique: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn() },
  project: { findFirst: jest.fn() },
  projectDocument: {
    createManyAndReturn: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    aggregate: jest.fn(),
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
const OUTSIDER_ID = 99;
const SPECIALIST_ID = 77;
const COMPANY_ID = 900;
const OTHER_COMPANY_ID = 901;
const PROJECT_ID = 300;
const DOCUMENT_ID = 7;

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const ownerAuth = () => auth();
const outsiderAuth = () => auth({ userId: OUTSIDER_ID });

function person(id, role = 'CUSTOMER', specificRole = 'OWNER') {
  return {
    id,
    firstName: 'Ada',
    lastName: 'Hopper',
    status: 'ACTIVE',
    role: { code: role },
    specificRole: specificRole ? { code: specificRole } : null,
  };
}

function company(overrides = {}) {
  return {
    id: COMPANY_ID,
    companyName: 'ABC Aerospace LLC',
    ownerUserId: OWNER_ID,
    accountingManagerUserId: 55,
    bookkeepingSpecialistUserId: SPECIALIST_ID,
    payrollSpecialistUserId: null,
    taxSpecialistUserId: null,
    ...overrides,
  };
}

/** A project row as projectRepository.findProjectForAccess returns it. */
function project(overrides = {}) {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    createdByUserId: OWNER_ID,
    assignedSpecialistUserId: SPECIALIST_ID,
    status: 'ACTIVE',
    ...overrides,
  };
}

/** A document row as projectDocumentRepository.DOCUMENT_SELECT returns it. */
function documentRow(overrides = {}) {
  return {
    id: DOCUMENT_ID,
    projectId: PROJECT_ID,
    originalName: 'statement.pdf',
    mimeType: 'application/pdf',
    // BIGINT — Prisma hands back a BigInt, and JSON.stringify throws on one.
    sizeBytes: BigInt(2048),
    uploadedByUserId: OWNER_ID,
    createdAt: new Date('2026-01-05T10:00:00Z'),
    updatedAt: new Date('2026-01-05T10:00:00Z'),
    uploadedBy: {
      id: OWNER_ID,
      firstName: 'Ada',
      lastName: 'Hopper',
      email: 'ada@finopsys.ai',
      jobTitle: 'Founder',
      avatarKey: null,
    },
    ...overrides,
  };
}

/** Everything a request by the owner against a live project needs to resolve. */
function stageOwnerOnLiveProject() {
  mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
  mockPrisma.project.findFirst.mockResolvedValue(project());
  mockPrisma.company.findFirst.mockResolvedValue(company());
}

/** Every file written under the temp documents root, as relative keys. */
function storedFiles() {
  const root = path.join(DOCUMENTS_DIR, 'projects');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(path.join(root, dir))) out.push(`${dir}/${name}`);
  }
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(path.join(DOCUMENTS_DIR, 'projects'), { recursive: true, force: true });
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
});

afterAll(() => {
  fs.rmSync(DOCUMENTS_DIR, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* upload                                                                     */
/* -------------------------------------------------------------------------- */

describe('POST /projects/:projectId/documents', () => {
  it('stores the file and records what was measured from it, not what was claimed', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.createManyAndReturn.mockResolvedValue([{ id: DOCUMENT_ID }]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([documentRow()]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('%PDF-1.4 pretend'), {
        filename: 'Q4 statement.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.uploaded).toBe(1);
    expect(res.body.data.companyId).toBe(COMPANY_ID);

    const [row] = mockPrisma.projectDocument.createManyAndReturn.mock.calls[0][0].data;
    expect(row.projectId).toBe(PROJECT_ID);
    expect(row.uploadedByUserId).toBe(OWNER_ID);
    expect(row.originalName).toBe('Q4 statement.pdf');
    expect(row.mimeType).toBe('application/pdf');
    expect(row.sizeBytes).toBe(BigInt(Buffer.from('%PDF-1.4 pretend').length));

    // The stored name is generated, never the uploaded one.
    expect(row.fileKey).toMatch(new RegExp(`^projects/${PROJECT_ID}/[0-9a-f]{32}\\.pdf$`));
    expect(storedFiles()).toHaveLength(1);
  });

  it('serialises the BIGINT size as a JSON number rather than throwing on it', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.createManyAndReturn.mockResolvedValue([{ id: DOCUMENT_ID }]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([documentRow()]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.documents[0].sizeBytes).toBe(2048);
    // The storage key is internal and must never reach the client.
    expect(JSON.stringify(res.body)).not.toContain('fileKey');
  });

  it('accepts several files in one request and writes them in one transaction', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.createManyAndReturn.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([
      documentRow({ id: 1, originalName: 'a.pdf' }),
      documentRow({ id: 2, originalName: 'b.csv', mimeType: 'text/csv' }),
    ]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('one'), { filename: 'a.pdf', contentType: 'application/pdf' })
      .attach('documents', Buffer.from('two'), { filename: 'b.csv', contentType: 'text/csv' });

    expect(res.status).toBe(201);
    expect(res.body.data.uploaded).toBe(2);
    expect(mockPrisma.projectDocument.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(storedFiles()).toHaveLength(2);
  });

  it('refuses a caller who is not on the project’s company, and leaves no file behind', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', outsiderAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('secret'), {
        filename: 'x.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
    expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    // The bytes reached disk before the check could run; they must not stay.
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a companyId that is not the project’s, and leaves no file behind', async () => {
    stageOwnerOnLiveProject();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(OTHER_COMPANY_ID))
      .attach('documents', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROJECT_COMPANY_MISMATCH');
    expect(storedFiles()).toEqual([]);
  });

  it('refuses an ADMIN, who is on no company, and leaves no file behind', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(1, 'ADMIN', null));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', auth({ userId: 1, role: 'ADMIN', specificRole: null }))
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
    expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    expect(storedFiles()).toEqual([]);
  });

  it('rejects a file type that is not on the allowlist', async () => {
    stageOwnerOnLiveProject();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('<svg onload=alert(1)>'), {
        filename: 'payload.svg',
        contentType: 'image/svg+xml',
      });

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(storedFiles()).toEqual([]);
  });

  it('requires companyId', async () => {
    stageOwnerOnLiveProject();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .attach('documents', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.companyId).toBeDefined();
    expect(storedFiles()).toEqual([]);
  });

  it('accepts company_id, since a multipart body never reaches the case normaliser', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.createManyAndReturn.mockResolvedValue([{ id: DOCUMENT_ID }]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([documentRow()]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('company_id', String(COMPANY_ID))
      .attach('documents', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
  });

  it('404s on a soft-deleted project without writing anything', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth())
      .field('companyId', String(COMPANY_ID))
      .attach('documents', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    expect(storedFiles()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* list                                                                       */
/* -------------------------------------------------------------------------- */

describe('GET /projects/:projectId/documents', () => {
  it('returns the page with totals for the whole project', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findMany.mockResolvedValue([documentRow()]);
    mockPrisma.projectDocument.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _sum: { sizeBytes: BigInt(9000) },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.totals).toEqual({ count: 3, sizeBytes: 9000 });
    expect(res.body.data.pagination.hasMore).toBe(true);
    expect(res.body.data.documents[0].downloadUrl).toContain(
      `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`
    );
  });

  it('lets a specialist assigned to the account read the attachments', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(SPECIALIST_ID, 'SPECIALIST', 'SPECIALIST_3'));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.projectDocument.findMany.mockResolvedValue([]);
    mockPrisma.projectDocument.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _sum: { sizeBytes: null },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', auth({ userId: SPECIALIST_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' }));

    expect(res.status).toBe(200);
    // No rows, and a null SUM — which must serialise as 0, not as null.
    expect(res.body.data.totals).toEqual({ count: 0, sizeBytes: 0 });
  });

  it('refuses an outsider', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', outsiderAuth());

    expect(res.status).toBe(403);
  });

  /*
   * An ADMIN is refused like anyone else who is not on the company. This is the
   * one case where the rule here diverges from the rest of the API, so it is
   * asserted rather than left to follow from the shared access helper.
   */
  it('refuses an ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(1, 'ADMIN', null));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents`)
      .set('Authorization', auth({ userId: 1, role: 'ADMIN', specificRole: null }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
    expect(mockPrisma.projectDocument.findMany).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* download                                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /projects/:projectId/documents/:documentId/download', () => {
  /** Put a real file where a stored key says it is. */
  function writeStoredFile(fileKey, contents) {
    const abs = path.join(DOCUMENTS_DIR, fileKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    return abs;
  }

  it('serves the bytes as an attachment, uncacheable, with the original name', async () => {
    const fileKey = `projects/${PROJECT_ID}/abc123.pdf`;
    writeStoredFile(fileKey, 'the actual bytes');

    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...documentRow(),
      fileKey,
      project: { id: PROJECT_ID, companyId: COMPANY_ID, createdByUserId: OWNER_ID, assignedSpecialistUserId: SPECIALIST_ID, deletedAt: null },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', ownerAuth())
      // application/pdf has no superagent parser, so the body arrives as a
      // Buffer only when buffering is asked for explicitly.
      .buffer();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('statement.pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.toString()).toBe('the actual bytes');
  });

  it('404s when the document belongs to a different project than the URL claims', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...documentRow({ projectId: 555 }),
      fileKey: 'projects/555/abc.pdf',
      project: { id: 555, companyId: OTHER_COMPANY_ID, createdByUserId: 1, assignedSpecialistUserId: null, deletedAt: null },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('refuses an outsider before reading anything from disk', async () => {
    const fileKey = `projects/${PROJECT_ID}/def456.pdf`;
    writeStoredFile(fileKey, 'confidential');

    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...documentRow(),
      fileKey,
      project: { id: PROJECT_ID, companyId: COMPANY_ID, createdByUserId: OWNER_ID, assignedSpecialistUserId: SPECIALIST_ID, deletedAt: null },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', outsiderAuth());

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('confidential');
  });
});

/* -------------------------------------------------------------------------- */
/* delete                                                                     */
/* -------------------------------------------------------------------------- */

describe('DELETE /projects/:projectId/documents/:documentId', () => {
  const withProject = (overrides = {}) => ({
    ...documentRow(overrides),
    fileKey: `projects/${PROJECT_ID}/abc.pdf`,
    project: {
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      createdByUserId: OWNER_ID,
      assignedSpecialistUserId: SPECIALIST_ID,
      deletedAt: null,
    },
  });

  it('soft deletes rather than removing the row', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findFirst.mockResolvedValue(withProject());
    mockPrisma.projectDocument.update.mockResolvedValue({ id: DOCUMENT_ID, deletedAt: new Date() });

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    const call = mockPrisma.projectDocument.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: DOCUMENT_ID });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses a teammate who can read the project but did not upload the file', async () => {
    const TEAMMATE_ID = 61;
    mockPrisma.user.findUnique.mockResolvedValue(person(TEAMMATE_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    // Read access comes from company_members; write access does not.
    mockPrisma.companyMember.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.projectDocument.findFirst.mockResolvedValue(withProject());

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROJECT_ACCESS_DENIED');
    expect(mockPrisma.projectDocument.update).not.toHaveBeenCalled();
  });

  it('lets the uploader remove their own file even without write access to the project', async () => {
    const TEAMMATE_ID = 61;
    mockPrisma.user.findUnique.mockResolvedValue(person(TEAMMATE_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.companyMember.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.projectDocument.findFirst.mockResolvedValue(
      withProject({ uploadedByUserId: TEAMMATE_ID })
    );
    mockPrisma.projectDocument.update.mockResolvedValue({ id: DOCUMENT_ID, deletedAt: new Date() });

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID }));

    expect(res.status).toBe(200);
  });
});
