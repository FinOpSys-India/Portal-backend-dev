'use strict';

const path = require('path');

const config = require('../config');
const { prisma } = require('../config/prisma');
const repo = require('../repositories/chatRepository');
const emailRepo = require('../repositories/emailRepository');
const projectService = require('./projectService');
const dto = require('../dto/chatDto');
const { encodeCursor } = require('../validators/chatValidator');
const storage = require('../utils/storage');
const { chatAttachmentKey, EXTENSION_BY_MIME, ACCEPTED_LABEL } = require('../utils/documentTypes');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');

/**
 * Company-scoped chat between an accounting manager and the people on that
 * company's account.
 *
 * THE SHAPE OF THE FEATURE
 *
 *   A thread is (company, accounting manager, counterpart). The counterpart is a
 *   CUSTOMER — the company's owner or one of its teammates — or a SPECIALIST
 *   working the account. Those two groups are the two sections of the accounting
 *   manager's portal, and `participantKind` on the row is which section a thread
 *   belongs in.
 *
 *   The manager picks who to write to. Nobody else has a choice to make: a
 *   customer or a specialist has exactly one counterpart on a company, its
 *   assigned accounting manager, so their side of `openConversation` takes no
 *   participant at all.
 *
 * THE FOUR RULES THIS FILE OWNS
 *
 *   1. A THREAD IS OPENED ONLY BY ITS OWN COMPANY'S CURRENT MANAGER. Both sides
 *      are checked against `companies.accounting_manager_user_id` at the moment
 *      the thread is created — and never again. See `assertCurrentManager` and
 *      the note above it: the check belongs at creation, because after that the
 *      row is history.
 *
 *   2. READING AND WRITING A THREAD REQUIRES BEING ONE OF ITS TWO SIDES.
 *      Not "having access to the company" — that is a wider rule, and it is the
 *      wrong one here: a teammate on the account may read the company's
 *      documents but must not read the owner's private conversation with the
 *      accounting manager. `assertParticipant` is the whole authorization for
 *      every read and write below.
 *
 *   3. AN ADMIN HAS NO ACCESS AT ALL. Not read, not write, on any thread. This
 *      falls out of rule 2 rather than being a separate check — an admin is
 *      never one of the two sides — and it matches projectService, where an
 *      admin is likewise refused a client's working material. Administering the
 *      platform is not the same as being party to a conversation.
 *
 *   4. WHAT IS STORED IS WHAT WAS SAID. A message is written once. The only
 *      writes afterwards are the read receipt and the soft delete, both of which
 *      touch one timestamp column and neither of which can alter the text.
 *
 * WHAT THIS FILE DOES NOT DO IS DELIVER ANYTHING LIVE. The browser subscribes to
 * Supabase Realtime directly and this API is not in that path — see
 * chatRealtimeService for why, and db/schema/21_add_chat_realtime.sql for what
 * makes it safe. Every write below lands in Postgres, and the replication stream
 * does the rest.
 */

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

function conversationNotFound() {
  return new ApiError(404, 'Conversation not found.', { code: 'CONVERSATION_NOT_FOUND' });
}

/**
 * The refusal for every access failure on a thread.
 *
 * DELIBERATELY THE SAME ANSWER whether the caller is on the wrong company, on
 * the right company but not in this thread, or an admin. A 404-vs-403 split here
 * would let anyone walk the id space and learn which conversations exist and
 * roughly who is talking to whom — which is most of what a chat leaks even
 * without its contents.
 */
function chatAccessDenied() {
  return new ApiError(403, 'You do not have access to this conversation.', {
    code: 'CHAT_ACCESS_DENIED',
  });
}

function messageNotFound() {
  return new ApiError(404, 'Message not found.', { code: 'CHAT_MESSAGE_NOT_FOUND' });
}

function attachmentNotFound() {
  return new ApiError(404, 'That attachment is no longer available.', {
    code: 'CHAT_ATTACHMENT_NOT_FOUND',
  });
}

function noAccountingManager() {
  return new ApiError(409, 'This company has no accounting manager yet.', {
    code: 'NO_ACCOUNTING_MANAGER',
  });
}

/** See projectDocumentService.directTransferUnavailable — same misconfiguration. */
function directTransferUnavailable() {
  logger.error(
    'Chat attachment storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are ' +
      `required for uploads and downloads, and the active driver is "${config.storage.driver}".`
  );

  return new ApiError(503, 'Attachment storage is not available right now.', {
    code: 'DIRECT_TRANSFER_UNAVAILABLE',
    details: { driver: config.storage.driver },
  });
}

/* -------------------------------------------------------------------------- */
/* the stored objects                                                         */
/* -------------------------------------------------------------------------- */

const BUCKET = config.storage.documentsBucket;

// `chat_attachments.original_name` is VARCHAR(255).
const MAX_NAME_LENGTH = 255;

/** Never throws — storage.removeObjects swallows and logs. */
function discardStoredObjects(keys, requestId) {
  if (!keys.length) return Promise.resolve();
  return storage.removeObjects({ bucket: BUCKET, keys, requestId });
}

/**
 * The uploader's own name for the file, made safe to store and to echo back.
 *
 * Identical rules to projectDocumentService.toDisplayName and its email
 * counterpart, for identical reasons: directory parts dropped (a drag-and-drop
 * can send "C:\\Users\\me\\x.pdf"), control characters stripped (this string is
 * echoed into JSON, into a Content-Disposition header and into an audit log — a
 * raw newline in any of those is header injection), and capped at the column
 * width keeping the extension.
 */
