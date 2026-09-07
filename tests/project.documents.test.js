'use strict';

/**
 * Integration tests for the project-document endpoints — upload, list, download
 * and delete — through the real Express app with Prisma mocked.
 *
 * NO FILE TRAVELS THROUGH THE API ANY MORE, and that shapes how these read. The
 * browser uploads to a signed URL and downloads from one, so what is left for
 * this API to get right is the part around the bytes: who may ask, which key gets
 * issued, and — because the client is the only witness to its own upload — what
 * is believed about a file that was uploaded out of sight. Those are the
 * assertions here.
 *
 * The storage layer is stubbed in the suites that need the remote driver, since
 * config pins a test run to the LOCAL one so it can never write to a real bucket.
 * The local driver's own path is still exercised where it survives (the download
 * fallback, the delete), and it writes into a temporary directory set BEFORE the
 * app is required so config picks it up; the tree is removed afterwards.
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
  // `update` is the soft delete — DELETE /projects/:id, whose document cascade
  // is the subject of the last suite in this file.
  project: { findFirst: jest.fn(), update: jest.fn() },
  projectDocument: {
    createManyAndReturn: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    aggregate: jest.fn(),
    update: jest.fn(),
    // Deleting a PROJECT marks every document on it in one statement — see the
    // cascade suite at the bottom of this file.
    updateMany: jest.fn(),
  },
  // The same delete takes the project's tasks with it. They hold no bytes, so
  // the cascade for them is the one statement and nothing else.
  projectTask: { updateMany: jest.fn() },
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

/*
 * `phone`, `jobTitle` and `ownedCompanies` are here for requirePaidAccount, which
 * gates every /projects route: it asks onboardingService for the caller's status,
 * and an OWNER whose profile is half-filled or whose company carries no paid
 * subscription is refused with a 402 before any route in this file runs.
 *
 * They are on the shared fixture rather than staged per test because being a paid
 * account is the precondition for all of these tests, not the subject of any of
 * them — the paywall has its own suite. A non-owner passes the gate regardless,
 * so the extra fields are harmless for the specialist case.
 */
