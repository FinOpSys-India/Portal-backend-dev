'use strict';

/**
 * Integration tests for the chat endpoints — through the real Express app with
 * Prisma mocked.
 *
 * WHAT IS ACTUALLY UNDER TEST. Not Supabase and not Postgres: the bucket is
 * stubbed and the replication stream that carries live updates is not this
 * code's decision. What is left is the part this API owns, and it is where every
 * assertion below lands:
 *
 *   WHOSE THREAD IT IS       being on a company is NOT enough. A teammate can
 *                            read the company's documents and must not be able
 *                            to read the owner's conversation with the
 *                            accounting manager — so the rule is "one of the
 *                            two sides", and it is tested against somebody who
 *                            passes the company check and fails this one.
 *   WHO CAN BE CHATTED WITH  a participant id in a request body is a claim. It
 *                            is re-resolved against the company's own roster, or
 *                            a manager legitimately on company 5 could open a
 *                            thread with any user id in the database.
 *   WHICH COMPANY            the same person can be a teammate at one company
 *                            and a specialist at another; the thread key carries
 *                            the company so those cannot merge.
 *   WHAT IS DERIVED          there is no receiver column and no stored email
 *                            address. Both come off the conversation and the
 *                            joined user, and the response has to prove it.
 *   WHOSE FILE IT IS         an upload key is scoped to the CONVERSATION, so a
 *                            key minted for one thread must not attach to
 *                            another — and what gets recorded is what the bucket
 *                            says, not what the client claimed.
 *   NOTHING PARTIAL          a message, its attachments and the thread's
 *                            lastMessageAt are one transaction.
 *
 * The storage layer is stubbed in the suites that need the remote driver, since
 * config pins a test run to the LOCAL one so it can never write to a real bucket
 * — the same arrangement as tests/emails.test.js.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  company: { findFirst: jest.fn() },
  companyMember: { findFirst: jest.fn() },
  companySpecialistAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  chatConversation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  chatMessage: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    groupBy: jest.fn(),
    count: jest.fn(),
  },
  chatAttachment: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  chatReaction: { findMany: jest.fn(), deleteMany: jest.fn() },
  /*
   * The preview line on the two contact lists is the one raw READ in this
   * feature — DISTINCT ON, because Prisma's `distinct` would drag every message
   * of every listed thread across the wire to render forty lines. See
   * chatRepository.findLatestMessages.
   */
  $queryRaw: jest.fn(),
  // The reaction write — INSERT … ON CONFLICT on a partial unique index, which
  // Prisma's `upsert` cannot target. See chatRepository.setReaction.
  $executeRaw: jest.fn(),
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../src/app');
const config = require('../src/config');
const storage = require('../src/utils/storage');
const { signAccessToken } = require('../src/utils/tokens');

const OWNER_ID = 42;
const TEAMMATE_ID = 43;
const MANAGER_ID = 55;
const OTHER_MANAGER_ID = 56;
const BOOKKEEPER_ID = 77;
const OUTSIDER_ID = 99;

const COMPANY_ID = 900;
const CONVERSATION_ID = 7;
const OTHER_CONVERSATION_ID = 8;
const ATTACHMENT_ID = 61;

const HEX32 = 'a1b2c3d4'.repeat(4);