function toDisplayName(originalName) {
  const base = String(originalName ?? '')
    .split(/[\\/]/)
    .pop();

  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return 'document';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  const ext = path.extname(cleaned).slice(0, 20);
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** The MIME type a stored key implies — see projectDocumentService for why. */
const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime])
);

/**
 * A key is only acceptable if it is one WE could have issued, FOR THIS THREAD.
 *
 * `chat/<conversationId>/<32 hex><ext>` is exactly what `chatAttachmentKey`
 * produces. The id is interpolated from the conversation in the URL — which the
 * caller has already been authorized against — never from anything in the body,
 * which is what stops a file uploaded for one client's thread being attached to
 * another client's thread. The signed ticket alone would not prevent that: it is
 * spent by the time the send runs, and nothing in the key itself says who asked
 * for it.
 */
function isKeyForConversation(key, conversationId) {
  return new RegExp(`^chat/${conversationId}/[0-9a-f]{32}(\\.[a-z0-9]+)?$`).test(key);
}

/* -------------------------------------------------------------------------- */
/* access                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read access to the COMPANY — the gate on opening a thread and on listing
 * contacts, and nothing else.
 *
 * Reused from projectService rather than reimplemented, so "who may reach this
 * company" is decided in exactly one place across projects, documents, tasks,
 * email and now chat. The rule it applies: the company's owner, a teammate on
 * company_members, the company's accounting manager, or a specialist actively
 * assigned to it — and NOT an admin, which is why rule 3 in the header needs no
 * code of its own.
 *
 * It is deliberately NOT the rule for reading a thread. See `assertParticipant`.
 */
function loadCompanyForRead(userId, companyId) {
  return projectService.loadCompanyForRead(prisma, { userId, companyId });
}

/**
 * The caller is one of this thread's two sides. This is the whole authorization
 * for every message read, send, mark-read, delete and download below.
 *
 * NARROWER THAN COMPANY ACCESS, ON PURPOSE. Everyone on a company can read that
 * company's documents; a private conversation is not company material. A
 * teammate must not be able to read the owner's thread with the accounting
 * manager, and one specialist must not be able to read another's — both of which
 * `loadCompanyForRead` would happily allow, because both are legitimately on the
 * account.
 *
 * IT IS ALSO NOT RE-CHECKED AGAINST THE COMPANY. An accounting manager who has
 * since been moved off the account keeps access to the threads they actually
 * held, and that follows from the same decision that made
 * `accounting_manager_user_id` a column on the thread rather than a join: those
 * conversations are theirs, and a reassignment is not a reason to hide what was
 * already said to them.
 */
function assertParticipant(caller, conversation) {
  if (conversation.accountingManagerUserId === caller.id) return;
  if (conversation.participantUserId === caller.id) return;
  throw chatAccessDenied();
}

/**
 * The caller is the company's CURRENT accounting manager.
 *
 * Used at exactly two moments: opening a thread, and listing the contacts to
 * open one with. Both are the manager's portal, and both are about the account
 * as it is staffed right now — which is the one question
 * `companies.accounting_manager_user_id` answers correctly.
 *
 * Never used to read an existing thread. See `assertParticipant`.
 */
function assertCurrentManager(caller, company) {
  if (company.accountingManagerUserId && company.accountingManagerUserId === caller.id) return;
  throw new ApiError(403, 'Only this company’s accounting manager can do that.', {
    code: 'NOT_COMPANY_MANAGER',
  });
}

const isAccountingManager = (caller) => caller.role?.code === 'ACCOUNTING_MANAGER';

/**
 * Load a thread the caller is a side of, or refuse.
 *
 * The single entry point for everything that operates on an existing thread, so
 * there is exactly one place the authorization can be got wrong.
 */
async function loadConversationForParticipant(userId, conversationId) {
  const caller = await loadCaller(userId);

  const conversation = await repo.findConversationById(prisma, conversationId);
  if (!conversation) throw conversationNotFound();

  assertParticipant(caller, conversation);
  return { caller, conversation };
}

/**
 * The caller's own row, with their role.
 *
 * Goes through projectService's company read for consistency everywhere else,
 * but a thread lookup has no company to load first — the thread names its own —
 * so the caller is read directly here. `req.user.id` is already verified; what
 * this adds is the role, which decides which side of a new thread they are on.
 */
async function loadCaller(userId) {
  const caller = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: { select: { code: true } }, specificRole: { select: { code: true } } },
  });
  if (!caller) throw new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
  return caller;
}

/* -------------------------------------------------------------------------- */
/* the roster                                                                 */
/* -------------------------------------------------------------------------- */

/** "Owner" / "Team" — what a CUSTOMER user is on the account. */
function customerRoleLabel(person, company) {
  if (person.id === company.ownerUserId) return 'Owner';
  if (person.specificRole?.code === 'OWNER') return 'Owner';
  if (person.specificRole?.code === 'TEAM') return 'Team';
  return person.specificRole?.name ?? 'Customer';
}

/**
 * The company's customers: its owner AND its teammates, in one list.
 *
 * Read through emailRepository rather than a query of this feature's own, and
 * that is the point: the merge of `companies.owner_user_id` with
 * `company_members` — including the dedupe for an owner who also holds a
 * membership row — is one decision, and a second copy of it would drift the
 * first time either was changed. The email picker and the chat contact list are
 * the same question asked by two screens.
 */