function person(id, role = 'CUSTOMER', specificRole = 'OWNER') {
  return {
    id,
    firstName: 'Ada',
    lastName: 'Hopper',
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
/* direct-to-bucket upload                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The ticket/confirm pair, which exists so a file larger than the host's request
 * ceiling can be uploaded at all: the browser asks for a signed URL, PUTs the
 * bytes to Supabase itself, then calls confirm to have them recorded.
 *
 * The storage layer is stubbed for the same reason as the signed-download suite —
 * the test run is pinned to the local driver so it can never write to a real
 * bucket, and these paths only exist under the remote one. What is under test is
 * not Supabase; it is the two decisions this API makes around it: that a ticket
 * is issued only to someone already allowed to upload, and that what gets
 * RECORDED comes from the bucket rather than from the client's account of itself.
 */
describe('direct upload: POST .../documents/upload-url and /confirm', () => {
  const storage = require('../src/utils/storage');
  const KEY = `projects/${PROJECT_ID}/${'a1b2c3d4'.repeat(4)}.pdf`;

  let remote;
  let ticket;
  let stat;
  let removed;

  beforeEach(() => {
    remote = jest.spyOn(storage, 'isRemote').mockReturnValue(true);
    ticket = jest.spyOn(storage, 'signedUploadUrl').mockImplementation(async ({ key }) => ({
      url: `https://project.supabase.co/storage/v1/object/upload/sign/${key}?token=t`,
      token: 't',
      key,
    }));
    stat = jest.spyOn(storage, 'statObject').mockResolvedValue({ sizeBytes: 5000, contentType: 'application/pdf' });
    removed = jest.spyOn(storage, 'removeObjects').mockResolvedValue(undefined);
  });

  afterEach(() => {
    remote.mockRestore();
    ticket.mockRestore();
    stat.mockRestore();
    removed.mockRestore();
  });

  const askFor = (files, companyId = COMPANY_ID) =>
    request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/upload-url`)
      .set('Authorization', ownerAuth())
      .send({ companyId, files });

  const pdf = (overrides = {}) => ({
    fileName: 'statement.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5000,
    ...overrides,
  });

  describe('upload-url', () => {
    it('issues one signed URL per file, under a key the caller did not choose', async () => {
      stageOwnerOnLiveProject();

      const res = await askFor([pdf(), pdf({ fileName: 'ledger.xlsx', mimeType: 'text/csv' })]);

      expect(res.status).toBe(201);
      expect(res.body.data.uploads).toHaveLength(2);

      // The key is generated here, from the allowlisted type — never from the
      // name the client sent. That is what makes the ticket a write to one path
      // rather than an open one.
      expect(res.body.data.uploads[0].key).toMatch(
        new RegExp(`^projects/${PROJECT_ID}/[0-9a-f]{32}\\.pdf$`)
      );
      expect(res.body.data.uploads[1].key).toMatch(
        new RegExp(`^projects/${PROJECT_ID}/[0-9a-f]{32}\\.csv$`)
      );
      expect(res.body.data.uploads[0].uploadUrl).toContain('supabase.co');
    });

    it('refuses a type outside the allowlist before any ticket exists', async () => {
      stageOwnerOnLiveProject();

      const res = await askFor([pdf({ fileName: 'run.exe', mimeType: 'application/x-msdownload' })]);

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(ticket).not.toHaveBeenCalled();
    });

    it('refuses a declared size over the cap, so nobody uploads for four minutes to be told no', async () => {
      stageOwnerOnLiveProject();

      const res = await askFor([pdf({ sizeBytes: 99 * 1024 * 1024 })]);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      expect(ticket).not.toHaveBeenCalled();
    });

    it('mints nothing for someone who is not on the project', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
      mockPrisma.project.findFirst.mockResolvedValue(project());
      mockPrisma.company.findFirst.mockResolvedValue(company());

      const res = await request(app)
        .post(`/api/projects/${PROJECT_ID}/documents/upload-url`)
        .set('Authorization', outsiderAuth())
        .send({ companyId: COMPANY_ID, files: [pdf()] });

      expect(res.status).toBe(403);
      expect(ticket).not.toHaveBeenCalled();
    });

    it('refuses when the request names a company the project does not belong to', async () => {
      stageOwnerOnLiveProject();

      const res = await askFor([pdf()], OTHER_COMPANY_ID);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PROJECT_COMPANY_MISMATCH');
      expect(ticket).not.toHaveBeenCalled();
    });

    it('is unavailable on a deployment that stores files locally', async () => {
      remote.mockReturnValue(false);
      stageOwnerOnLiveProject();

      const res = await askFor([pdf()]);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('DIRECT_TRANSFER_UNAVAILABLE');
    });
  });

  describe('confirm', () => {
    const confirm = (files, companyId = COMPANY_ID) =>
      request(app)
        .post(`/api/projects/${PROJECT_ID}/documents/confirm`)
        .set('Authorization', ownerAuth())
        .send({ companyId, files });

    /** No row yet for the key, then the created row read back. Both are findMany. */
    function stageInsert() {
      mockPrisma.projectDocument.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([documentRow()]);
      mockPrisma.projectDocument.createManyAndReturn.mockResolvedValue([{ id: DOCUMENT_ID }]);
    }

    it('records the size the BUCKET reports, not the one the client claims', async () => {
      stageOwnerOnLiveProject();
      stageInsert();
      stat.mockResolvedValue({ sizeBytes: 9_000_000, contentType: 'application/pdf' });

      const res = await confirm([{ key: KEY, fileName: 'Q4 statement.pdf' }]);

      expect(res.status).toBe(201);
      const [row] = mockPrisma.projectDocument.createManyAndReturn.mock.calls[0][0].data;
      expect(row.sizeBytes).toBe(BigInt(9_000_000));
      expect(row.fileKey).toBe(KEY);
      expect(row.originalName).toBe('Q4 statement.pdf');
      // From the extension we put in the key at ticket time — not from anything
      // the browser set as the object's content type.
      expect(row.mimeType).toBe('application/pdf');
      expect(row.uploadedByUserId).toBe(OWNER_ID);
    });

    it('refuses a key belonging to a different project', async () => {
      stageOwnerOnLiveProject();

      const res = await confirm([{ key: `projects/999/${'a1b2c3d4'.repeat(4)}.pdf`, fileName: 'theirs.pdf' }]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_UPLOAD_KEY');
      expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('refuses a key this API could never have issued', async () => {
      stageOwnerOnLiveProject();

      const res = await confirm([{ key: `projects/${PROJECT_ID}/../../secrets.env`, fileName: 'x.pdf' }]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_UPLOAD_KEY');
    });

    it('404s when the object never arrived, rather than recording a row pointing at nothing', async () => {
      stageOwnerOnLiveProject();
      mockPrisma.projectDocument.findMany.mockResolvedValueOnce([]);
      stat.mockResolvedValue(null);

      const res = await confirm([{ key: KEY, fileName: 'statement.pdf' }]);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
      expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('deletes an object that turns out to be over the cap, instead of leaving it stored', async () => {
      stageOwnerOnLiveProject();
      mockPrisma.projectDocument.findMany.mockResolvedValueOnce([]);
      // The ticket was issued against a modest declared size; the real object is
      // far larger. This is the check that makes the earlier one enforceable.
      stat.mockResolvedValue({ sizeBytes: 90 * 1024 * 1024, contentType: 'application/pdf' });

      const res = await confirm([{ key: KEY, fileName: 'huge.pdf' }]);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      expect(removed).toHaveBeenCalledWith(expect.objectContaining({ keys: [KEY] }));
      expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('refuses to record the same upload twice', async () => {
      stageOwnerOnLiveProject();
      mockPrisma.projectDocument.findMany.mockResolvedValueOnce([{ id: DOCUMENT_ID, fileKey: KEY }]);

      const res = await confirm([{ key: KEY, fileName: 'statement.pdf' }]);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCUMENT_ALREADY_RECORDED');
      expect(mockPrisma.projectDocument.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('refuses the same key twice within one request', async () => {
      stageOwnerOnLiveProject();

      const res = await confirm([
        { key: KEY, fileName: 'statement.pdf' },
        { key: KEY, fileName: 'statement.pdf' },
      ]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses an outsider before it looks at the bucket at all', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
      mockPrisma.project.findFirst.mockResolvedValue(project());
      mockPrisma.company.findFirst.mockResolvedValue(company());

      const res = await request(app)
        .post(`/api/projects/${PROJECT_ID}/documents/confirm`)
        .set('Authorization', outsiderAuth())
        .send({ companyId: COMPANY_ID, files: [{ key: KEY, fileName: 'statement.pdf' }] });

      expect(res.status).toBe(403);
      expect(stat).not.toHaveBeenCalled();
    });
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
/* download under the remote driver                                           */
/* -------------------------------------------------------------------------- */

/**
 * The signed-URL branch, which the rest of this file cannot reach.
 *
 * config.storage forces the LOCAL driver whenever NODE_ENV is 'test', so that a
 * test run can never write into a real bucket — which also means the branch that
 * only exists under the supabase driver would otherwise ship untested. Rather
 * than unset that guard (and give every future test file the power to touch live
 * storage), `storage.signedUrl` is stubbed here: it is the single function whose
 * returning a string is what "we are on the remote driver" means to everything
 * above it.
 *
 * What is being checked is not Supabase's URL format — that is their business —
 * but the two things this codebase decides: that a link is only minted AFTER the
 * access check, and that the redirect carrying it is not cacheable.
 */
describe('GET .../download under the supabase driver', () => {
  const storage = require('../src/utils/storage');
  const SIGNED = 'https://project.supabase.co/storage/v1/object/sign/project-documents/x?token=abc';

  let signed;

  beforeEach(() => {
    signed = jest.spyOn(storage, 'signedUrl').mockResolvedValue(SIGNED);
  });

  afterEach(() => signed.mockRestore());

  function stageDocument() {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...documentRow(),
      fileKey: `projects/${PROJECT_ID}/abc123.pdf`,
      project: { id: PROJECT_ID, companyId: COMPANY_ID, createdByUserId: OWNER_ID, assignedSpecialistUserId: SPECIALIST_ID, deletedAt: null },
    });
  }

  it('redirects to a signed link instead of sending the bytes', async () => {
    stageDocument();

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', ownerAuth())
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SIGNED);
    // Uncacheable: the Location header is a working capability for as long as the
    // link lives, and a cached 302 would hand it to the next person.
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('asks for the link with the original filename, so the browser saves it as an attachment', async () => {
    stageDocument();

    await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', ownerAuth())
      .redirects(0);

    expect(signed).toHaveBeenCalledWith(
      expect.objectContaining({ key: `projects/${PROJECT_ID}/abc123.pdf`, download: 'statement.pdf' })
    );
  });

  it('mints no link at all for someone who may not read the document', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...documentRow(),
      fileKey: `projects/${PROJECT_ID}/abc123.pdf`,
      project: { id: PROJECT_ID, companyId: COMPANY_ID, createdByUserId: OWNER_ID, assignedSpecialistUserId: SPECIALIST_ID, deletedAt: null },
    });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', outsiderAuth())
      .redirects(0);

    expect(res.status).toBe(403);
    expect(signed).not.toHaveBeenCalled();
  });

  it('404s when the object is gone, rather than redirecting to a link that would fail', async () => {
    // Supabase declines to sign a key that is not in the bucket, and there is no
    // local file behind this key either — so the request lands on the same 404 it
    // always did instead of sending the browser somewhere broken.
    signed.mockResolvedValue(null);
    stageDocument();

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/download`)
      .set('Authorization', ownerAuth())
      .redirects(0);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* delete                                                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* bulk download as links                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The alternative to the zip, for a client that would rather fetch the files
 * itself. The selection rules are the archive's — that is the whole point, since
 * the two answer the same question — so what is worth asserting here is the part
 * that differs: one link per document, an expiry the client is told about, and a
 * response that is not cacheable because it is a list of live capabilities.
 */
describe('POST /projects/:projectId/documents/links', () => {
  const storage = require('../src/utils/storage');

  let remote;
  let signed;

  beforeEach(() => {
    remote = jest.spyOn(storage, 'isRemote').mockReturnValue(true);
    signed = jest
      .spyOn(storage, 'signedUrl')
      .mockImplementation(async ({ key }) => `https://project.supabase.co/sign/${key}?token=t`);
  });

  afterEach(() => {
    remote.mockRestore();
    signed.mockRestore();
  });

  const row = (id, originalName) => ({
    id,
    fileKey: `projects/${PROJECT_ID}/${String(id).repeat(4)}abcdef.pdf`,
    originalName,
    mimeType: 'application/pdf',
    sizeBytes: BigInt(40 * 1024 * 1024),
    createdAt: new Date('2026-01-05T10:00:00Z'),
  });

  it('returns one link per document, with the expiry stated', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findMany.mockResolvedValue([row(1, 'statement.pdf'), row(2, 'return.pdf')]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', ownerAuth())
      .send({ documentIds: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.expiresInSeconds).toBeGreaterThan(0);
    expect(res.body.data.documents.map((d) => d.url)).toEqual([
      expect.stringContaining('supabase.co'),
      expect.stringContaining('supabase.co'),
    ]);
    // 40 MB each — far past anything the zip could return, which is why this
    // endpoint exists.
    expect(res.body.data.documents[0].sizeBytes).toBe(40 * 1024 * 1024);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('asks for each link under the document original name', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findMany.mockResolvedValue([row(1, 'statement.pdf')]);

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', ownerAuth())
      .send({});

    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ download: 'statement.pdf' }));
  });

  it('404s on an id that is not on this project, rather than dropping it silently', async () => {
    stageOwnerOnLiveProject();
    // Only one of the two asked-for ids resolves against this project.
    mockPrisma.projectDocument.findMany.mockResolvedValue([row(1, 'statement.pdf')]);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', ownerAuth())
      .send({ documentIds: [1, 2] });

    expect(res.status).toBe(404);
    expect(res.body.error.details.missing).toEqual([2]);
  });

  it('404s rather than returning a link that would fail', async () => {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findMany.mockResolvedValue([row(1, 'statement.pdf')]);
    signed.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', ownerAuth())
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('refuses an outsider without minting anything', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', outsiderAuth())
      .send({});

    expect(res.status).toBe(403);
    expect(signed).not.toHaveBeenCalled();
  });

  it('is unavailable on a deployment that stores files locally', async () => {
    remote.mockReturnValue(false);
    stageOwnerOnLiveProject();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/documents/links`)
      .set('Authorization', ownerAuth())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DIRECT_TRANSFER_UNAVAILABLE');
  });
});

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

  it('removes the stored file, so a delete actually frees the space', async () => {
    const fileKey = `projects/${PROJECT_ID}/tobin.pdf`;
    const abs = path.join(DOCUMENTS_DIR, fileKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'twenty megabytes, pretend');

    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findFirst.mockResolvedValue({ ...withProject(), fileKey });
    mockPrisma.projectDocument.update.mockResolvedValue({ id: DOCUMENT_ID, deletedAt: new Date() });

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    // The row is kept for the history; the bytes are not, because a marked-deleted
    // row that leaves its object behind means storage only ever grows.
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('still succeeds when the stored file is already gone', async () => {
    // A retried delete, or a row whose object was removed by hand. The user's
    // delete has nothing left to do and must not fail over it.
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findFirst.mockResolvedValue({
      ...withProject(),
      fileKey: `projects/${PROJECT_ID}/never-written.pdf`,
    });
    mockPrisma.projectDocument.update.mockResolvedValue({ id: DOCUMENT_ID, deletedAt: new Date() });

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it('leaves the file alone when the delete is refused', async () => {
    const TEAMMATE_ID = 61;
    const fileKey = `projects/${PROJECT_ID}/keepme.pdf`;
    const abs = path.join(DOCUMENTS_DIR, fileKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'still needed');

    mockPrisma.user.findUnique.mockResolvedValue(person(TEAMMATE_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.companyMember.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.projectDocument.findFirst.mockResolvedValue({ ...withProject(), fileKey });

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID }));

    expect(res.status).toBe(403);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('refuses a teammate who can read the project but did not upload the file', async () => {
    const TEAMMATE_ID = 61;
    mockPrisma.user.findUnique.mockResolvedValue(person(TEAMMATE_ID));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    // Read access comes from company_members; the delete rule does not.
    mockPrisma.companyMember.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.projectDocument.findFirst.mockResolvedValue(withProject());

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: TEAMMATE_ID }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DOCUMENT_DELETE_DENIED');
    expect(mockPrisma.projectDocument.update).not.toHaveBeenCalled();
  });

  /*
   * THE UPLOADER-ONLY RULE, from the two sides most likely to be assumed
   * otherwise. Both of these people have write access to the project and could
   * delete someone else's file before; neither can now. This delete destroys the
   * bytes for good, so it belongs to the one person who knows the file was
   * theirs to remove.
   */
  it('refuses the accounting manager on a file they did not upload (403)', async () => {
    const MANAGER_ID = 55; // company().accountingManagerUserId
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.projectDocument.findFirst.mockResolvedValue(withProject());

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DOCUMENT_DELETE_DENIED');
    expect(mockPrisma.projectDocument.update).not.toHaveBeenCalled();
  });

  it('refuses the assigned specialist on a file they did not upload (403)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(SPECIALIST_ID, 'SPECIALIST', null));
    mockPrisma.project.findFirst.mockResolvedValue(project());
    mockPrisma.company.findFirst.mockResolvedValue(company());
    mockPrisma.projectDocument.findFirst.mockResolvedValue(withProject());

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set('Authorization', auth({ userId: SPECIALIST_ID, role: 'SPECIALIST', specificRole: null }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DOCUMENT_DELETE_DENIED');
    // They keep every read: the rule takes away the destroy, not the access.
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

/* -------------------------------------------------------------------------- */
/* the cascade: deleting the project takes its documents with it              */
/* -------------------------------------------------------------------------- */

/**
 * DELETE /projects/:projectId is a project endpoint, and it is tested here
 * rather than in projects.test.js because what it has to get right is entirely
 * about documents.
 *
 * THE BUG THIS SUITE PINS DOWN. A deleted project used to leave its attachments
 * live in the table and their objects in the bucket. Nothing could reach them —
 * every document read joins `project: { deletedAt: null }`, and deleting one
 * individually refuses once the parent is gone — so the files were invisible,
 * undeletable, and still paid for. Invisible is not deleted.
 */
describe('DELETE /projects/:projectId — what it takes with it', () => {
  function stageDocuments(keys, taskCount = 0) {
    stageOwnerOnLiveProject();
    mockPrisma.projectDocument.findMany.mockResolvedValue(
      keys.map((fileKey, i) => ({ id: i + 1, fileKey }))
    );
    mockPrisma.projectDocument.updateMany.mockResolvedValue({ count: keys.length });
    mockPrisma.projectTask.updateMany.mockResolvedValue({ count: taskCount });
    mockPrisma.project.update.mockResolvedValue({ id: PROJECT_ID, deletedAt: new Date() });
  }

  it('soft deletes every document and task on the project, with one timestamp', async () => {
    stageDocuments([`projects/${PROJECT_ID}/a.pdf`, `projects/${PROJECT_ID}/b.pdf`], 3);

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.documentsDeleted).toBe(2);
    expect(res.body.data.tasksDeleted).toBe(3);

    const docs = mockPrisma.projectDocument.updateMany.mock.calls[0][0];
    const tasks = mockPrisma.projectTask.updateMany.mock.calls[0][0];
    // Only the live ones, on both: an already-deleted row keeps the timestamp
    // that records when IT went, not when the project did.
    expect(docs.where).toEqual({ projectId: PROJECT_ID, deletedAt: null });
    expect(tasks.where).toEqual({ projectId: PROJECT_ID, deletedAt: null });

    // One action, one timestamp, across the project and everything under it.
    const projectUpdate = mockPrisma.project.update.mock.calls[0][0];
    expect(docs.data.deletedAt).toEqual(projectUpdate.data.deletedAt);
    expect(tasks.data.deletedAt).toEqual(projectUpdate.data.deletedAt);
  });

  it('marks the tasks even on a project that has no documents', async () => {
    // The two cascades are independent — a project can easily have a plan and no
    // files, and the task half must not ride on the document half running.
    stageDocuments([], 4);

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.tasksDeleted).toBe(4);
    expect(mockPrisma.projectTask.updateMany).toHaveBeenCalled();
  });

  it('removes the stored files, so a deleted project stops costing storage', async () => {
    const keys = [`projects/${PROJECT_ID}/scan-1.pdf`, `projects/${PROJECT_ID}/scan-2.pdf`];
    const paths = keys.map((k) => path.join(DOCUMENTS_DIR, k));
    paths.forEach((abs) => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'twenty megabytes, pretend');
    });

    stageDocuments(keys);

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    // The bytes are the half nobody can see and the half that costs money. This
    // is the assertion the whole cascade exists for.
    paths.forEach((abs) => expect(fs.existsSync(abs)).toBe(false));
  });

  it('reads the keys before marking the rows', async () => {
    // `listLiveDocumentKeysForProject` filters `deletedAt: null` like every other
    // read in that repository, so asking AFTER the updateMany returns nothing and
    // the objects stay behind — the original bug, in miniature.
    stageDocuments([`projects/${PROJECT_ID}/a.pdf`]);

    await request(app).delete(`/api/projects/${PROJECT_ID}`).set('Authorization', ownerAuth());

    const readAt = mockPrisma.projectDocument.findMany.mock.invocationCallOrder[0];
    const markedAt = mockPrisma.projectDocument.updateMany.mock.invocationCallOrder[0];
    expect(readAt).toBeLessThan(markedAt);
  });

  it('deletes a project with no documents without touching storage', async () => {
    stageDocuments([]);

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(res.body.data.documentsDeleted).toBe(0);
  });

  it('refuses the accounting manager - the creator alone deletes (403)', async () => {
    const MANAGER_ID = 55; // company().accountingManagerUserId
    stageDocuments([`projects/${PROJECT_ID}/a.pdf`], 2);
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    // The project was opened by the owner, not by them.
    mockPrisma.project.findFirst.mockResolvedValue(project({ createdByUserId: OWNER_ID }));

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROJECT_DELETE_DENIED');
    expect(mockPrisma.projectDocument.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectTask.updateMany).not.toHaveBeenCalled();
  });

  it('leaves the files alone when the delete is refused', async () => {
    // A specialist may finish a project; making it disappear is the creator's
    // call. The refusal must happen before anything is removed.
    const fileKey = `projects/${PROJECT_ID}/keepme.pdf`;
    const abs = path.join(DOCUMENTS_DIR, fileKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'still needed');

    mockPrisma.user.findUnique.mockResolvedValue(person(SPECIALIST_ID, 'SPECIALIST', null));
    mockPrisma.project.findFirst.mockResolvedValue(project({ createdByUserId: OWNER_ID }));
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', auth({ userId: SPECIALIST_ID, role: 'SPECIALIST', specificRole: null }));

    expect(res.status).toBe(403);
    expect(mockPrisma.projectDocument.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectTask.updateMany).not.toHaveBeenCalled();
    expect(fs.existsSync(abs)).toBe(true);
  });
});
