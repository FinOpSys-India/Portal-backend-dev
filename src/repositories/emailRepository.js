'use strict';

const { STANDING_SPECIALIST_COLUMNS } = require('./companyRepository');

/**
 * Data access for the compose-and-send email screen, and for the recipient
 * picker that feeds it.
 *
 * Same conventions as the other repositories here: the Prisma client is the
 * first argument (`prisma` for a standalone read, `tx` inside a transaction),
 * and every filter that must never be forgotten lives in this file rather than
 * in the service.
 *
 * WHAT IS AND IS NOT STORED. A message row holds the From (as a user id), the
 * Subject, the Body, and what became of the send. It does NOT hold the sender's
 * or the recipients' email addresses — `users` already holds those, and a second
 * copy could disagree with the first. Every read below therefore joins the
 * person rather than reading a denormalised column. Attachment BYTES are not
 * here either: the row holds a `file_key` and the bytes live in the private
 * documents bucket, exactly as project documents do.
 */

const CUSTOMER_ROLE_CODE = 'CUSTOMER';
const SPECIALIST_ROLE_CODE = 'SPECIALIST';
const ACCOUNTING_MANAGER_ROLE_CODE = 'ACCOUNTING_MANAGER';

/**
 * The columns a person needs to appear in the picker, on a From line, or on a
 * recipient chip — and nothing else.
 *
 * The same allowlist the other directories use: enough to put a name, an
 * address, and a role beside the row; no password hash, no login-security
 * column, no address. `email` IS here, unlike most person selects in this API,
 * because an address is the entire point of a recipient picker.
 */
const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  jobTitle: true,
  avatarKey: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true, name: true } },
};

/* -------------------------------------------------------------------------- */
/* the recipient picker                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everyone on the CUSTOMER side of one company: the owner AND the teammates, in
 * one list.
 *
 * THE `OR` IS THE WHOLE POINT. The two groups reach a company through different
 * links — the owner through `companies.owner_user_id`, a teammate through a row
 * in `company_members` — and no existing endpoint returns both: GET /customers
 * resolves ownership only, GET /teammates resolves membership only. A screen
 * that needs "everyone I can write to on this account" would otherwise have to
 * call both and merge them, and would then have to dedupe, because an owner who
 * is ALSO listed in company_members appears in both answers. One `OR` lets
 * Postgres do that in a single pass and hand back each person once.
 *
 * `deletedAt: null` on the owned company matters: without it, the owner of a
 * soft-deleted company would still be addressable through it.
 *
 * ACTIVE only, and deliberately with no `includeInactive` escape hatch. A
 * hibernated account is a mailbox nobody is reading; offering it in a picker
 * invites a message that silently goes nowhere. This is the one directory in the
 * API where showing an inactive person is worse than hiding them.
 */