function loadCustomers({ companyId, search }) {
  return search
    ? emailRepo.searchCompanyCustomers(prisma, { companyId, search })
    : emailRepo.listCompanyCustomers(prisma, { companyId });
}

/**
 * The company's specialists, with the service lines each covers on THIS company.
 *
 * Two sources merged, for the reason set out at length in emailRepository: the
 * three standing columns cannot express an FP&A specialist (no column), and the
 * assignment table can be empty for a standing specialist set directly on the
 * company. Either source alone silently makes somebody unreachable.
 */
async function loadSpecialists({ companyId, search }) {
  const sources = await emailRepo.listCompanySpecialistSources(prisma, companyId);

  const codesByUser = new Map();
  const add = (specialistId, code) => {
    if (!specialistId) return;
    if (!codesByUser.has(specialistId)) codesByUser.set(specialistId, new Set());
    if (code) codesByUser.get(specialistId).add(code);
  };

  for (const entry of sources.standing) add(entry.userId, entry.specializationCode);
  for (const row of sources.assignments) add(row.specialistUserId, row.specialization?.specializationCode);

  const people = await emailRepo.findSpecialistsByIds(prisma, [...codesByUser.keys()], { search });
  return { people, codesByUser };
}

/* -------------------------------------------------------------------------- */
/* the accounting manager's two lists                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fold the threads, unread counts and preview lines onto a list of people.
 *
 * THREE QUERIES FOR THE WHOLE LIST, not three per person. The threads come back
 * in one `IN` lookup, the counts in one GROUP BY, and the previews in one
 * DISTINCT ON — see chatRepository. A per-row version of this is the classic way
 * a contact list with forty people becomes a hundred and twenty round trips to a
 * managed Postgres, all of them fast and the page still slow.
 */
async function decorateContacts({ company, managerUserId, people, labelFor, specializationsFor, kind }) {
  const participantUserIds = people.map((person) => person.id);

  const conversations = await repo.findConversationsForParticipants(prisma, {
    companyId: company.id,
    accountingManagerUserId: managerUserId,
    participantUserIds,
  });

  const byParticipant = new Map(conversations.map((c) => [c.participantUserId, c]));
  const conversationIds = conversations.map((c) => c.id);

  const [unreadByConversation, latestMessages] = await Promise.all([
    repo.countUnreadByConversation(prisma, { conversationIds, userId: managerUserId }),
    repo.findLatestMessages(prisma, { conversationIds }),
  ]);

  const latestByConversation = new Map(latestMessages.map((m) => [m.conversationId, m]));

  const contacts = people.map((person) => {
    const conversation = byParticipant.get(person.id) ?? null;
    return dto.toContact(person, {
      kind,
      roleLabel: labelFor(person),
      specializations: specializationsFor(person),
      conversation,
      unreadCount: conversation ? unreadByConversation.get(conversation.id) ?? 0 : 0,
      lastMessage: conversation ? latestByConversation.get(conversation.id) ?? null : null,
      viewerUserId: managerUserId,
    });
  });

  /*
   * Threads first, most recent first; everyone else after, alphabetically. The
   * list is a work queue before it is a directory — the person who wrote an hour
   * ago belongs above the twelve people who have never written — and a purely
   * alphabetical order would bury an active conversation under names.
   */
  contacts.sort((a, b) => {
    if (a.lastMessageAt && b.lastMessageAt) return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
    if (a.lastMessageAt) return -1;
    if (b.lastMessageAt) return 1;
    return String(a.name).localeCompare(String(b.name));
  });

  return dto.toContactList({ company, kind, contacts });
}

/**
 * GET /chat/contacts/customers?companyId=&search=
 *
 * Section one of the accounting manager's portal: everyone on the customer side
 * of one company — its owner and its teammates — each with their thread, their
 * unread count and the last thing said, or with nulls if they have never been
 * messaged.
 *
 * PEOPLE WITH NO THREAD ARE THE POINT, not an edge case. A list built from
 * conversations could only ever show the people already being talked to, and
 * there would be no way to send anyone a first message.
 *
 * A ROLE GATE HERE, unlike most reads in this API. `assertCurrentManager` limits
 * it to the company's own accounting manager, because this endpoint exists to
 * answer "who can I start a chat with", and the answer is only ever asked by the
 * one person who has a choice. Everyone else's counterpart is fixed.
 */
async function listCustomerContacts({ userId, requestId, query }) {
  const { caller, company } = await loadCompanyForRead(userId, query.companyId);
  assertCurrentManager(caller, company);

  const people = await loadCustomers({ companyId: company.id, search: query.search });

  const data = await decorateContacts({
    company,
    managerUserId: caller.id,
    people,
    kind: 'CUSTOMER',
    labelFor: (person) => customerRoleLabel(person, company),
    specializationsFor: () => [],
  });

  logEvent({
    event: 'chat.contacts.customers.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${data.total} customer(s)`,
  });

  return data;
}

/**
 * GET /chat/contacts/specialists?companyId=&search=
 *
 * Section two, same shape and same rules — only the roster differs. The role
 * label is the service lines this specialist covers on THIS company rather than
 * their job title, because "BOOKKEEPING, TAX" is what tells one specialist from
 * another in a list, while "Tax Specialist" describes them globally and can
 * disagree with what they actually do on this account.
 */