function auth({ userId = OWNER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: `user${userId}@finopsys.ai`, role, specificRole })}`;
}

const ownerAuth = () => auth();
const teammateAuth = () => auth({ userId: TEAMMATE_ID, specificRole: 'TEAM' });
const managerAuth = () => auth({ userId: MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null });
const specialistAuth = () => auth({ userId: BOOKKEEPER_ID, role: 'SPECIALIST', specificRole: 'SPECIALIST_3' });
const outsiderAuth = () => auth({ userId: OUTSIDER_ID });

/*
 * `phone`, `jobTitle` and `ownedCompanies` are here for requirePaidAccount, which
 * gates every /chat route: an OWNER whose company carries no paid subscription is
 * refused with a 402 before any route in this file runs. Staff pass regardless.
 */
function person(id, role = 'CUSTOMER', specificRole = 'OWNER', overrides = {}) {
  return {
    id,
    firstName: `User${id}`,
    lastName: 'Test',
    email: `user${id}@finopsys.ai`,
    phone: '+1 555 0100',
    jobTitle: 'Founder',
    avatarKey: null,
    status: 'ACTIVE',
    passwordChangedAt: null,
    role: { code: role },
    specificRole: specificRole ? { code: specificRole, name: specificRole } : null,
    ownedCompanies: [{ id: COMPANY_ID, subscriptions: [{ id: 1 }] }],
    ...overrides,
  };
}

const PEOPLE = {
  [OWNER_ID]: person(OWNER_ID),
  [TEAMMATE_ID]: person(TEAMMATE_ID, 'CUSTOMER', 'TEAM', { ownedCompanies: [] }),
  [MANAGER_ID]: person(MANAGER_ID, 'ACCOUNTING_MANAGER', null, { ownedCompanies: [] }),
  [OTHER_MANAGER_ID]: person(OTHER_MANAGER_ID, 'ACCOUNTING_MANAGER', null, { ownedCompanies: [] }),
  [BOOKKEEPER_ID]: person(BOOKKEEPER_ID, 'SPECIALIST', 'SPECIALIST_3', { ownedCompanies: [] }),
  /*
   * An owner of a DIFFERENT, paid company. The paid part matters: with no
   * subscription the paywall would refuse them with a 402 before the chat rules
   * ever ran, and the test would prove nothing about access to the thread.
   */
  [OUTSIDER_ID]: person(OUTSIDER_ID, 'CUSTOMER', 'OWNER', {
    ownedCompanies: [{ id: 901, subscriptions: [{ id: 2 }] }],
  }),
};

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

/**
 * One conversation row in the shape CONVERSATION_SELECT returns it.
 *
 * The manager and the owner by default — the commonest thread in the product,
 * and the one whose two sides every access assertion below is about.
 */
function conversationRow(overrides = {}) {
  return {
    id: CONVERSATION_ID,
    companyId: COMPANY_ID,
    accountingManagerUserId: MANAGER_ID,
    participantUserId: OWNER_ID,
    participantKind: 'CUSTOMER',
    lastMessageAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-01-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    company: { id: COMPANY_ID, companyName: 'ABC Aerospace LLC' },
    accountingManager: PEOPLE[MANAGER_ID],
    participant: PEOPLE[OWNER_ID],
    ...overrides,
  };
}

function messageRow(overrides = {}) {
  return {
    id: 5001n,
    conversationId: CONVERSATION_ID,
    senderUserId: MANAGER_ID,
    body: 'Sent the Q3 books over.',
    readAt: null,
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    sender: PEOPLE[MANAGER_ID],
    attachments: [],
    ...overrides,
  };
}

/**
 * One row as the raw preview query returns it — snake_case columns straight off
 * Postgres, with the count of attachments rather than the attachments
 * themselves. The repository reshapes it into what MESSAGE_SELECT produces, and
 * this fixture is what proves that reshaping actually happens.
 */
function previewRow(overrides = {}) {
  return {
    id: 5001n,
    conversation_id: CONVERSATION_ID,
    sender_user_id: MANAGER_ID,
    body: 'Sent the Q3 books over.',
    read_at: null,
    created_at: new Date('2026-02-01T09:00:00Z'),
    updated_at: new Date('2026-02-01T09:00:00Z'),
    first_name: `User${MANAGER_ID}`,
    last_name: 'Test',
    email: `user${MANAGER_ID}@finopsys.ai`,
    job_title: 'Accounting Manager',
    avatar_key: null,
    attachment_count: 0n,
    ...overrides,
  };
}

/** The key shape POST /chat/attachments/upload-url mints for a thread. */
function chatKey(conversationId = CONVERSATION_ID, ext = '.pdf') {
  return `chat/${conversationId}/${HEX32}${ext}`;
}

/** Route `user.findMany` to the right answer — see tests/emails.test.js. */
function stageDirectory({ customers = [], specialists = [] } = {}) {
  mockPrisma.user.findMany.mockImplementation(async (args) => {
    const role = args?.where?.role?.code;
    if (role === 'CUSTOMER') return customers;
    if (role === 'SPECIALIST') {
      const ids = args?.where?.id?.in ?? null;
      return ids ? specialists.filter((s) => ids.includes(s.id)) : specialists;
    }
    return [];
  });
}

function stageRoster() {
  stageDirectory({
    customers: [PEOPLE[OWNER_ID], PEOPLE[TEAMMATE_ID]],
    specialists: [PEOPLE[BOOKKEEPER_ID]],
  });
}

beforeEach(() => {
  jest.clearAllMocks();

  // Everyone resolves to their own row, so requireAuth, requirePaidAccount,
  // requireRole and chatService.loadCaller all see the same person.
  mockPrisma.user.findUnique.mockImplementation(async (args) => PEOPLE[args?.where?.id] ?? null);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.company.findFirst.mockResolvedValue(company());
  mockPrisma.companyMember.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findFirst.mockResolvedValue(null);
  mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([]);
  mockPrisma.chatConversation.findMany.mockResolvedValue([]);
  mockPrisma.chatMessage.findMany.mockResolvedValue([]);
  mockPrisma.chatMessage.groupBy.mockResolvedValue([]);
  mockPrisma.chatMessage.count.mockResolvedValue(0);
  mockPrisma.chatAttachment.findMany.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.chatReaction.findMany.mockResolvedValue([]);
  mockPrisma.chatReaction.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
});

/* ========================================================================== */
/* PART 1 — opening a thread                                                  */
/* ========================================================================== */

describe('POST /chat/conversations', () => {
  it('opens the manager’s thread with a customer and files it under CUSTOMER', async () => {
    stageRoster();
    mockPrisma.chatConversation.upsert.mockResolvedValue(conversationRow());

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', managerAuth())
      .send({ companyId: COMPANY_ID, participantUserId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(CONVERSATION_ID);
    expect(res.body.data.participantKind).toBe('CUSTOMER');

    // The company is part of the thread's identity, not a filter on top of it.
    const args = mockPrisma.chatConversation.upsert.mock.calls[0][0];
    expect(args.where.companyId_accountingManagerUserId_participantUserId).toEqual({
      companyId: COMPANY_ID,
      accountingManagerUserId: MANAGER_ID,
      participantUserId: OWNER_ID,
    });
    // Reopening must not touch a single column on an existing row.
    expect(args.update).toEqual({});
  });

  it('files a thread with a specialist under SPECIALIST', async () => {
    stageRoster();
    mockPrisma.chatConversation.upsert.mockResolvedValue(
      conversationRow({
        participantUserId: BOOKKEEPER_ID,
        participantKind: 'SPECIALIST',
        participant: PEOPLE[BOOKKEEPER_ID],
      })
    );

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', managerAuth())
      .send({ companyId: COMPANY_ID, participantUserId: BOOKKEEPER_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.participantKind).toBe('SPECIALIST');
    expect(mockPrisma.chatConversation.upsert.mock.calls[0][0].create.participantKind).toBe('SPECIALIST');
  });

  it('refuses a participant who is not on the company', async () => {
    // The roster resolves, and this user is on none of it.
    stageRoster();

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', managerAuth())
      .send({ companyId: COMPANY_ID, participantUserId: OUTSIDER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PARTICIPANT_NOT_ON_COMPANY');
    expect(mockPrisma.chatConversation.upsert).not.toHaveBeenCalled();
  });

  it('resolves the counterpart for a customer, who has nobody to choose', async () => {
    mockPrisma.chatConversation.upsert.mockResolvedValue(conversationRow());

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', ownerAuth())
      .send({ companyId: COMPANY_ID });

    expect(res.status).toBe(200);
    // The manager came from companies.accounting_manager_user_id, not the body.
    expect(mockPrisma.chatConversation.upsert.mock.calls[0][0].create).toEqual({
      companyId: COMPANY_ID,
      accountingManagerUserId: MANAGER_ID,
      participantUserId: OWNER_ID,
      participantKind: 'CUSTOMER',
    });
  });

  it('resolves a specialist’s counterpart the same way, and files it under SPECIALIST', async () => {
    mockPrisma.chatConversation.upsert.mockResolvedValue(
      conversationRow({ participantUserId: BOOKKEEPER_ID, participantKind: 'SPECIALIST' })
    );

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', specialistAuth())
      .send({ companyId: COMPANY_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.chatConversation.upsert.mock.calls[0][0].create.participantKind).toBe('SPECIALIST');
  });

  it('refuses a company with no accounting manager staffed', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(company({ accountingManagerUserId: null }));

    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', ownerAuth())
      .send({ companyId: COMPANY_ID });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_ACCOUNTING_MANAGER');
  });

  it('refuses a manager who is not on this company', async () => {
    const res = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', auth({ userId: OTHER_MANAGER_ID, role: 'ACCOUNTING_MANAGER', specificRole: null }))
      .send({ companyId: COMPANY_ID, participantUserId: OWNER_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.chatConversation.upsert).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* PART 1 — sending and reading                                               */
/* ========================================================================== */

describe('POST /chat/conversations/:id/messages', () => {
  beforeEach(() => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(conversationRow());
    mockPrisma.chatConversation.update.mockResolvedValue({ id: CONVERSATION_ID, lastMessageAt: new Date() });
  });

  it('stores the message and moves the thread’s lastMessageAt in one transaction', async () => {
    const created = messageRow();
    mockPrisma.chatMessage.create.mockResolvedValue(created);

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ body: '  Sent the Q3 books over.  ' });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.chatMessage.create.mock.calls[0][0].data).toMatchObject({
      conversationId: CONVERSATION_ID,
      senderUserId: MANAGER_ID,
      // Trimmed, and stored as typed.
      body: 'Sent the Q3 books over.',
    });

    // The preview column takes the message's OWN timestamp, so the two cannot
    // disagree by the width of the transaction.
    expect(mockPrisma.chatConversation.update.mock.calls[0][0].data.lastMessageAt).toEqual(created.createdAt);
  });

  it('returns the receiver and both email addresses, none of which are stored', async () => {
    mockPrisma.chatMessage.create.mockResolvedValue(messageRow());

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ body: 'hello' });

    expect(res.status).toBe(201);
    // Sender is the manager, so the receiver is the OTHER side of the thread.
    expect(res.body.data.sender.id).toBe(MANAGER_ID);
    expect(res.body.data.sender.email).toBe(`user${MANAGER_ID}@finopsys.ai`);
    expect(res.body.data.receiver.id).toBe(OWNER_ID);
    expect(res.body.data.receiver.email).toBe(`user${OWNER_ID}@finopsys.ai`);
    expect(res.body.data.companyId).toBe(COMPANY_ID);
  });

  it('derives the receiver from the other side when the customer is the sender', async () => {
    mockPrisma.chatMessage.create.mockResolvedValue(
      messageRow({ senderUserId: OWNER_ID, sender: PEOPLE[OWNER_ID] })
    );

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', ownerAuth())
      .send({ body: 'thanks' });

    expect(res.status).toBe(201);
    expect(res.body.data.receiver.id).toBe(MANAGER_ID);
    expect(res.body.data.mine).toBe(true);
  });

  it('refuses a message with neither text nor files', async () => {
    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ body: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_MESSAGE');
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a teammate who is on the company but not in this thread', async () => {
    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', teammateAuth())
      .send({ body: 'let me in' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_ACCESS_DENIED');
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('404s a thread that does not exist', async () => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ body: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });
});

describe('GET /chat/conversations/:id/messages', () => {
  beforeEach(() => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(conversationRow());
  });

  it('returns a page newest-first with the viewer’s own side marked', async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      messageRow({ id: 5002n, senderUserId: OWNER_ID, sender: PEOPLE[OWNER_ID], body: 'second' }),
      messageRow({ id: 5001n, body: 'first' }),
    ]);

    const res = await request(app)
      .get(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.messages.map((m) => m.id)).toEqual([5002, 5001]);
    expect(res.body.data.messages[0].mine).toBe(true);
    expect(res.body.data.messages[1].mine).toBe(false);
    // A short page means there is nothing older to fetch.
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.hasMore).toBe(false);
  });

  it('hands back a cursor when the page is full', async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue(
      Array.from({ length: 2 }, (_, i) => messageRow({ id: BigInt(5100 - i) }))
    );

    const res = await request(app)
      .get(`/api/chat/conversations/${CONVERSATION_ID}/messages?limit=2`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.hasMore).toBe(true);

    // The cursor names the OLDEST row on the page — where the next one starts.
    const decoded = Buffer.from(res.body.data.nextCursor, 'base64url').toString('utf8');
    expect(decoded.endsWith('|5099')).toBe(true);
  });

  it('refuses before and after together', async () => {
    const res = await request(app)
      .get(`/api/chat/conversations/${CONVERSATION_ID}/messages?before=x&after=y`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(400);
  });

  it('refuses an outsider', async () => {
    const res = await request(app)
      .get(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', outsiderAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_ACCESS_DENIED');
  });
});

/* ========================================================================== */
/* PART 2 — the accounting manager's two lists, and the badge                 */
/* ========================================================================== */

describe('GET /chat/contacts/customers', () => {
  it('lists everyone on the customer side, including people never messaged', async () => {
    stageRoster();
    mockPrisma.chatConversation.findMany.mockResolvedValue([conversationRow()]);
    mockPrisma.chatMessage.groupBy.mockResolvedValue([
      { conversationId: CONVERSATION_ID, _count: { _all: 3 } },
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([previewRow()]);

    const res = await request(app)
      .get(`/api/chat/contacts/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('CUSTOMER');
    expect(res.body.data.total).toBe(2);

    const byId = Object.fromEntries(res.body.data.contacts.map((c) => [c.id, c]));
    expect(byId[OWNER_ID]).toMatchObject({
      conversationId: CONVERSATION_ID,
      unreadCount: 3,
      roleLabel: 'Owner',
    });
    // The teammate has no thread yet and still appears — that is how a first
    // message ever gets sent.
    expect(byId[TEAMMATE_ID]).toMatchObject({ conversationId: null, unreadCount: 0, roleLabel: 'Team' });
    expect(res.body.data.unreadTotal).toBe(3);
  });

  it('renders a preview line for a message that is only a file', async () => {
    stageRoster();
    mockPrisma.chatConversation.findMany.mockResolvedValue([conversationRow()]);
    mockPrisma.$queryRaw.mockResolvedValue([previewRow({ body: null, attachment_count: 2n })]);

    const res = await request(app)
      .get(`/api/chat/contacts/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    const owner = res.body.data.contacts.find((c) => c.id === OWNER_ID);
    expect(owner.lastMessage.body).toBeNull();
    // Without this the list would render a blank line, which reads as a bug.
    expect(owner.lastMessage.hasAttachments).toBe(true);
    // A preview counts the files; it does not fetch them.
    expect(owner.lastMessage.attachments).toEqual([]);
    // The sender is reshaped out of the flat SQL row, name and all.
    expect(owner.lastMessage.sender).toMatchObject({ id: MANAGER_ID, name: `User${MANAGER_ID} Test` });
  });

  it('sorts active threads above people who have never written', async () => {
    stageRoster();
    mockPrisma.chatConversation.findMany.mockResolvedValue([conversationRow()]);

    const res = await request(app)
      .get(`/api/chat/contacts/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.body.data.contacts[0].id).toBe(OWNER_ID);
  });

  it('is closed to a customer, who has nobody to choose between', async () => {
    const res = await request(app)
      .get(`/api/chat/contacts/customers?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
  });

  it('requires companyId — there is no merged list across companies', async () => {
    const res = await request(app).get('/api/chat/contacts/customers').set('Authorization', managerAuth());

    expect(res.status).toBe(400);
  });
});

describe('GET /chat/contacts/specialists', () => {
  it('labels a specialist by the lines they cover on this company', async () => {
    stageRoster();
    mockPrisma.companySpecialistAssignment.findMany.mockResolvedValue([
      {
        specialistUserId: BOOKKEEPER_ID,
        specialization: { specializationCode: 'TAX', specializationName: 'Tax' },
      },
    ]);

    const res = await request(app)
      .get(`/api/chat/contacts/specialists?companyId=${COMPANY_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    const contact = res.body.data.contacts.find((c) => c.id === BOOKKEEPER_ID);
    // Standing column (BOOKKEEPING) merged with the live assignment (TAX):
    // neither source is complete on its own.
    expect(contact.specializations.sort()).toEqual(['BOOKKEEPING', 'TAX']);
  });
});