function listCompanyCustomers(client, { companyId }) {
  return client.user.findMany({
    where: {
      role: { code: CUSTOMER_ROLE_CODE },
      status: 'ACTIVE',
      OR: [
        { ownedCompanies: { some: { id: companyId, deletedAt: null } } },
        { companyMemberships: { some: { companyId } } },
      ],
    },
    select: PERSON_SELECT,
    orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The same list, narrowed by a typed search.
 *
 * A SEPARATE FUNCTION rather than an optional clause on the one above, because
 * Prisma's `where` is an object and the association filter already occupies the
 * `OR` key. Nesting both under a single `AND` is expressible, and that is
 * exactly what this does — but doing it conditionally inside one builder
 * produced a shape where a mistyped key silently dropped the company filter and
 * returned every customer in the database. Two explicit functions cannot fail
 * that way.
 */
function searchCompanyCustomers(client, { companyId, search }) {
  return client.user.findMany({
    where: {
      role: { code: CUSTOMER_ROLE_CODE },
      status: 'ACTIVE',
      AND: [
        {
          OR: [
            { ownedCompanies: { some: { id: companyId, deletedAt: null } } },
            { companyMemberships: { some: { companyId } } },
          ],
        },
        {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
        },
      ],
    },
    select: PERSON_SELECT,
    orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The accounting manager on one company.
 *
 * AT MOST ONE PERSON, and that is the schema speaking rather than a limit chosen
 * here: `companies.accounting_manager_user_id` is a single nullable column, so a
 * company has exactly one manager or none. It is still returned as a LIST by the
 * endpoint above this — the picker renders three groups the same way, and a
 * caller that had to special-case one of them as an object would break the day a
 * second manager column appeared.
 *
 * Read in one query through the relation rather than as a column plus a second
 * lookup: two round trips to a managed Postgres cost more than the join, and
 * between them the manager could change.
 *
 * The role predicate on the joined user is the same guard the specialist read
 * uses — an id that reached the column while belonging to a non-manager account
 * comes back as nobody, not as a person the picker then offers.
 */
async function findCompanyAccountingManager(client, companyId) {
  const company = await client.company.findFirst({
    where: { id: companyId, deletedAt: null },
    select: {
      id: true,
      companyName: true,
      accountingManager: { select: PERSON_SELECT },
    },
  });

  if (!company) return { company: null, manager: null };

  const manager = company.accountingManager;
  const usable =
    manager && manager.status === 'ACTIVE' && manager.role?.code === ACCOUNTING_MANAGER_ROLE_CODE
      ? manager
      : null;

  return { company, manager: usable };
}

/**
 * The company columns naming its standing specialists, plus its live specialist
 * assignments — the two places a specialist is attached to a company.
 *
 * BOTH ARE READ, and the difference between them is why. The three columns
 * (`bookkeeping_specialist_user_id`, `payroll_…`, `tax_…`) answer "who is THE
 * specialist for this line right now" and are what the admin grid renders. The
 * assignment table is the record of specialist WORK — many rows, with history,
 * and the only place an FA_Q specialist can appear at all, since that line has
 * no column. A picker built on the columns alone silently cannot address an FA_Q
 * specialist; one built on assignments alone misses a standing specialist who
 * was set on the company without an assignment row ever being written. Reading
 * both and merging is the only answer that is complete.
 *
 * Returns the raw halves; `emailMessageService` folds them into one person per
 * user with their specializations collected. That fold is in the service because
 * it is a presentation decision, not a storage one.
 */
async function listCompanySpecialistSources(client, companyId) {
  const company = await client.company.findFirst({
    where: { id: companyId, deletedAt: null },
    select: {
      id: true,
      companyName: true,
      ...Object.fromEntries(STANDING_SPECIALIST_COLUMNS.map((entry) => [entry.column, true])),
    },
  });

  if (!company) return { company: null, standing: [], assignments: [] };

  // [{ specializationCode: 'BOOKKEEPING', userId: 12 }, …] — the columns that
  // are actually filled. A null column is an unstaffed line, which is a truthful
  // state and simply contributes nobody.
  const standing = STANDING_SPECIALIST_COLUMNS.map((entry) => ({
    specializationCode: entry.specializationCode,
    userId: company[entry.column],
  })).filter((entry) => entry.userId);

  const assignments = await client.companySpecialistAssignment.findMany({
    where: { companyId, assignmentStatus: 'ACTIVE' },
    select: {
      specialistUserId: true,
      specialization: { select: { specializationCode: true, specializationName: true } },
    },
  });

  return { company, standing, assignments };
}

/**
 * The people behind a set of specialist ids.
 *
 * The role predicate is part of the LOOKUP rather than a check afterwards, the
 * same way findSpecialistProfile does it: an id that reached the columns or the
 * assignment table while belonging to a non-specialist account comes back as
 * nothing, not as a person the picker then offers.
 */
function findSpecialistsByIds(client, ids, { search } = {}) {
  if (!ids.length) return Promise.resolve([]);
  return client.user.findMany({
    where: {
      id: { in: ids },
      role: { code: SPECIALIST_ROLE_CODE },
      status: 'ACTIVE',
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: PERSON_SELECT,
    orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
  });
}

/* -------------------------------------------------------------------------- */
/* messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A message in the shape every read returns it.
 *
 * `sender` and `recipients.user` are joined rather than stored flat for the
 * reason given at the top of this file. `attachments` deliberately omits
 * `fileKey` — it is an internal storage path, the client has no use for it, and
 * shipping it would invite a frontend to build its own bucket URL, which is the
 * one thing that must not work for a private bucket.
 */
const MESSAGE_SELECT = {
  id: true,
  companyId: true,
  subject: true,
  bodyHtml: true,
  status: true,
  errorMessage: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  sender: { select: PERSON_SELECT },
  company: { select: { id: true, companyName: true } },
  recipients: {
    select: { recipientType: true, user: { select: PERSON_SELECT } },
    orderBy: { userId: 'asc' },
  },
  attachments: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
    orderBy: { id: 'asc' },
  },
};

/** Everything the authorization step reads, and none of the joins. */
const MESSAGE_ACCESS_SELECT = {
  id: true,
  companyId: true,
  senderUserId: true,
  subject: true,
  bodyHtml: true,
  status: true,
};

/** One message in full. */
function findMessageById(client, id) {
  return client.emailMessage.findUnique({ where: { id }, select: MESSAGE_SELECT });
}

/** The draft plus everything the transport needs to actually send it. */
function findMessageForSend(client, id) {
  return client.emailMessage.findUnique({
    where: { id },
    select: {
      ...MESSAGE_ACCESS_SELECT,
      sender: { select: PERSON_SELECT },
      recipients: { select: { recipientType: true, user: { select: PERSON_SELECT } } },
      // fileKey IS selected here, unlike MESSAGE_SELECT — this is the one code
      // path that needs the bytes, because it has to fetch and attach them.
      attachments: {
        select: { id: true, fileKey: true, originalName: true, mimeType: true, sizeBytes: true },
        orderBy: { id: 'asc' },
      },
    },
  });
}

/**
 * Create the message and its recipient rows in one statement each.
 *
 * The ONLY insert on this table. There is no draft, so a message is created once,
 * complete, inside the transaction that also writes its attachments — see
 * emailMessageService.composeAndSend. Nothing updates `subject`, `body_html` or
 * the recipient rows afterwards, which is why no `updateMessage` or
 * `replaceRecipients` exists here: the only writes after the insert are `markSent`
 * and `markFailed`, and both touch status columns only.
 */
function createMessage(client, { data, recipients }) {
  return client.emailMessage.create({
    data: {
      ...data,
      // A nested createMany is one INSERT for all recipients rather than one per
      // person — the dominant cost against a managed Postgres is latency, not
      // the insert itself.
      recipients: { createMany: { data: recipients } },
    },
    select: { id: true },
  });
}

/**
 * Mark a send that succeeded.
 *
 * `sentAt` and `status` are written together and never apart: the database
 * CHECK (`(status = 'SENT') = (sent_at IS NOT NULL)`) rejects either one alone,
 * which is what stops a half-applied update from producing a message that claims
 * to be sent at no particular time. `errorMessage` is cleared, because a retry
 * that succeeded must not leave the previous failure's reason on the row.
 */
function markSent(client, id, sentAt) {
  return client.emailMessage.update({
    where: { id },
    data: { status: 'SENT', sentAt, errorMessage: null },
    select: { id: true },
  });
}

/** Mark a send that the transport refused, with its reason. */
function markFailed(client, id, errorMessage) {
  return client.emailMessage.update({
    where: { id },
    data: { status: 'FAILED', sentAt: null, errorMessage },
    select: { id: true },
  });
}

/*
 * THERE IS NO DELETE, hard or soft, on any table in this file — and no
 * `deleted_at` column to enable one.
 *
 * That is the design. Every row here is a message that was handed to SMTP: SENT
 * means it reached somebody, FAILED means it did not and can be retried. Neither
 * is scratch work. The delete that used to live here removed an abandoned DRAFT,
 * and with the compose-and-send endpoint there are no drafts to abandon.
 */

/* -------------------------------------------------------------------------- */
/* attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rows already pointing at any of these storage keys — the guard against one
 * uploaded object becoming two attachments.
 *
 * `file_key` is UNIQUE, so this is not the constraint; it is the difference
 * between a 409 that names the problem and a 500 from the index. It is needed
 * because the browser uploads straight to the bucket, which leaves the caller
 * holding a key that an ordinary retried, replayed or double-clicked
 * `POST /emails` would submit twice.
 */
function findAttachmentsByKeys(client, keys) {
  return client.emailAttachment.findMany({
    where: { fileKey: { in: keys } },
    select: { id: true, fileKey: true },
  });
}

/**
 * The attachment rows for one message, inserted inside the caller's transaction
 * alongside the message itself.
 *
 * There is no read-back and no update or delete counterpart. An attachment is
 * written once, with the message it belongs to, and after that it is only ever
 * read — through MESSAGE_SELECT for the screen, or findMessageForSend for the
 * bytes. Removing a file before sending happens in the browser, before any of
 * this runs.
 */
function createAttachments(client, rows) {
  return client.emailAttachment.createManyAndReturn({ data: rows, select: { id: true } });
}

module.exports = {
  PERSON_SELECT,
  MESSAGE_SELECT,
  listCompanyCustomers,
  searchCompanyCustomers,
  findCompanyAccountingManager,
  listCompanySpecialistSources,
  findSpecialistsByIds,
  findMessageById,
  findMessageForSend,
  createMessage,
  markSent,
  markFailed,
  findAttachmentsByKeys,
  createAttachments,
};