async function listSpecialistContacts({ userId, requestId, query }) {
  const { caller, company } = await loadCompanyForRead(userId, query.companyId);
  assertCurrentManager(caller, company);

  const { people, codesByUser } = await loadSpecialists({ companyId: company.id, search: query.search });

  const data = await decorateContacts({
    company,
    managerUserId: caller.id,
    people,
    kind: 'SPECIALIST',
    labelFor: (person) => {
      const codes = [...(codesByUser.get(person.id) ?? [])];
      return codes.length ? codes.join(', ') : 'Specialist';
    },
    specializationsFor: (person) => [...(codesByUser.get(person.id) ?? [])],
  });

  logEvent({
    event: 'chat.contacts.specialists.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${data.total} specialist(s)`,
  });

  return data;
}

/* -------------------------------------------------------------------------- */
/* threads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * GET /chat/conversations?companyId=
 *
 * Every thread on one company that the caller is a side of.
 *
 * ONE ENDPOINT FOR THREE PORTALS, and the `OR` in the query is what makes that
 * work: an accounting manager matches on one arm and gets every thread they hold
 * on the account, a customer or specialist matches on the other and gets only
 * their own. Neither can see the other's, because no arm of the query would
 * return it.
 *
 * The company scope is checked first — a caller who cannot reach the company at
 * all gets the company's own 403, not an empty list, because an empty list is
 * indistinguishable from "you have no threads" and hides the real problem.
 */
async function listConversations({ userId, requestId, query }) {
  const { caller, company } = await loadCompanyForRead(userId, query.companyId);

  const conversations = await repo.listConversationsForUser(prisma, {
    companyId: company.id,
    userId: caller.id,
  });

  const conversationIds = conversations.map((c) => c.id);
  const [unreadByConversation, latestMessages] = await Promise.all([
    repo.countUnreadByConversation(prisma, { conversationIds, userId: caller.id }),
    repo.findLatestMessages(prisma, { conversationIds }),
  ]);
  const latestByConversation = new Map(latestMessages.map((m) => [m.conversationId, m]));

  const data = dto.toConversationList({
    company,
    conversations: conversations.map((conversation) =>
      dto.toConversation(conversation, {
        viewerUserId: caller.id,
        unreadCount: unreadByConversation.get(conversation.id) ?? 0,
        lastMessage: latestByConversation.get(conversation.id) ?? null,
      })
    ),
  });

  logEvent({
    event: 'chat.conversations.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${data.total} thread(s)`,
  });

  return data;
}

/**
 * Work out the two sides of a thread the caller is asking to open.
 *
 * THE ANSWER DEPENDS ON WHO IS ASKING, and that asymmetry is the feature:
 *
 *   an ACCOUNTING MANAGER names the counterpart, and it is resolved against the
 *   company's actual roster — a user id in a request body is a claim, and
 *   without this check a manager legitimately on company 5 could open a thread
 *   with any user id in the database. Which list the person turns up on is also
 *   what sets `participantKind`, so the thread lands in the right section
 *   without anyone declaring it.
 *
 *   anyone ELSE gets the company's assigned accounting manager, because that is
 *   their only possible counterpart. They cannot name one, and there is nothing
 *   to check beyond the company access already established: `companyId` is the
 *   entire request.
 *
 * A company with no manager staffed is a 409 rather than a 404 or a silent
 * empty: the company exists, the request is well-formed, and the reason it
 * cannot be satisfied is a staffing state somebody can fix.
 */
async function resolveSides({ caller, company, participantUserId }) {
  if (isAccountingManager(caller)) {
    assertCurrentManager(caller, company);

    if (!participantUserId) {
      throw new ApiError(400, 'Choose who you want to chat with.', {
        code: 'VALIDATION_ERROR',
        fields: { participantUserId: 'Choose a customer or a specialist.' },
      });
    }

    const [customers, specialists] = await Promise.all([
      loadCustomers({ companyId: company.id, search: null }),
      loadSpecialists({ companyId: company.id, search: null }),
    ]);

    if (customers.some((person) => person.id === participantUserId)) {
      return {
        accountingManagerUserId: caller.id,
        participantUserId,
        participantKind: 'CUSTOMER',
      };
    }

    if (specialists.people.some((person) => person.id === participantUserId)) {
      return {
        accountingManagerUserId: caller.id,
        participantUserId,
        participantKind: 'SPECIALIST',
      };
    }

    /*
     * A 404 naming the person rather than a 403. They are not on this company,
     * so from this request's point of view they do not exist — and saying
     * "forbidden" would confirm that the user id belongs to somebody.
     */
    throw new ApiError(404, 'That person is not on this company.', {
      code: 'PARTICIPANT_NOT_ON_COMPANY',
      fields: { participantUserId: 'Choose someone from this company.' },
    });
  }

  if (!company.accountingManagerUserId) throw noAccountingManager();

  return {
    accountingManagerUserId: company.accountingManagerUserId,
    participantUserId: caller.id,
    /*
     * From the caller's ROLE, not from which roster they turn up on — they have
     * already passed the company access check, so they are on the account, and
     * the role is what decides which of the manager's two sections their thread
     * belongs in. A CUSTOMER is the owner or a teammate; anyone else reaching
     * here is a specialist working the account.
     */
    participantKind: caller.role?.code === 'CUSTOMER' ? 'CUSTOMER' : 'SPECIALIST',
  };
}

