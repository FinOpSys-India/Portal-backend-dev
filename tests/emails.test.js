'use strict';

/**
 * Integration tests for the email endpoints — the recipient picker, the upload
 * tickets, and the compose-and-send — through the real Express app with Prisma
 * mocked.
 *
 * THERE IS NO DRAFT, and this suite is shaped by that. `POST /emails` creates the
 * row, attaches the uploaded files and hands the message to SMTP in one request,
 * so the assertions that used to be split across a create test, a confirm test and
 * a send test all land on that one endpoint.
 *
 * WHAT IS ACTUALLY UNDER TEST HERE. Not nodemailer, and not Supabase: both are
 * stubbed, because neither is this API's decision. What is left is the part this
 * code owns, and it is where every one of these assertions lands:
 *
 *   WHO CAN BE WRITTEN TO   the picker has to merge four sources — the owner
 *                           column, company_members, the three standing
 *                           specialist columns, and the assignment table — and
 *                           return each person once. Every one of those is a
 *                           separate way to be on a company, and dropping any of
 *                           them silently makes somebody unaddressable.
 *   WHO CAN BE ADDRESSED    a recipient id in a request body is a claim. It is
 *                           re-resolved against the company on every send, or a
 *                           caller legitimately on company 5 could mail any user
 *                           id in the database.
 *   WHAT IS BELIEVED        a file uploaded straight to the bucket is never seen
 *                           by this API, so what gets RECORDED comes from the
 *                           bucket rather than the client's account of itself.
 *   WHOSE FILE IT IS        with no message id to scope an upload key, the key is
 *                           scoped by the SENDER — so a key belonging to somebody
 *                           else must not attach to this caller's message.
 *   NOTHING PARTIAL         a request that will be refused must leave no row, and
 *                           a send that fails must leave one that can be retried.
 *
 * The storage layer is stubbed in the suites that need the remote driver, since
 * config pins a test run to the LOCAL one so it can never write to a real bucket
 * — the same arrangement as tests/project.documents.test.js.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  /*
   * No `delete` on any of these, and no `emailRecipient` at all. Nothing on this
   * feature deletes a row, and recipients are only ever written by the nested
   * `createMany` inside `emailMessage.create` — a stub for a method the code can
   * no longer call would let a test pass against a path that does not exist.
   */
  emailMessage: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  emailAttachment: {
    findMany: jest.fn(),
    createManyAndReturn: jest.fn(),
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
const storage = require('../src/utils/storage');
const transport = require('../src/services/emailService');
const { signAccessToken } = require('../src/utils/tokens');

const OWNER_ID = 42;
const TEAMMATE_ID = 43;
const MANAGER_ID = 55;
const SECOND_MANAGER_ID = 56;
const BOOKKEEPER_ID = 77;
const TAX_SPECIALIST_ID = 78;
const FAQ_SPECIALIST_ID = 79;
const OUTSIDER_ID = 99;
const STRANGER_ID = 12345;

const COMPANY_ID = 900;
const MESSAGE_ID = 500;
const ATTACHMENT_ID = 60;

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

const ownerAuth = () => auth();
const managerAuth = () => auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null });
const outsiderAuth = () => auth({ userId: OUTSIDER_ID });

/*
 * `phone`, `jobTitle` and `ownedCompanies` are here for requirePaidAccount, which
 * gates every /emails route: it asks onboardingService for the caller's status,
 * and an OWNER whose profile is half-filled or whose company carries no paid
 * subscription is refused with a 402 before any route in this file runs.
 *
 * On the shared fixture rather than staged per test because being a paid account
 * is the precondition for all of these tests, not the subject of any of them —
 * the paywall has its own suite. Staff pass the gate regardless.
 */
function person(id, role = 'CUSTOMER', specificRole = 'OWNER', overrides = {}) {
  return {
    id,
    firstName: 'Ada',
    lastName: 'Hopper',
    email: `user${id}@finopsys.ai`,
    phone: '+1 555 0100',
    jobTitle: 'Founder',
    avatarKey: null,
    status: 'ACTIVE',
    role: { code: role },
    specificRole: specificRole ? { code: specificRole, name: specificRole } : null,
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
    taxSpecialistUserId: TAX_SPECIALIST_ID,
    ...overrides,
  };
}

/**
 * Route `user.findMany` to the right answer.
 *
 * TWO DIFFERENT QUESTIONS GO THROUGH ONE PRISMA METHOD — "the customers on this
 * company" and "the people behind these specialist ids" — so the stub has to
 * discriminate on the `where` it is handed, exactly as Postgres would. Keying on
 * the role code is the honest discriminator: it is the one clause that genuinely
 * differs between the two calls.
 */
function stageDirectory({ customers = [], specialists = [] } = {}) {
  mockPrisma.user.findMany.mockImplementation(async (args) => {
    const role = args?.where?.role?.code;
    if (role === 'CUSTOMER') return customers;
    if (role === 'SPECIALIST') {
      // Mirror the `id: { in: [...] }` narrowing, so a test that stages a
      // specialist who is NOT on the company still sees them filtered out.
      const ids = args?.where?.id?.in ?? null;
      return ids ? specialists.filter((s) => ids.includes(s.id)) : specialists;
    }
    return [];
  });
}

/** The caller resolves, the company resolves, and read access is granted. */
function stageOwnerOnCompany() {
  mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
  mockPrisma.company.findFirst.mockResolvedValue(company());
}