describe('POST /chat/conversations/:id/read', () => {
  beforeEach(() => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(conversationRow());
  });

  it('stamps only what the other side sent, and answers with the new badge', async () => {
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.chatMessage.groupBy.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/read`)
      .set('Authorization', ownerAuth())
      .send({ upToMessageId: '5001' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      conversationId: CONVERSATION_ID,
      markedCount: 2,
      unreadCount: 0,
    });

    const where = mockPrisma.chatMessage.updateMany.mock.calls[0][0].where;
    expect(where.senderUserId).toEqual({ not: OWNER_ID });
    // Already-read rows are untouched, so the timestamp stays the moment it was
    // first opened rather than the last time the window was focused.
    expect(where.readAt).toBeNull();
    expect(where.id).toEqual({ lte: 5001n });
  });

  it('marks the whole thread when no id is given', async () => {
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 5 });

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/read`)
      .set('Authorization', ownerAuth())
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.chatMessage.updateMany.mock.calls[0][0].where.id).toBeUndefined();
  });
});

describe('GET /chat/unread-count', () => {
  it('counts across every thread on the company the caller is in', async () => {
    mockPrisma.chatMessage.count.mockResolvedValue(4);

    const res = await request(app)
      .get(`/api/chat/unread-count?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ companyId: COMPANY_ID, unreadCount: 4 });

    const where = mockPrisma.chatMessage.count.mock.calls[0][0].where;
    expect(where.conversation.companyId).toBe(COMPANY_ID);
    expect(where.senderUserId).toEqual({ not: OWNER_ID });
  });
});

describe('GET /chat/conversations', () => {
  it('returns only the threads the caller is a side of', async () => {
    mockPrisma.chatConversation.findMany.mockResolvedValue([conversationRow()]);

    const res = await request(app)
      .get(`/api/chat/conversations?companyId=${COMPANY_ID}`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    // The counterpart is the OTHER person, whichever side is looking.
    expect(res.body.data.conversations[0].counterpart.id).toBe(MANAGER_ID);

    const where = mockPrisma.chatConversation.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ accountingManagerUserId: OWNER_ID }, { participantUserId: OWNER_ID }]);
  });
});

/* ========================================================================== */
/* PART 3 — attachments                                                       */
/* ========================================================================== */

describe('chat attachments', () => {
  let remote;
  let ticket;
  let stat;
  let signed;
  let removed;

  beforeEach(() => {
    remote = jest.spyOn(storage, 'isRemote').mockReturnValue(true);
    ticket = jest.spyOn(storage, 'signedUploadUrl').mockImplementation(async ({ key }) => ({
      url: `https://project.supabase.co/storage/v1/object/upload/sign/${key}?token=t`,
      token: 't',
      key,
    }));
    stat = jest
      .spyOn(storage, 'statObject')
      .mockResolvedValue({ sizeBytes: 5000, contentType: 'application/pdf' });
    signed = jest
      .spyOn(storage, 'signedUrl')
      .mockResolvedValue('https://project.supabase.co/storage/v1/object/sign/x?token=abc');
    removed = jest.spyOn(storage, 'removeObjects').mockResolvedValue(undefined);

    mockPrisma.chatConversation.findUnique.mockResolvedValue(conversationRow());
    mockPrisma.chatConversation.update.mockResolvedValue({ id: CONVERSATION_ID, lastMessageAt: new Date() });
  });

  afterEach(() => {
    remote.mockRestore();
    ticket.mockRestore();
    stat.mockRestore();
    signed.mockRestore();
    removed.mockRestore();
  });

  it('mints an upload key scoped to the conversation', async () => {
    const res = await request(app)
      .post('/api/chat/attachments/upload-url')
      .set('Authorization', ownerAuth())
      .send({
        conversationId: CONVERSATION_ID,
        files: [{ fileName: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.uploads[0].key).toMatch(
      new RegExp(`^chat/${CONVERSATION_ID}/[0-9a-f]{32}\\.pdf$`)
    );
    expect(res.body.data.uploads[0].uploadUrl).toContain('upload/sign');
  });

  it('refuses a ticket to someone who is not in the thread', async () => {
    const res = await request(app)
      .post('/api/chat/attachments/upload-url')
      .set('Authorization', teammateAuth())
      .send({
        conversationId: CONVERSATION_ID,
        files: [{ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
      });

    expect(res.status).toBe(403);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('refuses a type outside the allowlist before any ticket is issued', async () => {
    const res = await request(app)
      .post('/api/chat/attachments/upload-url')
      .set('Authorization', ownerAuth())
      .send({
        conversationId: CONVERSATION_ID,
        files: [{ fileName: 'run.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 }],
      });

    expect(res.status).toBe(415);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('records what the BUCKET says, not what the client claimed', async () => {
    mockPrisma.chatMessage.create.mockResolvedValue(
      messageRow({
        body: null,
        attachments: [
          { id: ATTACHMENT_ID, originalName: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 5000n },
        ],
      })
    );

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(201);

    const attachments = mockPrisma.chatMessage.create.mock.calls[0][0].data.attachments.createMany.data;
    expect(attachments[0]).toEqual({
      fileKey: chatKey(),
      originalName: 'statement.pdf',
      mimeType: 'application/pdf',
      // Measured, not declared — the request never said a size at all.
      sizeBytes: 5000n,
    });
    // A BigInt column has to survive JSON serialisation as a number.
    expect(res.body.data.attachments[0].sizeBytes).toBe(5000);
  });

  it('sends a file with no caption', async () => {
    mockPrisma.chatMessage.create.mockResolvedValue(messageRow({ body: null }));

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(201);
    expect(mockPrisma.chatMessage.create.mock.calls[0][0].data.body).toBeNull();
  });

  it('refuses a key minted for a different conversation', async () => {
    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(OTHER_CONVERSATION_ID), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_UPLOAD_KEY');
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('refuses an upload that never arrived in the bucket', async () => {
    stat.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a key already recorded on another message', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([{ id: ATTACHMENT_ID, fileKey: chatKey() }]);

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTACHMENT_ALREADY_RECORDED');
  });

  it('discards the stored objects when the write fails', async () => {
    mockPrisma.chatMessage.create.mockRejectedValue(new Error('db down'));

    const res = await request(app)
      .post(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', managerAuth())
      .send({ files: [{ key: chatKey(), fileName: 'statement.pdf' }] });

    expect(res.status).toBe(500);
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ keys: [chatKey()] }));
  });

  it('signs a download link for a side of the thread', async () => {
    mockPrisma.chatAttachment.findUnique.mockResolvedValue({
      id: ATTACHMENT_ID,
      fileKey: chatKey(),
      originalName: 'statement.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5000n,
      message: { id: 5001n, deletedAt: null, conversation: conversationRow() },
    });

    const res = await request(app)
      .get(`/api/chat/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.url).toContain('object/sign');
    expect(res.body.data.fileName).toBe('statement.pdf');
    // The storage key is never in the response.
    expect(JSON.stringify(res.body)).not.toContain(chatKey());
  });

  it('refuses a download to someone outside the thread', async () => {
    mockPrisma.chatAttachment.findUnique.mockResolvedValue({
      id: ATTACHMENT_ID,
      fileKey: chatKey(),
      originalName: 'statement.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5000n,
      message: { id: 5001n, deletedAt: null, conversation: conversationRow() },
    });

    const res = await request(app)
      .get(`/api/chat/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', teammateAuth());

    expect(res.status).toBe(403);
    expect(signed).not.toHaveBeenCalled();
  });

  it('will not sign a link for a deleted message', async () => {
    mockPrisma.chatAttachment.findUnique.mockResolvedValue({
      id: ATTACHMENT_ID,
      fileKey: chatKey(),
      originalName: 'statement.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5000n,
      message: { id: 5001n, deletedAt: new Date(), conversation: conversationRow() },
    });

    const res = await request(app)
      .get(`/api/chat/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(404);
    expect(signed).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* deleting                                                                   */
/* ========================================================================== */

describe('DELETE /chat/messages/:id', () => {
  let removed;

  beforeEach(() => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue({
      id: 5001n,
      conversationId: CONVERSATION_ID,
      senderUserId: MANAGER_ID,
      deletedAt: null,
      conversation: {
        id: CONVERSATION_ID,
        companyId: COMPANY_ID,
        accountingManagerUserId: MANAGER_ID,
        participantUserId: OWNER_ID,
      },
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });

    // No attachments unless a test says so.
    mockPrisma.chatAttachment.findMany.mockResolvedValue([]);
    mockPrisma.chatAttachment.updateMany.mockResolvedValue({ count: 0 });
    removed = jest.spyOn(storage, 'removeObjects').mockResolvedValue(undefined);
  });

  afterEach(() => removed.mockRestore());

  it('soft deletes the sender’s own message', async () => {
    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 5001, conversationId: CONVERSATION_ID, deleted: true });

    const args = mockPrisma.chatMessage.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5001n, deletedAt: null });
    expect(args.data.deletedAt).toBeInstanceOf(Date);
  });

  /* ------------------------------------------------------------------------ */
  /* the files                                                                */
  /* ------------------------------------------------------------------------ */

  it('deletes the attached objects from the bucket and nulls their keys', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      { id: 71, fileKey: 'chat/9001/aaaa1111.pdf' },
      { id: 72, fileKey: 'chat/9001/bbbb2222.png' },
    ]);
    mockPrisma.chatAttachment.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.attachmentsPurged).toBe(2);

    // The bytes: both keys handed to the bucket, in one call.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0].keys).toEqual([
      'chat/9001/aaaa1111.pdf',
      'chat/9001/bbbb2222.png',
    ]);

    // The metadata: only file_key is touched — no delete, no other column.
    const cleared = mockPrisma.chatAttachment.updateMany.mock.calls[0][0];
    expect(cleared).toEqual({
      where: { messageId: 5001n, fileKey: { not: null } },
      data: { fileKey: null },
    });
  });

  it('removes the objects BEFORE forgetting where they were', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      { id: 71, fileKey: 'chat/9001/aaaa1111.pdf' },
    ]);
    mockPrisma.chatAttachment.updateMany.mockResolvedValue({ count: 1 });

    const order = [];
    removed.mockImplementation(async () => { order.push('bucket'); });
    mockPrisma.chatAttachment.updateMany.mockImplementation(async () => {
      order.push('null-key');
      return { count: 1 };
    });

    await request(app).delete('/api/chat/messages/5001').set('Authorization', managerAuth());

    // Reversed, this would strand an object that nothing can ever name again.
    expect(order).toEqual(['bucket', 'null-key']);
  });

  it('does not re-purge a message that was already deleted', async () => {
    // The second click: the conditional soft delete matched nothing.
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.attachmentsPurged).toBe(0);
    expect(mockPrisma.chatAttachment.findMany).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(mockPrisma.chatAttachment.updateMany).not.toHaveBeenCalled();
  });

  it('still reports the delete when the bucket is down', async () => {
    mockPrisma.chatAttachment.findMany.mockResolvedValue([
      { id: 71, fileKey: 'chat/9001/aaaa1111.pdf' },
    ]);
    mockPrisma.chatAttachment.updateMany.mockResolvedValue({ count: 1 });
    // storage.removeObjects swallows and logs; it must never surface as a 500
    // on a delete the database already committed.
    removed.mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it('refuses to delete the other side’s message', async () => {
    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_MESSAGE_DELETE_FORBIDDEN');
    expect(mockPrisma.chatMessage.updateMany).not.toHaveBeenCalled();
  });

  it('refuses someone outside the thread without saying the message exists', async () => {
    const res = await request(app)
      .delete('/api/chat/messages/5001')
      .set('Authorization', teammateAuth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_ACCESS_DENIED');
  });
});

/* ========================================================================== */
/* PART 4 — the live connection's credential                                  */
/* ========================================================================== */

describe('GET /chat/realtime-token', () => {
  const SECRET = 'supabase-test-jwt-secret';
  let original;

  beforeEach(() => {
    original = config.realtime.supabaseJwtSecret;
    config.realtime.supabaseJwtSecret = SECRET;
  });

  afterEach(() => {
    config.realtime.supabaseJwtSecret = original;
  });

  it('signs a token Supabase will accept, carrying the caller’s id', async () => {
    const res = await request(app).get('/api/chat/realtime-token').set('Authorization', ownerAuth());

    expect(res.status).toBe(200);

    const claims = jwt.verify(res.body.data.token, SECRET, { audience: 'authenticated' });
    // The claim every RLS policy in 21_add_chat_realtime.sql filters on.
    expect(claims.app_user_id).toBe(OWNER_ID);
    expect(claims.role).toBe('authenticated');
    expect(claims.sub).toBe(String(OWNER_ID));
    expect(claims.exp - claims.iat).toBe(config.realtime.tokenTtlSeconds);
  });

  it('is signed with the SUPABASE secret, so it opens nothing in this API', async () => {
    const res = await request(app).get('/api/chat/realtime-token').set('Authorization', ownerAuth());

    // Presented as an access token, it is rejected: different key entirely.
    const replay = await request(app)
      .get(`/api/chat/unread-count?companyId=${COMPANY_ID}`)
      .set('Authorization', `Bearer ${res.body.data.token}`);

    expect(replay.status).toBe(401);
  });

  it('says so plainly when live chat is not configured', async () => {
    config.realtime.supabaseJwtSecret = '';

    const res = await request(app).get('/api/chat/realtime-token').set('Authorization', ownerAuth());

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REALTIME_UNAVAILABLE');
  });

  it('needs a session of its own', async () => {
    const res = await request(app).get('/api/chat/realtime-token');
    expect(res.status).toBe(401);
  });
});

/* ========================================================================== */
/* reactions                                                                  */
/* ========================================================================== */

describe('chat reactions', () => {
  // The manager's message 5001 in the manager/owner thread.
  function accessRow(overrides = {}) {
    return {
      id: 5001n,
      conversationId: CONVERSATION_ID,
      senderUserId: MANAGER_ID,
      deletedAt: null,
      conversation: {
        id: CONVERSATION_ID,
        companyId: COMPANY_ID,
        accountingManagerUserId: MANAGER_ID,
        participantUserId: OWNER_ID,
      },
      ...overrides,
    };
  }

  // A file on that message, in the shape findAttachmentForDownload returns.
  function attachmentRow(overrides = {}) {
    return {
      id: ATTACHMENT_ID,
      fileKey: chatKey(),
      originalName: 'statement.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048n,
      message: { id: 5001n, deletedAt: null, conversation: accessRow().conversation },
      ...overrides,
    };
  }

  function reactionRow(userId, reaction, attachmentId = null) {
    return { attachmentId, userId, reaction };
  }

  /** The SQL text of one tagged-template $executeRaw call. */
  const sqlOf = (call) => call[0].join('?');

  beforeEach(() => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(accessRow());
    mockPrisma.chatAttachment.findUnique.mockResolvedValue(attachmentRow());
  });

  it('lets the other side react to a message, as themselves', async () => {
    mockPrisma.chatReaction.findMany.mockResolvedValue([reactionRow(OWNER_ID, 'love')]);

    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth())
      .send({ reaction: 'love' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      messageId: 5001,
      attachmentId: null,
      reactions: [{ reaction: 'love', count: 1, reactedByMe: true }],
    });

    const call = mockPrisma.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('ON CONFLICT (message_id, user_id) WHERE attachment_id IS NULL');
    // Message, reactor, emoji — and the reactor is the token's user.
    expect(call.slice(1)).toEqual([5001n, OWNER_ID, 'love']);
  });

  it('reacts to one file on the message, keyed on that file', async () => {
    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', managerAuth())
      .send({ reaction: 'like', attachmentId: ATTACHMENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.attachmentId).toBe(ATTACHMENT_ID);

    const call = mockPrisma.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('ON CONFLICT (attachment_id, user_id) WHERE attachment_id IS NOT NULL');
    expect(call.slice(1)).toEqual([5001n, ATTACHMENT_ID, MANAGER_ID, 'like']);
  });

  it('refuses a file that belongs to a different message', async () => {
    mockPrisma.chatAttachment.findUnique.mockResolvedValue(
      attachmentRow({ message: { id: 6000n, deletedAt: null, conversation: accessRow().conversation } })
    );

    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', managerAuth())
      .send({ reaction: 'like', attachmentId: ATTACHMENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHAT_ATTACHMENT_NOT_FOUND');
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses an emoji that is not on the list', async () => {
    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth())
      .send({ reaction: 'angry' });

    expect(res.status).toBe(400);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a body that names a different reactor', async () => {
    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth())
      .send({ reaction: 'love', userId: MANAGER_ID });

    expect(res.status).toBe(400);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses someone who is not in the thread', async () => {
    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', outsiderAuth())
      .send({ reaction: 'love' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_ACCESS_DENIED');
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a deleted message', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(accessRow({ deletedAt: new Date() }));

    const res = await request(app)
      .put('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth())
      .send({ reaction: 'love' });

    expect(res.status).toBe(404);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('removes only the caller’s own reaction', async () => {
    mockPrisma.chatReaction.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
    // The caller's id is in the WHERE — the other side's reaction cannot match.
    expect(mockPrisma.chatReaction.deleteMany.mock.calls[0][0].where).toEqual({
      messageId: 5001n,
      attachmentId: null,
      userId: OWNER_ID,
    });
  });

  it('removes a file reaction when the file is named in the query', async () => {
    mockPrisma.chatReaction.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete(`/api/chat/messages/5001/reaction?attachmentId=${ATTACHMENT_ID}`)
      .set('Authorization', managerAuth());

    expect(res.status).toBe(200);
    expect(mockPrisma.chatReaction.deleteMany.mock.calls[0][0].where).toEqual({
      messageId: 5001n,
      attachmentId: ATTACHMENT_ID,
      userId: MANAGER_ID,
    });
  });

  it('treats removing a reaction you do not have as a no-op, not a 404', async () => {
    const res = await request(app)
      .delete('/api/chat/messages/5001/reaction')
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(false);
  });

  it('folds reactions onto the message and each file in a thread page', async () => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(conversationRow());
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      messageRow({
        attachments: [{ id: ATTACHMENT_ID, originalName: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 2048n }],
        reactions: [
          { attachmentId: null, userId: OWNER_ID, reaction: 'love' },
          { attachmentId: null, userId: MANAGER_ID, reaction: 'love' },
          { attachmentId: ATTACHMENT_ID, userId: MANAGER_ID, reaction: 'like' },
        ],
      }),
    ]);

    const res = await request(app)
      .get(`/api/chat/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', ownerAuth());

    expect(res.status).toBe(200);
    const [message] = res.body.data.messages;
    expect(message.reactions).toEqual([{ reaction: 'love', count: 2, reactedByMe: true }]);
    expect(message.attachments[0].reactions).toEqual([{ reaction: 'like', count: 1, reactedByMe: false }]);
  });
});