/**
 * POST /chat/conversations — open the thread, or hand back the one that exists.
 *
 * IDEMPOTENT BY CONSTRUCTION. Opening a chat window is not a creation event the
 * user thinks about, and clicking a person twice must not be an error, so this
 * upserts on the unique key and returns the same thread either way. It answers
 * 200 rather than 201 for that reason: the caller cannot tell, and should not
 * have to, whether the row already existed.
 */
async function openConversation({ userId, requestId, body }) {
  const { caller, company } = await loadCompanyForRead(userId, body.companyId);

  const sides = await resolveSides({
    caller,
    company,
    participantUserId: body.participantUserId,
  });

  const conversation = await repo.openConversation(prisma, {
    companyId: company.id,
    ...sides,
  });

  logEvent({
    event: 'chat.conversation.opened',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `conversation ${conversation.id} (${sides.participantKind})`,
  });

  return dto.toConversation(conversation, { viewerUserId: caller.id });
}

/**
 * GET /chat/conversations/:id/messages?limit=&before=&after=
 *
 * One page of a thread, newest first, with each message's sender, its derived
 * receiver, both their email addresses, and its attachments.
 *
 * READING DOES NOT MARK ANYTHING READ. That is a separate call the client makes
 * when the messages are actually on screen — a page fetched by a background
 * prefetch, a reconnect catch-up, or a notification preview has not been read by
 * anybody, and stamping it here would clear the badge for messages nobody saw.
 */
async function listMessages({ userId, requestId, conversationId, query }) {
  const { caller, conversation } = await loadConversationForParticipant(userId, conversationId);

  const messages = await repo.listMessages(prisma, {
    conversationId: conversation.id,
    limit: query.limit,
    before: query.before,
    after: query.after,
  });

  const unreadCount = (
    await repo.countUnreadByConversation(prisma, {
      conversationIds: [conversation.id],
      userId: caller.id,
    })
  ).get(conversation.id) ?? 0;

  /*
   * The cursor names the OLDEST row on this page, which is where the next
   * backwards page starts. Null when the page came back short, because that is
   * the only honest signal that there is nothing older — a cursor that returns
   * an empty page costs a round trip per thread the user scrolls to the top of.
   *
   * Deliberately not offered for the `after` direction: catching up ends when
   * the client is level with the live subscription, and the subscription itself
   * is what tells it so.
   */
  const full = messages.length === query.limit;
  const oldest = messages[messages.length - 1];
  const nextCursor = full && oldest ? encodeCursor({ createdAt: oldest.createdAt, id: oldest.id }) : null;

  logEvent({
    event: 'chat.messages.read',
    status: 'success',
    requestId,
    userId,
    companyId: conversation.companyId,
    detail: `conversation ${conversation.id}, ${messages.length} message(s)`,
  });

  return dto.toMessagePage({
    conversation,
    messages,
    viewerUserId: caller.id,
    nextCursor,
    unreadCount,
  });
}

/* -------------------------------------------------------------------------- */
/* sending                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The uploaded objects, measured and turned into attachment rows — or a throw.
 *
 * EVERY FACT IS READ BACK FROM THE BUCKET, never taken from the request: that
 * the object exists, its real size, and its type (from the extension in the key,
 * which came from the allowlist when the ticket was issued). The size the
 * validator checked was a claim; this is the measurement, and it is what makes
 * the cap enforceable rather than advisory.
 *
 * Nothing here writes to the database. It returns rows for the caller's
 * transaction, so a failure at any check below leaves no message and no
 * attachment — only the bucket objects, which are discarded on the way out.
 *
 * THERE IS NO TOTAL-BYTES CAP, unlike the email version, and its absence is
 * deliberate rather than an omission. That cap exists because a mail server
 * refuses a message over ~25 MB once base64 has inflated it; nothing here is
 * handed to a mail server. What bounds a chat message is the per-file cap times
 * the per-request file count, both already applied.
 */