/** The four people the picker should find, and the assignment rows behind two. */
function stageFullRoster() {
  stageDirectory({
    customers: [person(OWNER_ID), person(TEAMMATE_ID, 'CUSTOMER', 'TEAM')],
    specialists: [
      person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3'),
      person(TAX_SPECIALIST_ID, 'SPECIALIST', 'SPECIALIST_2'),
      person(FAQ_SPECIALIST_ID, 'SPECIALIST', 'SPECIALIST_4'),
    ],
  });
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
    { specialistUserId: BOOKKEEPER_ID, specialization: { specializationCode: 'BOOKKEEPING', specializationName: 'Bookkeeping' } },
    { specialistUserId: FAQ_SPECIALIST_ID, specialization: { specializationCode: 'FA_Q', specializationName: 'FA and Q' } },
  ]);
}

/**
 * A message row rich enough for every select this feature uses.
 *
 * SENT by default, which is what a row in this table normally is: there are only
 * two resting states and the other one is a failure. The retry suite overrides it
 * to FAILED, because a SENT row is exactly what the retry endpoint refuses.
 */
function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    companyId: COMPANY_ID,
    senderUserId: OWNER_ID,
    subject: 'Q3 books',
    bodyHtml: '<p>Hello</p>',
    status: 'SENT',
    errorMessage: null,
    sentAt: new Date('2026-02-01T09:05:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    sender: person(OWNER_ID),
    company: { id: COMPANY_ID, companyName: 'ABC Aerospace LLC' },
    recipients: [{ recipientType: 'TO', user: person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3') }],
    attachments: [],
    ...overrides,
  };
}

/** The key shape `POST /emails/attachments/upload-url` mints for this sender. */
function senderKey(userId = OWNER_ID, ext = '.pdf') {
  return `emails/outbox/${userId}/${'a1b2c3d4'.repeat(4)}${ext}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.emailAttachment.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
});

/* -------------------------------------------------------------------------- */
/* no draft: the endpoints that used to exist                                 */
/* -------------------------------------------------------------------------- */

/*
 * THE SURFACE IS FOUR ENDPOINTS, and everything outside it is asserted absent
 * rather than assumed absent.
 *
 * Two separate rounds of removal land here. The draft endpoints went when
 * compose-and-send collapsed into one call; the outbox, the message detail and
 * the retry went because no screen reads them. In both cases deleting the handler
 * is not enough on its own — a route quietly left mounted would still accept a
 * request and still write to the database, and only the router can say whether
 * the path still resolves.
 *
 * The rows are still WRITTEN by `POST /emails`; what is gone is every way to read
 * one back. That is the line these cases hold.
 */
describe('the endpoints this screen does not use are not routed', () => {
  const cases = [
    ['get', `/api/emails?companyId=${COMPANY_ID}`, 'listing the outbox'],
    ['get', `/api/emails/${MESSAGE_ID}`, 'opening one message'],
    ['post', `/api/emails/${MESSAGE_ID}/send`, 'retrying a failed send'],
    ['patch', `/api/emails/${MESSAGE_ID}`, 'editing a draft'],
    ['delete', `/api/emails/${MESSAGE_ID}`, 'discarding a draft'],
    ['post', `/api/emails/${MESSAGE_ID}/attachments/confirm`, 'confirming an upload separately'],
    ['delete', `/api/emails/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`, 'removing an attachment'],
    ['post', `/api/emails/${MESSAGE_ID}/attachments/upload-url`, 'uploading against a message'],
  ];

  it.each(cases)('%s %s is not routed (%s)', async (method, path) => {
    stageOwnerOnCompany();

    const res = await request(app)[method](path).set('Authorization', ownerAuth()).send({});

    expect(res.status).toBe(404);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.emailMessage.update).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* the recipient picker                                                       */
/* -------------------------------------------------------------------------- */

describe('GET /emails/recipients/customers', () => {
  const get = (qs = `?companyId=${COMPANY_ID}`, as = ownerAuth()) =>
    request(app).get(`/api/emails/recipients/customers${qs}`).set('Authorization', as);

  it('returns the owner AND the teammates as one list', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    const res = await get();

    expect(res.status).toBe(200);

    // The whole point of the endpoint: two different links to a company —
    // owner_user_id and company_members — in one answer. /customers returns only
    // the first and /teammates only the second, so neither answers this.
    const ids = res.body.data.customers.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([OWNER_ID, TEAMMATE_ID]));
    expect(res.body.data.customers).toHaveLength(2);
    expect(res.body.data.total).toBe(2);

    expect(res.body.data.customers.find((c) => c.id === OWNER_ID).roleLabel).toBe('Owner');
    expect(res.body.data.customers.find((c) => c.id === TEAMMATE_ID).roleLabel).toBe('Team');
  });

  it('carries the email, name, company name and company id on every row', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    const res = await get();

    expect(res.body.data.customers[0]).toMatchObject({
      email: expect.stringContaining('@'),
      name: 'Ada Hopper',
      group: 'CUSTOMER',
      companyId: COMPANY_ID,
      companyName: 'ABC Aerospace LLC',
    });
    expect(res.body.data.companyId).toBe(COMPANY_ID);
    expect(res.body.data.companyName).toBe('ABC Aerospace LLC');
  });

  it('carries no specialists — that is a separate endpoint', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    const res = await get();

    expect(res.body.data.specialists).toBeUndefined();
    // And it does not pay for the specialist queries either.
    expect(mockPrisma.companySpecialistAssignment.findMany).not.toHaveBeenCalled();
  });

  it('lets the accounting manager of the account read it', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    mockPrisma.company.findFirst.mockResolvedValue(company());
    stageFullRoster();

    const res = await get(`?companyId=${COMPANY_ID}`, managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
  });

  it('refuses someone who is not on the company at all', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await get(`?companyId=${COMPANY_ID}`, outsiderAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('requires companyId — a merged list would mix two clients contacts', async () => {
    stageOwnerOnCompany();

    const res = await get('');

    expect(res.status).toBe(400);
  });

  it('nests the company filter and the search under AND', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    await get(`?companyId=${COMPANY_ID}&search=hopper`);

    const call = mockPrisma.user.findMany.mock.calls.find((c) => c[0].where.role.code === 'CUSTOMER');
    // `OR` is already spoken for by the two ways of being on a company, so the
    // text filter cannot share it — dropping the company half would return every
    // customer in the database.
    expect(JSON.stringify(call[0].where.AND)).toContain('hopper');
    expect(JSON.stringify(call[0].where.AND)).toContain('companyMemberships');
  });
});

describe('GET /emails/recipients/specialists', () => {
  const get = (qs = `?companyId=${COMPANY_ID}`, as = ownerAuth()) =>
    request(app).get(`/api/emails/recipients/specialists${qs}`).set('Authorization', as);

  it('merges the standing specialist columns with the assignment table', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    const res = await get();

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.specialists.map((s) => [s.id, s]));

    // From a standing column only (tax) — invisible to an assignment-only read.
    expect(byId[TAX_SPECIALIST_ID].specializations).toEqual(['TAX']);

    // From the assignment table only (FA_Q) — invisible to a columns-only read,
    // because that service line has no column on `companies` at all.
    expect(byId[FAQ_SPECIALIST_ID].specializations).toEqual(['FA_Q']);

    // In BOTH sources: one person, one row.
    expect(byId[BOOKKEEPER_ID].specializations).toEqual(['BOOKKEEPING']);
    expect(res.body.data.specialists).toHaveLength(3);
    expect(res.body.data.total).toBe(3);
  });

  it('collects several service lines onto one specialist rather than repeating them', async () => {
    stageOwnerOnCompany();
    stageDirectory({ specialists: [person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3')] });
    // The same person is the standing bookkeeper AND actively assigned to tax.
    mockPrisma.company.findFirst.mockResolvedValue(company({ taxSpecialistUserId: null }));
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      { specialistUserId: BOOKKEEPER_ID, specialization: { specializationCode: 'TAX', specializationName: 'Tax' } },
    ]);

    const res = await get();

    expect(res.body.data.specialists).toHaveLength(1);
    expect(res.body.data.specialists[0].specializations).toEqual(['BOOKKEEPING', 'TAX']);
    expect(res.body.data.specialists[0].roleLabel).toBe('BOOKKEEPING, TAX');
  });

  it('leaves an unstaffed service line out instead of returning a null person', async () => {
    stageOwnerOnCompany();
    // payroll is null on the fixture, and nothing is assigned.
    stageDirectory({
      specialists: [
        person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3'),
        person(TAX_SPECIALIST_ID, 'SPECIALIST', 'SPECIALIST_2'),
      ],
    });

    const res = await get();

    expect(res.body.data.specialists).toHaveLength(2);
    expect(res.body.data.specialists.every((s) => s.id !== null)).toBe(true);
  });

  it('returns an empty list for a company with nobody staffed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ bookkeepingSpecialistUserId: null, taxSpecialistUserId: null })
    );
    stageDirectory({});

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.data.specialists).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('carries no customers — that is a separate endpoint', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    const res = await get();

    expect(res.body.data.customers).toBeUndefined();
  });

  it('refuses someone who is not on the company at all', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await get(`?companyId=${COMPANY_ID}`, outsiderAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('requires companyId', async () => {
    stageOwnerOnCompany();

    const res = await get('');

    expect(res.status).toBe(400);
  });

  it('passes a search term through to the specialist lookup', async () => {
    stageOwnerOnCompany();
    stageFullRoster();

    await get(`?companyId=${COMPANY_ID}&search=hopper`);

    const call = mockPrisma.user.findMany.mock.calls.find((c) => c[0].where.role.code === 'SPECIALIST');
    expect(JSON.stringify(call[0].where.OR)).toContain('hopper');
  });
});

describe('GET /emails/recipients/accounting-managers', () => {
  const get = (qs = `?companyId=${COMPANY_ID}`, as = ownerAuth()) =>
    request(app).get(`/api/emails/recipients/accounting-managers${qs}`).set('Authorization', as);

  /** The company row with its manager joined, as the repository reads it. */
  const withManager = (manager) =>
    mockPrisma.company.findFirst.mockResolvedValue({ ...company(), accountingManager: manager });

  it('returns the manager named on the company', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.data.accountingManagers).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.accountingManagers[0]).toMatchObject({
      id: MANAGER_ID,
      name: 'Ada Hopper',
      email: `user${MANAGER_ID}@finopsys.ai`,
      group: 'ACCOUNTING_MANAGER',
      roleLabel: 'Accounting Manager',
      companyId: COMPANY_ID,
      companyName: 'ABC Aerospace LLC',
    });
  });

  it('is an ARRAY even though the schema allows only one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get();

    // All three recipient endpoints answer in the same shape. A bare object here
    // would make the picker special-case a third of itself.
    expect(Array.isArray(res.body.data.accountingManagers)).toBe(true);
  });

  it('returns an empty list for an unmanaged company, not a 404', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(null);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.data.accountingManagers).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('drops a manager whose account is not ACTIVE', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null, { status: 'HIBERNATED' }));

    const res = await get();

    // A hibernated account is a mailbox nobody reads; offering it invites a
    // message that silently goes nowhere.
    expect(res.body.data.accountingManagers).toEqual([]);
  });

  it('drops an id on the column that does not belong to a manager account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'CUSTOMER', 'OWNER'));

    const res = await get();

    expect(res.body.data.accountingManagers).toEqual([]);
  });

  it('filters on a search term', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    expect((await get(`?companyId=${COMPANY_ID}&search=hopper`)).body.data.total).toBe(1);
    expect((await get(`?companyId=${COMPANY_ID}&search=HOPPER`)).body.data.total).toBe(1);
    expect((await get(`?companyId=${COMPANY_ID}&search=nobody`)).body.data.total).toBe(0);
  });

  it('carries no customers or specialists — they are separate endpoints', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get();

    expect(res.body.data.customers).toBeUndefined();
    expect(res.body.data.specialists).toBeUndefined();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses someone who is not on the company at all', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get(`?companyId=${COMPANY_ID}`, outsiderAuth());

    expect(res.status).toBe(403);
  });

  it('requires companyId', async () => {
    stageOwnerOnCompany();

    const res = await get('');

    expect(res.status).toBe(400);
  });

  /* ------------------------------------------------------ the role gate ---- */

  /*
   * THE ONLY ROLE GATE ON THIS FEATURE. Writing to the accounting manager is
   * something a customer or a specialist does; the manager themselves has no use
   * for a list whose one entry is their own row.
   *
   * Both layers are asserted, because they answer different failures: the route's
   * requireRole turns away a wrong TOKEN CLAIM before any query, and the service
   * re-checks the DATABASE, which is what catches a token minted before a role
   * change.
   */
  it('refuses the accounting manager their own list', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get(`?companyId=${COMPANY_ID}`, managerAuth());

    expect(res.status).toBe(403);
  });

  it('refuses on the DATABASE role, not just the token claim', async () => {
    // The token says CUSTOMER — the route's coarse gate lets it through — but the
    // account has since become an accounting manager. The service is what catches
    // it, and a stale token must not be a way past the rule.
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get(
      `?companyId=${COMPANY_ID}`,
      auth({ userId: MANAGER_ID, role: 'CUSTOMER', specificRole: 'OWNER' })
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNTING_MANAGER_LIST_FORBIDDEN');
  });

  it('still lets a specialist on the company look the manager up', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3')
    );
    withManager(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));

    const res = await get(
      `?companyId=${COMPANY_ID}`,
      auth({ userId: BOOKKEEPER_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('leaves the customer and specialist lists ungated for a manager', async () => {
    // The asymmetry is deliberate: a manager needs to write to the client and to
    // the staff on the account. Only the list of THEMSELVES is withheld.
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    mockPrisma.company.findFirst.mockResolvedValue(company());
    stageFullRoster();

    const customers = await request(app)
      .get(`/api/emails/recipients/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());
    const specialists = await request(app)
      .get(`/api/emails/recipients/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(customers.status).toBe(200);
    expect(specialists.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* the upload tickets                                                         */
/* -------------------------------------------------------------------------- */

describe('POST /emails/attachments/upload-url', () => {
  let remote;
  let ticket;

  beforeEach(() => {
    stageOwnerOnCompany();
    remote = jest.spyOn(storage, 'isRemote').mockReturnValue(true);
    ticket = jest.spyOn(storage, 'signedUploadUrl').mockImplementation(async ({ key }) => ({
      url: `https://project.supabase.co/storage/v1/object/upload/sign/${key}?token=t`,
      token: 't',
      key,
    }));
  });

  afterEach(() => {
    remote.mockRestore();
    ticket.mockRestore();
  });

  const pdf = (overrides = {}) => ({
    fileName: 'statement.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5000,
    ...overrides,
  });

  const askFor = (files, body = {}, as = ownerAuth()) =>
    request(app)
      .post('/api/emails/attachments/upload-url')
      .set('Authorization', as)
      .send({ companyId: COMPANY_ID, files, ...body });

  it('issues a key scoped to the SENDER, which the caller did not choose', async () => {
    const res = await askFor([pdf()]);

    expect(res.status).toBe(201);
    // The message id used to be the prefix, and there is no message id any more.
    // The sender is what `POST /emails` re-derives from the token to prove the key
    // belongs to the caller — see the INVALID_UPLOAD_KEY test below.
    expect(res.body.data.uploads[0].key).toMatch(
      new RegExp(`^emails/outbox/${OWNER_ID}/[0-9a-f]{32}\\.pdf$`)
    );
    expect(res.body.data.uploads[0].uploadUrl).toContain('supabase.co');
    expect(res.body.data.companyId).toBe(COMPANY_ID);
  });

  it('records nothing — the message it will hang off does not exist yet', async () => {
    await askFor([pdf()]);

    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.emailAttachment.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('requires companyId, which is the only thing left to authorize against', async () => {
    const res = await request(app)
      .post('/api/emails/attachments/upload-url')
      .set('Authorization', ownerAuth())
      .send({ files: [pdf()] });

    // Without it this endpoint would hand signed write access to a private bucket
    // to any authenticated user, for no stated account at all.
    expect(res.status).toBe(400);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('refuses a company the caller cannot reach', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await askFor([pdf()], {}, outsiderAuth());

    expect(res.status).toBe(403);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('refuses a type outside the allowlist before any ticket exists', async () => {
    const res = await askFor([pdf({ fileName: 'run.exe', mimeType: 'application/x-msdownload' })]);

    expect(res.status).toBe(415);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('refuses a declared size over the per-file cap', async () => {
    const res = await askFor([pdf({ sizeBytes: 99 * 1024 * 1024 })]);

    expect(res.status).toBe(413);
    expect(ticket).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* compose and send, in one call                                              */
/* -------------------------------------------------------------------------- */

describe('POST /emails', () => {
  let send;
  let remote;
  let stat;
  let getObject;
  let removed;

  beforeEach(() => {
    stageOwnerOnCompany();
    /*
     * The roster is staged for EVERY test in this suite, not per test, because
     * `to` is now required: with nobody addressable, every request in here would
     * be refused with RECIPIENT_NOT_ON_COMPANY before reaching what it is actually
     * about. The suite that asserts that refusal stages a stranger instead.
     */
    stageFullRoster();
    mockPrisma.emailMessage.create.mockResolvedValue({ id: MESSAGE_ID });
    mockPrisma.emailMessage.findUnique.mockResolvedValue(messageRow());
    mockPrisma.emailMessage.update.mockResolvedValue({ id: MESSAGE_ID });
    mockPrisma.emailAttachment.createManyAndReturn.mockResolvedValue([{ id: ATTACHMENT_ID }]);

    send = jest.spyOn(transport, 'sendComposedEmail').mockResolvedValue({ messageId: '<abc@smtp>' });
    remote = jest.spyOn(storage, 'isRemote').mockReturnValue(true);
    stat = jest.spyOn(storage, 'statObject').mockResolvedValue({ sizeBytes: 5000, contentType: 'application/pdf' });
    getObject = jest.spyOn(storage, 'getObject').mockResolvedValue(Buffer.from('pdf-bytes'));
    removed = jest.spyOn(storage, 'removeObjects').mockResolvedValue(undefined);
  });

  afterEach(() => {
    send.mockRestore();
    remote.mockRestore();
    stat.mockRestore();
    getObject.mockRestore();
    removed.mockRestore();
  });

  const post = (body, as = ownerAuth()) =>
    request(app).post('/api/emails').set('Authorization', as).send(body);

  const message = (overrides = {}) => ({
    companyId: COMPANY_ID,
    subject: 'Q3 books',
    bodyHtml: '<p>Hello</p>',
    to: [BOOKKEEPER_ID],
    ...overrides,
  });

  /* ---------------------------------------------------------------- the send */

  it('creates the row AND sends it, in one request', async () => {
    const res = await post(message());

    expect(res.status).toBe(201);
    expect(mockPrisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    // No intermediate state the client has to act on: the row is SENT with a
    // timestamp by the time the response is written.
    const written = mockPrisma.emailMessage.update.mock.calls[0][0].data;
    expect(written.status).toBe('SENT');
    // status and sentAt go together — the database CHECK rejects either alone, so
    // a half-applied update cannot claim a send at no particular time.
    expect(written.sentAt).toBeInstanceOf(Date);
    expect(written.errorMessage).toBeNull();
    expect(res.body.data.status).toBe('SENT');
  });

  it('needs no other call when there are no attachments', async () => {
    await post(message());

    // The whole point of one Send button: with nothing attached, this is the only
    // request the screen makes.
    expect(stat).not.toHaveBeenCalled();
    expect(mockPrisma.emailAttachment.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('writes the recipients split into to/cc/bcc', async () => {
    stageFullRoster();

    const res = await post(message({ to: [BOOKKEEPER_ID], cc: [TEAMMATE_ID] }));

    expect(res.status).toBe(201);
    const written = mockPrisma.emailMessage.create.mock.calls[0][0];
    expect(written.data.recipients.createMany.data).toEqual([
      { userId: BOOKKEEPER_ID, recipientType: 'TO' },
      { userId: TEAMMATE_ID, recipientType: 'CC' },
    ]);
  });

  it('puts the composer in Reply-To, never in the envelope From', async () => {
    await post(message());

    // The provider will not relay mail claiming an address it does not authorize,
    // so the envelope stays SMTP_FROM and the real address is the reply path. That
    // split is made inside sendComposedEmail; what this asserts is that the service
    // hands it the composer rather than a client-supplied value — there is no
    // `from` field on the request at all.
    expect(send.mock.calls[0][0].senderEmail).toBe(`user${OWNER_ID}@finopsys.ai`);
    expect(send.mock.calls[0][0].senderName).toBe('Ada Hopper');
  });

  it('splits the recipients into to, cc and bcc for the transport', async () => {
    mockPrisma.emailMessage.findUnique.mockResolvedValue(
      messageRow({
        recipients: [
          { recipientType: 'TO', user: person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3') },
          { recipientType: 'CC', user: person(TEAMMATE_ID, 'CUSTOMER', 'TEAM') },
          { recipientType: 'BCC', user: person(MANAGER_ID, 'ACCOUNTING_MANAGER', null) },
        ],
      })
    );

    await post(message());

    const arg = send.mock.calls[0][0];
    expect(arg.to).toEqual([{ name: 'Ada Hopper', address: `user${BOOKKEEPER_ID}@finopsys.ai` }]);
    expect(arg.cc).toHaveLength(1);
    expect(arg.bcc).toHaveLength(1);
  });

  /* -------------------------------------------------------- who may be mailed */

  it('refuses a recipient who is not on the company, before anything is written', async () => {
    stageFullRoster();

    // STRANGER_ID is a real user id somewhere; it is simply not on this account.
    // Without the re-resolution this test guards, a caller legitimately on company
    // 900 could mail any id in the database.
    const res = await post(message({ to: [STRANGER_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ON_COMPANY');
    expect(res.body.error.details.userIds).toEqual([STRANGER_ID]);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  /*
   * THE PICKER AND THE SEND MUST AGREE, and these three cases are the whole of
   * that contract: every group an endpoint lists is sendable to.
   *
   * The accounting manager case is not hypothetical. Adding
   * GET /emails/recipients/accounting-managers without widening the addressable
   * set left the screen able to LIST a manager and unable to WRITE to one — the
   * picker offered a name that `POST /emails` then rejected as not on the company.
   */
  it.each([
    ['a customer', TEAMMATE_ID],
    ['a specialist', BOOKKEEPER_ID],
    ['the accounting manager', MANAGER_ID],
  ])('accepts %s from the picker as a recipient', async (_label, recipientId) => {
    stageFullRoster();
    mockPrisma.company.findFirst.mockResolvedValue({
      ...company(),
      accountingManager: person(MANAGER_ID, 'ACCOUNTING_MANAGER', null),
    });

    const res = await post(message({ to: [recipientId] }));

    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('requires at least one TO recipient', async () => {
    const res = await post(message({ to: [] }));

    // This used to be legal at create time and checked only at send. There is no
    // create time any more, so an empty To is a message with nowhere to go.
    expect(res.status).toBe(400);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('requires the to field to be present at all', async () => {
    const body = message();
    delete body.to;

    const res = await post(body);

    expect(res.status).toBe(400);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('refuses to send against a company the caller cannot reach', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OUTSIDER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(company());

    const res = await post(message(), outsiderAuth());

    expect(res.status).toBe(403);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  /* ------------------------------------------ which list TO was picked from */

  /*
   * Compose is THREE SCREENS, not one, and TO is what says which of them the
   * message came from: the customer page addresses the client, the specialist
   * page addresses the staff, and "email the accounting manager" addresses the
   * manager. So every id on TO has to come from ONE of those lists, and it has
   * to be a list the sender is allowed to write to.
   *
   * CC and BCC are deliberately not covered by that rule — anyone on the company
   * may be copied, whichever page the message was written on. See the block at
   * the foot of this section.
   */

  /** The company row with its manager joined, so the manager is addressable. */
  const withManager = (manager = person(MANAGER_ID, 'ACCOUNTING_MANAGER', null)) =>
    mockPrisma.company.findFirst.mockResolvedValue({ ...company(), accountingManager: manager });

  /** The caller is the manager on this account, and the manager is on it. */
  const stageManagerSending = () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    withManager();
    stageFullRoster();
  };

  it('lets the accounting manager write to the customers on the account', async () => {
    stageManagerSending();

    const res = await post(message({ to: [OWNER_ID, TEAMMATE_ID] }), managerAuth());

    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalled();
  });

  it('lets the accounting manager write to the specialists on the account', async () => {
    stageManagerSending();

    const res = await post(message({ to: [BOOKKEEPER_ID, TAX_SPECIALIST_ID] }), managerAuth());

    expect(res.status).toBe(201);
  });

  /*
   * The write-side half of the gate on GET /recipients/accounting-managers. The
   * manager is refused that picker because the only entry would be themselves;
   * without this check they could still put that id on TO by hand, and the read
   * gate would be decoration.
   */
  it('refuses the accounting manager another manager on TO', async () => {
    // A SECOND manager on the account, so the refusal is about the GROUP and not
    // about writing to yourself — a different rule with a different error. One
    // column means one manager today; this is what holds the rule up if that ever
    // becomes two.
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    withManager(person(SECOND_MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    stageFullRoster();

    const res = await post(message({ to: [SECOND_MANAGER_ID] }), managerAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECIPIENT_GROUP_FORBIDDEN');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a TO that mixes customers with specialists', async () => {
    stageManagerSending();

    const res = await post(message({ to: [OWNER_ID, BOOKKEEPER_ID] }), managerAuth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_GROUP_MIXED');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a customer a TO that mixes the manager with a teammate', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [MANAGER_ID, TEAMMATE_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_GROUP_MIXED');
    expect(send).not.toHaveBeenCalled();
  });

  it('lets a customer write to the accounting manager alone', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [MANAGER_ID] }));

    expect(res.status).toBe(201);
  });

  it('lets a specialist write to the accounting manager alone', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3'));
    withManager();
    stageFullRoster();

    const res = await post(
      message({ to: [MANAGER_ID] }),
      auth({ userId: BOOKKEEPER_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' })
    );

    expect(res.status).toBe(201);
  });

  /*
   * The TOKEN says CUSTOMER; the DATABASE says the caller is the accounting
   * manager. The database wins, exactly as it does on the manager picker — a
   * claim is a snapshot from when the token was signed, and this application
   * promotes users mid-session.
   */
  it('decides the sender role on the DATABASE, not the token claim', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    withManager(person(SECOND_MANAGER_ID, 'ACCOUNTING_MANAGER', null));
    stageFullRoster();

    const res = await post(
      message({ to: [SECOND_MANAGER_ID] }),
      auth({ userId: MANAGER_ID, role: 'CUSTOMER', specificRole: 'OWNER' })
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECIPIENT_GROUP_FORBIDDEN');
  });

  /* -------------------------------------- the sender is not a TO recipient - */

  /*
   * The owner is in their OWN company's customer list — they are a customer on
   * it — so the picker offers them to themselves and every other rule here would
   * have let it through: they are on the company, and CUSTOMER is a group they
   * may address.
   */
  it('refuses the sender on TO', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [OWNER_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SENDER_IN_TO');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses the sender hidden among other TO recipients', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [TEAMMATE_ID, OWNER_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SENDER_IN_TO');
  });

  /*
   * With no outbox screen in this API, copying yourself is the only way to keep a
   * copy of what you sent — so the rule stops at TO.
   */
  it('lets the sender copy themselves on cc and bcc', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [BOOKKEEPER_ID], cc: [OWNER_ID] }));

    expect(res.status).toBe(201);

    const rows = mockPrisma.emailMessage.create.mock.calls[0][0].data.recipients.createMany.data;
    expect(rows).toContainEqual({ userId: OWNER_ID, recipientType: 'CC' });
  });

  /* ------------------------------------------- an id the client got wrong -- */

  it('refuses a TO id that is not a user at all, naming the ids', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [424242] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ON_COMPANY');
    expect(res.body.error.details.userIds).toEqual([424242]);
    expect(res.body.error.fields).toHaveProperty('to');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a malformed TO id before any lookup, naming the position', async () => {
    const res = await post(message({ to: ['not-an-id'] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields).toHaveProperty(['to[0]']);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a bad id on cc and on bcc too, naming the field that carried it', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [BOOKKEEPER_ID], bcc: [STRANGER_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ON_COMPANY');
    expect(res.body.error.fields).toHaveProperty('bcc');
    expect(res.body.error.details.userIds).toEqual([STRANGER_ID]);
    expect(send).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------- the company being written to */

  it('refuses a malformed companyId', async () => {
    const res = await post(message({ companyId: 'abc' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields).toHaveProperty('companyId');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a companyId that is not a company', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(person(OWNER_ID));
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const res = await post(message({ companyId: 424242 }));

    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------- what is required */

  /*
   * FOUR REQUIRED KEYS. `subject` and `bodyHtml` may be blank — see subjectLine
   * and htmlBody — but the keys have to be there, because both columns are NOT
   * NULL and a compose form always holds all four.
   */
  it('requires companyId, to, subject and bodyHtml', async () => {
    for (const field of ['companyId', 'to', 'subject', 'bodyHtml']) {
      const body = message();
      delete body[field];

      const res = await post(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.missing).toContain(field);
    }

    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------- cc and bcc are not gated */

  /*
   * ANYONE ON THE COMPANY MAY BE COPIED. The group rule says which list the
   * message was ADDRESSED from, and only TO answers that: copying the accounting
   * manager on a note to the bookkeeper is an ordinary thing to do, and refusing
   * it would make the rule about tidiness rather than about access.
   */
  it('allows any company member on cc and bcc, across groups', async () => {
    stageManagerSending();

    const res = await post(
      message({ to: [BOOKKEEPER_ID], cc: [OWNER_ID, MANAGER_ID], bcc: [TEAMMATE_ID] }),
      managerAuth()
    );

    expect(res.status).toBe(201);

    const rows = mockPrisma.emailMessage.create.mock.calls[0][0].data.recipients.createMany.data;
    expect(rows).toEqual(
      expect.arrayContaining([
        { userId: BOOKKEEPER_ID, recipientType: 'TO' },
        { userId: OWNER_ID, recipientType: 'CC' },
        { userId: MANAGER_ID, recipientType: 'CC' },
        { userId: TEAMMATE_ID, recipientType: 'BCC' },
      ])
    );
  });

  it('still refuses someone off the company on cc, and names that field', async () => {
    withManager();
    stageFullRoster();

    const res = await post(message({ to: [BOOKKEEPER_ID], cc: [STRANGER_ID] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ON_COMPANY');
    expect(res.body.error.fields).toHaveProperty('cc');
    expect(send).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------- what is written */

  it('accepts an HTML body containing newlines', async () => {
    // The shared string validator rejects every control character, newline
    // included, which would have refused essentially every real body.
    const res = await post(message({ bodyHtml: '<p>One</p>\n<p>Two</p>\r\n<ul>\n<li>x</li>\n</ul>' }));

    expect(res.status).toBe(201);
  });

  it('refuses a newline in the subject — that is header injection', async () => {
    const res = await post(message({ subject: 'Invoice\nBcc: attacker@evil.com' }));

    expect(res.status).toBe(400);
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a NUL byte in the body', async () => {
    const res = await post(message({ bodyHtml: '<p>hi \u0000</p>' }));

    expect(res.status).toBe(400);
  });

  it('sends a blank subject rather than refusing a legal email', async () => {
    const res = await post(message({ subject: '   ' }));

    expect(res.status).toBe(201);
    expect(mockPrisma.emailMessage.create.mock.calls[0][0].data.subject).toBe('');
  });

  it('rejects an unknown field instead of silently ignoring it', async () => {
    const res = await post(message({ fromEmail: 'spoofed@evil.com' }));

    expect(res.status).toBe(400);
  });

  /* ------------------------------------------------------------- attachments */

  it('records the size the BUCKET reports, not the one the client claimed', async () => {
    const key = senderKey();

    const res = await post(message({ files: [{ key, fileName: 'statement.pdf' }] }));

    expect(res.status).toBe(201);
    const rows = mockPrisma.emailAttachment.createManyAndReturn.mock.calls[0][0].data;
    // 5000 from statObject. The client sends no size on this call at all, which is
    // what makes the cap enforceable rather than advisory.
    expect(rows[0].sizeBytes).toBe(BigInt(5000));
    expect(rows[0].mimeType).toBe('application/pdf');
    expect(rows[0].emailMessageId).toBe(MESSAGE_ID);
    expect(rows[0].fileKey).toBe(key);
  });

  it('refuses a key belonging to a DIFFERENT sender', async () => {
    // The signed ticket is spent by now and proves nothing about who holds the
    // key. This is the check that stops one user attaching another user's upload.
    const res = await post(message({ files: [{ key: senderKey(STRANGER_ID), fileName: 'x.pdf' }] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_UPLOAD_KEY');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a key that was never minted by this API', async () => {
    const res = await post(message({ files: [{ key: '../../etc/passwd', fileName: 'x.pdf' }] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_UPLOAD_KEY');
  });

  it('refuses a key already carried by another message', async () => {
    mockPrisma.emailAttachment.findMany.mockResolvedValue([
      { id: ATTACHMENT_ID, fileKey: senderKey() },
    ]);

    const res = await post(message({ files: [{ key: senderKey(), fileName: 'statement.pdf' }] }));

    // file_key is UNIQUE, so this is the difference between a 409 that names the
    // problem and a 500 from the index — and a double-clicked Send is ordinary.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTACHMENT_ALREADY_RECORDED');
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('404s when the object never actually arrived, and sends nothing', async () => {
    stat.mockResolvedValue(null);

    const res = await post(message({ files: [{ key: senderKey(), fileName: 'statement.pdf' }] }));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
    // The mail must not go out without a file the user attached and can see.
    expect(send).not.toHaveBeenCalled();
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a zero-byte object with a 400, not a constraint violation', async () => {
    // The PUT reached the bucket and created the object, but carried no body.
    // `size_bytes > 0` would catch it in the database — as a 500 that names a
    // constraint rather than the file, which is no use to the person sending.
    stat.mockResolvedValue({ sizeBytes: 0, contentType: 'application/pdf' });
    const key = senderKey();

    const res = await post(message({ files: [{ key, fileName: 'statement.pdf' }] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UPLOAD_EMPTY');
    expect(res.body.error.details.fileNames).toEqual(['statement.pdf']);
    // Zero bytes is not a document, and a stored one could be retried forever.
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ keys: [key] }));
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes an oversized object rather than leaving it in the bucket', async () => {
    stat.mockResolvedValue({ sizeBytes: 99 * 1024 * 1024, contentType: 'application/pdf' });
    const key = senderKey();

    const res = await post(message({ files: [{ key, fileName: 'statement.pdf' }] }));

    expect(res.status).toBe(413);
    // Refusing to record it while leaving it stored is the worst of both: space
    // consumed for a file that will never be sent and no row naming it.
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ keys: [key] }));
  });

  it('refuses a total over the message cap even when each file is legal', async () => {
    // 12 MB each: legal alone, and together more than a mail server will accept.
    stat.mockResolvedValue({ sizeBytes: 12 * 1024 * 1024, contentType: 'application/pdf' });

    const res = await post(
      message({
        files: [
          { key: senderKey(OWNER_ID, '.pdf'), fileName: 'a.pdf' },
          { key: `emails/outbox/${OWNER_ID}/${'b'.repeat(32)}.pdf`, fileName: 'b.pdf' },
        ],
      })
    );

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('ATTACHMENTS_TOO_LARGE');
    expect(removed).toHaveBeenCalled();
    expect(mockPrisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it('rejects the same key twice in one request', async () => {
    const key = senderKey();

    const res = await post(
      message({
        files: [
          { key, fileName: 'a.pdf' },
          { key, fileName: 'b.pdf' },
        ],
      })
    );

    // One object as two rows would break on the unique index — a 500 for what is
    // really a malformed request.
    expect(res.status).toBe(400);
  });

  it('fetches each attachment from the bucket and passes the bytes to SMTP', async () => {
    mockPrisma.emailMessage.findUnique.mockResolvedValue(
      messageRow({
        attachments: [
          {
            id: ATTACHMENT_ID,
            fileKey: senderKey(),
            originalName: 'statement.pdf',
            mimeType: 'application/pdf',
            sizeBytes: BigInt(5000),
          },
        ],
      })
    );

    await post(message({ files: [{ key: senderKey(), fileName: 'statement.pdf' }] }));

    // Read from the bucket at send time, not carried from the upload: that
    // happened in a different request, possibly on a different instance.
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].attachments).toEqual([
      { filename: 'statement.pdf', content: Buffer.from('pdf-bytes'), contentType: 'application/pdf' },
    ]);
  });

  it('refuses to send rather than silently dropping an attachment gone from storage', async () => {
    getObject.mockResolvedValue(null);
    mockPrisma.emailMessage.findUnique.mockResolvedValue(
      messageRow({
        attachments: [
          {
            id: ATTACHMENT_ID,
            fileKey: senderKey(),
            originalName: 'gone.pdf',
            mimeType: 'application/pdf',
            sizeBytes: BigInt(1),
          },
        ],
      })
    );

    const res = await post(message({ files: [{ key: senderKey(), fileName: 'gone.pdf' }] }));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ATTACHMENT_READ_FAILED');
    expect(send).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------ when it fails */

  it('keeps the row as FAILED with the reason when the transport refuses', async () => {
    send.mockRejectedValue(new Error('550 mailbox does not exist'));

    const res = await post(message());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EMAIL_SEND_FAILED');
    expect(res.body.error.details.messageId).toBe(MESSAGE_ID);

    // NOT rolled back. The user needs to see that an attempt was made and why it
    // did not work, and the row is what the retry endpoint acts on.
    const written = mockPrisma.emailMessage.update.mock.calls[0][0].data;
    expect(written.status).toBe('FAILED');
    expect(written.errorMessage).toContain('mailbox does not exist');
    expect(written.sentAt).toBeNull();
  });

  it('discards the uploaded objects when the row cannot be written', async () => {
    const key = senderKey();
    mockPrisma.$transaction.mockRejectedValue(new Error('deadlock detected'));

    const res = await post(message({ files: [{ key, fileName: 'statement.pdf' }] }));

    expect(res.status).toBe(500);
    // Nothing will ever reference these bytes: the ticket that produced them is
    // spent and no row was written naming them.
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ keys: [key] }));
    expect(send).not.toHaveBeenCalled();
  });
});