async function measureAttachments({ conversationId, requestId, files }) {
  if (!files.length) return [];

  if (!storage.isRemote()) throw directTransferUnavailable();

  /*
   * A key that is not this thread's own. The signed ticket is spent by now and
   * proves nothing about who holds the key, so this is the check that stops a
   * file uploaded for one conversation being attached to another.
   */
  const foreign = files.filter((file) => !isKeyForConversation(file.key, conversationId));
  if (foreign.length) {
    throw new ApiError(400, 'Those uploads do not belong to this conversation.', {
      code: 'INVALID_UPLOAD_KEY',
      fields: { files: 'Attach only the uploads this conversation issued.' },
      details: { keys: foreign.map((file) => file.key) },
    });
  }

  // `file_key` is UNIQUE. A key already on a message means a retried or replayed
  // request, and inserting it again would break on the index — a 500 for what is
  // really a duplicate submit.
  const already = await repo.findAttachmentsByKeys(prisma, files.map((file) => file.key));
  if (already.length) {
    throw new ApiError(409, 'Those files have already been sent.', {
      code: 'ATTACHMENT_ALREADY_RECORDED',
      details: { attachmentIds: already.map((a) => a.id) },
    });
  }

  const stats = await Promise.all(
    files.map((file) => storage.statObject({ bucket: BUCKET, key: file.key }))
  );

  const missing = files.filter((_, i) => !stats[i]);
  if (missing.length) {
    throw new ApiError(404, 'Some of those uploads did not arrive.', {
      code: 'UPLOAD_NOT_FOUND',
      fields: { files: 'Upload the file before sending.' },
      details: { fileNames: missing.map((file) => toDisplayName(file.fileName)) },
    });
  }

  /*
   * An object that exists and is empty — the PUT reached the bucket and created
   * the object but carried no body: a cancelled upload, a dropped connection, or
   * a client that sent headers and nothing else. `chat_attachments.size_bytes`
   * carries CHECK (size_bytes > 0), which would catch it as a constraint
   * violation inside the insert — a 500 for what is plainly the caller's
   * problem, naming no file. The object is discarded, because zero bytes is not
   * a document and leaving it stored would let the caller retry against a file
   * that can never be accepted.
   */
  const empty = files
    .map((file, i) => ({ file, sizeBytes: stats[i].sizeBytes }))
    .filter((entry) => !(entry.sizeBytes > 0));

  if (empty.length) {
    await discardStoredObjects(empty.map((entry) => entry.file.key), requestId);
    throw new ApiError(400, 'Some of those uploads are empty.', {
      code: 'UPLOAD_EMPTY',
      fields: { files: 'Upload the file again — nothing arrived in it.' },
      details: { fileNames: empty.map((entry) => toDisplayName(entry.file.fileName)) },
    });
  }

  const oversized = files
    .map((file, i) => ({ file, sizeBytes: stats[i].sizeBytes }))
    .filter((entry) => entry.sizeBytes > config.uploads.maxDocumentBytes);

  if (oversized.length) {
    await discardStoredObjects(oversized.map((entry) => entry.file.key), requestId);
    const mb = Math.round(config.uploads.maxDocumentBytes / (1024 * 1024));
    throw new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
      code: 'FILE_TOO_LARGE',
      fields: { files: `Each file must be under ${mb} MB.` },
      details: {
        files: oversized.map((entry) => ({
          fileName: toDisplayName(entry.file.fileName),
          sizeBytes: entry.sizeBytes,
        })),
        maxBytes: config.uploads.maxDocumentBytes,
      },
    });
  }

  return files.map((file, i) => {
    const ext = path.extname(file.key).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[ext];

    // Unreachable through a ticket this API issued — the extension came from the
    // allowlist. Checked anyway, because this is the last point before a type
    // outside it would become a stored row.
    if (!mimeType) {
      throw new ApiError(415, `Only ${ACCEPTED_LABEL} files are accepted.`, {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        details: { fileName: toDisplayName(file.fileName), extension: ext },
      });
    }

    return {
      fileKey: file.key,
      originalName: toDisplayName(file.fileName),
      mimeType,
      // The bucket's measurement, never the client's claim.
      sizeBytes: BigInt(stats[i].sizeBytes),
    };
  });
}

/**
 * POST /chat/conversations/:id/messages — say something.
 *
 * ONE TRANSACTION WRITES THE MESSAGE, ITS ATTACHMENTS AND THE THREAD'S
 * `lastMessageAt`. All three or none: a message without the file it was sent to
 * deliver is worse than no message, and a thread whose preview line disagrees
 * with its newest message is a list that sorts wrongly forever after.
 *
 * THE ORDER MATTERS TOO. `lastMessageAt` is set from the message's own
 * `createdAt` rather than from a second `now()`, so the denormalised column and
 * the row it summarises cannot disagree by the width of the transaction.
 *
 * AND THE LIVE UPDATE IS FREE. Nothing here publishes anything: the insert
 * reaches the replication stream on commit, and Supabase Realtime delivers it to
 * whichever side is watching. That is also why the transaction boundary is where
 * it is — a broadcast from inside it would announce a message a rollback then
 * erased.
 */
async function sendMessage({ userId, requestId, conversationId, body }) {
  const { caller, conversation } = await loadConversationForParticipant(userId, conversationId);

  const attachmentRows = await measureAttachments({
    conversationId: conversation.id,
    requestId,
    files: body.files,
  });

  /*
   * Re-checked after the measurement, not only in the validator. A request whose
   * only file turned out to be missing from the bucket arrives here looking
   * perfectly valid, and would otherwise write a message with no text and no
   * attachment — the one thing `CHECK (body IS NULL OR ...)` cannot express,
   * because it spans two tables.
   */
  if (!body.body && !attachmentRows.length) {
    throw new ApiError(400, 'Type a message or attach a file.', {
      code: 'EMPTY_MESSAGE',
      fields: { body: 'Type a message or attach a file.' },
    });
  }

  let message;
  try {
    message = await prisma.$transaction(async (tx) => {
      const created = await repo.createMessage(tx, {
        conversationId: conversation.id,
        senderUserId: caller.id,
        body: body.body,
        attachments: attachmentRows,
      });

      await repo.touchConversation(tx, {
        conversationId: conversation.id,
        lastMessageAt: created.createdAt,
      });

      return created;
    });
  } catch (err) {
    // Objects with no row are garbage, and nothing else will ever reference
    // these keys — the ticket that produced them is spent.
    await discardStoredObjects(attachmentRows.map((row) => row.fileKey), requestId);
    throw err;
  }

  logEvent({
    event: 'chat.message.sent',
    status: 'success',
    requestId,
    userId,
    companyId: conversation.companyId,
    detail: `conversation ${conversation.id}, ${attachmentRows.length} attachment(s)`,
  });

  return dto.toMessage(message, { conversation, viewerUserId: caller.id });
}

/**
 * POST /chat/conversations/:id/read — clear the badge.
 *
 * Stamps every message in the thread the caller did NOT send and has not already
 * read, up to the id they name (or all of them). Returns the new count rather
 * than nothing, so the client sets its badge from the server's answer instead of
 * assuming zero — the two differ whenever a message lands between the render and
 * this call, which on a live thread is often.
 */
async function markRead({ userId, requestId, conversationId, upToMessageId }) {
  const { caller, conversation } = await loadConversationForParticipant(userId, conversationId);

  const result = await repo.markRead(prisma, {
    conversationId: conversation.id,
    readerUserId: caller.id,
    upToMessageId,
    readAt: new Date(),
  });

  const unreadCount = (
    await repo.countUnreadByConversation(prisma, {
      conversationIds: [conversation.id],
      userId: caller.id,
    })
  ).get(conversation.id) ?? 0;

  logEvent({
    event: 'chat.messages.read_receipt',
    status: 'success',
    requestId,
    userId,
    companyId: conversation.companyId,
    detail: `conversation ${conversation.id}, ${result.count} marked`,
  });

  return { conversationId: conversation.id, markedCount: result.count, unreadCount };
}

/**
 * DELETE /chat/messages/:id — remove one of your own.
 *
 * THE SENDER ONLY, which is narrower than every other write on this feature.
 * Being in a thread makes the conversation yours to read and to add to; it does
 * not make the other person's words yours to remove. An accounting manager is
 * not exempt — they hold the account, not the transcript.
 *
 * The same rule the other three deletes in this API apply — projects, project
 * documents and tasks are each removable by their creator alone. Whoever made a
 * thing is the only person who may unmake it, whichever noun it is, so nobody
 * has to remember which feature has which exception.
 *
 * SOFT FOR THE MESSAGE, HARD FOR THE FILES. The row and its body survive a
 * mis-click and can be brought back by clearing `deleted_at`; the attached
 * objects cannot, because they are deleted from the bucket here. A file sent to
 * the wrong thread is the thing a user is actually trying to take back, and
 * leaving the bytes in storage while hiding the message would make "deleted" a
 * statement about the UI rather than about the data.
 *
 * The attachment ROWS are kept — name, type, size, created_at — with `file_key`
 * nulled. That is the record of what was sent, which the audit needs and which
 * lets the thread render a tombstone; see 23_chat_attachment_file_purge.sql.
 *
 * Idempotent: a double click is a no-op rather than a 404 on the second one, and
 * the purge runs only for the call that actually performed the delete.
 */
async function deleteMessage({ userId, requestId, messageId }) {
  const caller = await loadCaller(userId);

  const message = await repo.findMessageForAccess(prisma, messageId);
  if (!message) throw messageNotFound();

  // The thread first: someone who cannot see the conversation must not learn
  // from a different error code that the message exists.
  assertParticipant(caller, message.conversation);

  if (message.senderUserId !== caller.id) {
    throw new ApiError(403, 'You can only delete your own messages.', {
      code: 'CHAT_MESSAGE_DELETE_FORBIDDEN',
    });
  }

  const result = await repo.softDeleteMessage(prisma, { id: message.id, deletedAt: new Date() });

  /*
   * PURGE THE BYTES — only on the call that won.
   *
   * `count === 0` means the message was already deleted (a second click, a
   * retried request, a concurrent call), so its files are already gone and the
   * work below would be a bucket round-trip for nothing.
   *
   * Order matters: read the keys, remove the objects, THEN null the column.
   * `file_key` is the only record of what to remove, so clearing it first would
   * strand an object that nothing can name again. The reverse leaves an orphan
   * if the process dies mid-way, which costs storage rather than secrecy — and
   * `removeObjects` never throws, so a bucket that is down cannot turn a
   * completed delete into a 500 for the user.
   */
  let purgedCount = 0;
  if (result.count > 0) {
    const attachments = await repo.findAttachmentKeys(prisma, message.id);
    if (attachments.length) {
      await discardStoredObjects(attachments.map((row) => row.fileKey), requestId);
      const cleared = await repo.clearAttachmentKeys(prisma, message.id);
      purgedCount = cleared.count;
    }
  }

  logEvent({
    event: 'chat.message.deleted',
    status: 'success',
    requestId,
    userId,
    companyId: message.conversation.companyId,
    detail: `conversation ${message.conversation.id}, ${purgedCount} file(s) purged`,
  });

  return {
    id: dto.toNumber(message.id),
    conversationId: message.conversationId,
    deleted: true,
    attachmentsPurged: purgedCount,
  };
}

/**
 * GET /chat/unread-count?companyId=
 *
 * The nav badge: everything unread across every thread the caller is in on one
 * company.
 *
 * COUNTED IN THE DATABASE rather than summed from the list endpoints, because
 * the badge is rendered on screens that never load either list — and a badge
 * derived from a list is a badge that lies as soon as the list is paginated.
 */
async function unreadCount({ userId, requestId, query }) {
  const { caller, company } = await loadCompanyForRead(userId, query.companyId);

  const total = await repo.countUnreadForUser(prisma, {
    companyId: company.id,
    userId: caller.id,
  });

  logEvent({
    event: 'chat.unread.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${total} unread`,
  });

  return { companyId: company.id, unreadCount: total };
}

/* -------------------------------------------------------------------------- */
/* attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * POST /chat/attachments/upload-url — permission to write, as links.
 *
 * The browser PUTs each file straight to the bucket. It has to: this API runs on
 * a host that buffers the whole request body and refuses anything past ~4.5 MB,
 * so a file travelling through it could never be larger than that no matter what
 * the config allows.
 *
 * SCOPED TO THE CONVERSATION, not to the sender — which is the one thing this
 * differs in from its email counterpart, and the reason is that a thread already
 * exists when a file is uploaded to it (an email has no id until it is sent). So
 * the key can name the thread, the caller must be one of its two sides to get a
 * ticket, and the send can re-derive the prefix from its own URL to check the
 * key it is given. Scoping to the sender instead would let a file uploaded for
 * one client's thread be attached to another client's.
 *
 * NOTHING IS RECORDED. A ticket that is never used leaves nothing behind; an
 * upload that lands and is never sent leaves an unreferenced object, which is
 * the one piece of litter this design accepts in exchange for the request-size
 * ceiling disappearing.
 */
async function createUploadTickets({ userId, requestId, conversationId, files }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const { conversation } = await loadConversationForParticipant(userId, conversationId);

  const uploads = await Promise.all(
    files.map(async (file) => {
      const key = chatAttachmentKey(conversation.id, file.mimeType);
      const ticket = await storage.signedUploadUrl({ bucket: BUCKET, key });

      if (!ticket) {
        throw new ApiError(502, 'Could not prepare the upload. Try again.', {
          code: 'STORAGE_TICKET_FAILED',
          details: { fileName: file.fileName },
        });
      }

      return {
        fileName: toDisplayName(file.fileName),
        key,
        uploadUrl: ticket.url,
        token: ticket.token,
      };
    })
  );

  logEvent({
    event: 'chat.attachment.upload_ticket.issued',
    status: 'success',
    requestId,
    userId,
    companyId: conversation.companyId,
    detail: `conversation ${conversation.id}, ${uploads.length} ticket(s)`,
  });

  return { conversationId: conversation.id, uploads };
}

/**
 * GET /chat/attachments/:id/download-url — the bytes, as a link.
 *
 * A LINK AND NOT THE FILE, for the same reason the upload is a link: this host
 * buffers a response before sending it and refuses anything past a few
 * megabytes, so streaming the bytes through here would cap every download far
 * below what the upload allows. A signed URL points the browser straight at the
 * bucket and the file's size stops being this API's concern.
 *
 * The link expires in about a minute (config.storage.signedUrlTtlSeconds),
 * because the link IS the authorization once it exists: anyone holding it can
 * fetch the object without a token, so its lifetime is the window in which a
 * leaked URL is still worth something. That is far longer than the redirect it
 * exists for and far too short to be worth passing around.
 *
 * IMAGES ARE NOT SPECIAL-CASED. An inline preview asks for the same link — a
 * client's bank statement and a photograph of it are the same secret, and a
 * public URL for one of them would be a public URL for the other.
 *
 * The audit line is written HERE rather than after the transfer, because this is
 * the moment access was granted; the fetch happens against Supabase and this API
 * never sees it. What is recorded is what actually happened: at this instant,
 * this user was granted this file.
 */
async function createDownloadLink({ userId, requestId, attachmentId }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const caller = await loadCaller(userId);

  const attachment = await repo.findAttachmentForDownload(prisma, attachmentId);
  if (!attachment) throw attachmentNotFound();

  // The thread first, exactly as in deleteMessage: a caller who cannot see the
  // conversation must not learn from a different error that the file exists.
  assertParticipant(caller, attachment.message.conversation);

  // A deleted message's files are not reachable. Recoverability is for whoever
  // restores the message, not for a link that outlives it.
  if (attachment.message.deletedAt) throw attachmentNotFound();

  // The same row after the purge: metadata kept, key nulled, bytes gone. This is
  // unreachable while the check above stands — it is here because the two facts
  // are now stored separately, and only this one is about the file existing.
  if (!attachment.fileKey) throw attachmentNotFound();

  const url = await storage.signedUrl({
    bucket: BUCKET,
    key: attachment.fileKey,
    expiresIn: config.storage.signedUrlTtlSeconds,
    download: attachment.originalName,
  });

  if (!url) {
    // `signedUrl` declines to sign a key that is not in the bucket, so this is
    // also where a row whose object is missing lands — commonly a row written
    // under one storage driver being read under another.
    logger.error(
      `[${requestId}] Chat attachment ${attachment.id} has no stored object at ${attachment.fileKey}`
    );
    throw attachmentNotFound();
  }

  logEvent({
    event: 'chat.attachment.downloaded',
    status: 'success',
    requestId,
    userId,
    companyId: attachment.message.conversation.companyId,
    detail: `attachment ${attachment.id}`,
  });

  return {
    url,
    expiresInSeconds: config.storage.signedUrlTtlSeconds,
    fileName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: dto.toNumber(attachment.sizeBytes),
  };
}

module.exports = {
  listCustomerContacts,
  listSpecialistContacts,
  listConversations,
  openConversation,
  listMessages,
  sendMessage,
  markRead,
  deleteMessage,
  unreadCount,
  createUploadTickets,
  createDownloadLink,
};
