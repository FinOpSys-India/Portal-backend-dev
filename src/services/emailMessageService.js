'use strict';

const path = require('path');

const config = require('../config');
const { prisma } = require('../config/prisma');
const repo = require('../repositories/emailRepository');
const projectService = require('./projectService');
const transport = require('./emailService');
const dto = require('../dto/emailDto');
const storage = require('../utils/storage');
const { emailAttachmentKey, EXTENSION_BY_MIME, ACCEPTED_LABEL } = require('../utils/documentTypes');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');

/**
 * The compose-and-send email screen.
 *
 * NAMED `emailMessageService`, NOT `emailService`. That name is taken by the
 * nodemailer transport this file calls into, and the two are deliberately
 * separate: the transport knows how to hand a message to SMTP and nothing about
 * who may send one, while this file decides everything about access, scope and
 * state and nothing about SMTP. It is required here as `transport` to keep that
 * boundary visible at every call site.
 *
 * THERE IS NO DRAFT. One Send button, and the row is created and handed to SMTP
 * in the same request:
 *
 *   POST /emails/attachments/upload-url   signed tickets     (only if files)
 *      ... the browser PUTs each file straight to the bucket ...
 *   POST /emails                          create AND send
 *
 * With no files that is ONE call. Nothing half-written is ever stored: a row
 * exists only once the send has been attempted, so it is SENT or FAILED and never
 * a message sitting in the database that nobody decided about.
 *
 * WHY THE UPLOAD IS STILL SEPARATE, when the send is not. A file larger than the
 * host's request ceiling cannot be uploaded through this API at all — the browser
 * has to write to the bucket itself, and it needs a signed URL to do it. That is
 * the same constraint project documents face and the same solution; see
 * projectDocumentService.createUploadTickets for the full reasoning.
 *
 * The consequence of dropping the draft is that an attachment's key can no longer
 * be scoped by a message id, because no id exists when the file is uploaded. It
 * is scoped by the SENDER instead — `emails/outbox/<userId>/<random><ext>` — and
 * `POST /emails` proves each key belongs to the authenticated caller before
 * attaching it. See isKeyForSender.
 *
 * THE ROWS ARE WRITE-ONLY. Every send records what went out, to whom, and whether
 * the transport accepted it — but nothing in this API reads that back. There is no
 * outbox, no message detail and no retry; those endpoints existed and were removed
 * as unused. The RECORDING stayed, because a message that reached a client is
 * worth having in the database whether or not a screen asks for it today, and
 * because a FAILED row carrying the SMTP error is what makes a failed send
 * diagnosable at all.
 *
 * So `SENT` and `FAILED` are terminal here. `DRAFT` survives only as the column's
 * default during the few milliseconds between the INSERT and the send inside one
 * request; no endpoint can leave a row in it.
 */

/* -------------------------------------------------------------------------- */
/* roles                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Who may ask WHO THE ACCOUNTING MANAGER IS — the only role restriction on this
 * feature, and it applies to one endpoint.
 *
 * These are the two groups that actually write to a manager. Everyone else on a
 * company is either the manager themselves (for whom the list is a mirror of one
 * row) or an admin, who is already excluded from every endpoint here by the
 * company-scope rule.
 *
 * The customer and specialist lists carry NO such restriction, deliberately: a
 * manager needs to write to the client and to the staff on the account, so the
 * groups they can look up are exactly the ones this set excludes them from being
 * shown. The asymmetry is the point.
 */
const ADDRESSER_ROLES = new Set(['CUSTOMER', 'SPECIALIST']);

/** Refused for WHO the caller is, not for which company they asked about. */
function accountingManagerListForbidden() {
  return new ApiError(403, 'Only a customer or a specialist can look up the accounting manager.', {
    code: 'ACCOUNTING_MANAGER_LIST_FORBIDDEN',
  });
}

/* -------------------------------------------------------------------------- */
/* the stored objects                                                         */
/* -------------------------------------------------------------------------- */

const BUCKET = config.storage.documentsBucket;

/**
 * The ceiling on everything ONE MESSAGE carries, across all its attachments.
 *
 * Separate from, and stricter than, the per-file cap: a per-file limit alone
 * would let ten legal files assemble into a message no mail server will accept.
 *
 * 20 MB rather than the 25 MB most providers quote, because base64 encoding
 * inflates the MIME parts by roughly a third — 20 MB of files becomes about
 * 27 MB on the wire, which is already at the limit. A message accepted here and
 * refused by the SMTP host would be recorded FAILED for a reason the user could
 * do nothing about from the screen, so this is the check that has to bite.
 */
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Never throws — storage.removeObjects swallows and logs. */
function discardStoredObjects(keys, requestId) {
  if (!keys.length) return Promise.resolve();
  return storage.removeObjects({ bucket: BUCKET, keys, requestId });
}

// `email_attachments.original_name` is VARCHAR(255).
const MAX_NAME_LENGTH = 255;

/**
 * The uploader's own name for the file, made safe to store and to echo back.
 *
 * Identical rules to projectDocumentService.toDisplayName, and for identical
 * reasons: directory parts dropped (a drag-and-drop can send "C:\Users\me\x.pdf"),
 * control characters stripped (this string is echoed into JSON, into a
 * Content-Disposition header, into an audit log, and into a MIME part header —
 * a raw newline in any of those is header injection), and capped at the column
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
 * A key is only acceptable if it is one WE could have issued, TO THIS SENDER.
 *
 * `emails/outbox/<senderUserId>/<32 hex><ext>` is exactly what
 * `emailAttachmentKey` produces. The id is interpolated from the authenticated
 * token, never from the request, which is what stops one caller from attaching an
 * object another caller uploaded — the one thing a signed ticket alone would not
 * prevent, since the ticket is spent by the time `POST /emails` runs and nothing
 * in the key itself says who asked for it.
 *
 * This check replaced an identical one against a message id. That version could
 * only work while a draft existed to be checked against; the sender is the piece
 * of identity that IS available at both ends of a one-call send.
 */
function isKeyForSender(key, senderUserId) {
  return new RegExp(`^emails/outbox/${senderUserId}/[0-9a-f]{32}(\\.[a-z0-9]+)?$`).test(key);
}

/** See projectDocumentService.directTransferUnavailable — same misconfiguration. */
function directTransferUnavailable() {
  logger.error(
    'Attachment storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required ' +
      `for uploads, and the active driver is "${config.storage.driver}".`
  );

  return new ApiError(503, 'Attachment storage is not available right now.', {
    code: 'DIRECT_TRANSFER_UNAVAILABLE',
    details: { driver: config.storage.driver },
  });
}

/* -------------------------------------------------------------------------- */
/* access                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read access to a company is the gate on everything in this file.
 *
 * Reused from projectService rather than re-implemented, so "who may reach this
 * company" is decided in exactly one place across projects, documents, tasks and
 * now email. The rule it applies: the company's owner, an ADMIN, the company's
 * accounting manager, or a specialist actively assigned to it.
 *
 * That is deliberately the SAME rule for reading the message list and for
 * sending. A narrower send rule was considered and rejected: everyone on that
 * list already exchanges mail with the client through the portal's other
 * features, and a permission that let someone read every message on an account
 * but not write one would be a distinction the screen cannot explain.
 */
function loadCompanyForRead(userId, companyId) {
  return projectService.loadCompanyForRead(prisma, { userId, companyId });
}

/* -------------------------------------------------------------------------- */
/* the recipient picker                                                       */
/* -------------------------------------------------------------------------- */

/** "Owner" / "Team" — what a CUSTOMER user is on the account. */
function customerRoleLabel(person) {
  if (person.specificRole?.code === 'OWNER') return 'Owner';
  if (person.specificRole?.code === 'TEAM') return 'Team';
  return person.specificRole?.name ?? 'Customer';
}

/**
 * GET /emails/recipients/customers?companyId=&search=
 *
 * The customer side of one company: its OWNER **and** its TEAMMATES, in one
 * list.
 *
 * That merge is the reason this endpoint exists. The two groups reach a company
 * through different links — the owner through `companies.owner_user_id`, a
 * teammate through a row in `company_members` — and no endpoint returned both:
 * GET /customers resolves ownership only, GET /teammates resolves membership
 * only. A caller needing "everyone on the customer side" had to call both and
 * merge them, and then dedupe, because an owner who ALSO holds a company_members
 * row appears in both answers. `repo.listCompanyCustomers` does that in one
 * query and hands back each person once.
 *
 * SCOPE, NOT A ROLE GATE, matching /documents and /teammates: any authenticated
 * caller may ask, and `loadCompanyForRead` decides against the database whether
 * they may read THAT company. `companyId` is required with no admin exemption —
 * a merged list across companies would put two clients' contacts in one
 * dropdown, which is how a message reaches the wrong account.
 */
async function listCustomerRecipients({ userId, requestId, query }) {
  const { company } = await loadCompanyForRead(userId, query.companyId);
  const { search } = query;

  const rows = search
    ? await repo.searchCompanyCustomers(prisma, { companyId: company.id, search })
    : await repo.listCompanyCustomers(prisma, { companyId: company.id });

  const customers = rows.map((person) =>
    dto.toRecipientOption(
      { ...person, companyId: company.id, companyName: company.companyName },
      { group: 'CUSTOMER', roleLabel: customerRoleLabel(person) }
    )
  );

  logEvent({
    event: 'email.recipients.customers.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${customers.length} customer(s)`,
  });

  return dto.toCustomerRecipientList({ company, customers });
}

/**
 * GET /emails/recipients/specialists?companyId=&search=
 *
 * The specialists on one company — all three service lines: bookkeeping,
 * payroll and tax.
 *
 * TWO SOURCES ARE READ AND MERGED, because neither is complete on its own. The
 * three standing columns on `companies` answer "who is THE specialist for this
 * line right now" but cannot express an FA_Q specialist, since that line has no
 * column. The assignment table records specialist WORK and is the only place
 * FA_Q can appear, but it can be empty for a standing specialist who was set
 * directly on the company. A picker built on either alone silently cannot
 * address somebody who is genuinely on the account.
 *
 * A specialist present in BOTH is one row here, with their specializations
 * collected onto it — see the Map below, which is what does the deduplication.
 *
 * Same scope rule as the customer list above.
 */
async function listSpecialistRecipients({ userId, requestId, query }) {
  const { company } = await loadCompanyForRead(userId, query.companyId);
  const { search } = query;

  const sources = await repo.listCompanySpecialistSources(prisma, company.id);

  /*
   * Fold the two sources into one entry per person.
   *
   * A Map keyed on user id IS the deduplication: a bookkeeping specialist who is
   * also named on an active TAX assignment is one row covering two lines, not
   * two rows. The codes are collected in encounter order — standing columns
   * first, since those are the "current" staffing the admin grid renders.
   */
  const specializationsByUser = new Map();
  const add = (specialistId, code) => {
    if (!specializationsByUser.has(specialistId)) specializationsByUser.set(specialistId, new Set());
    if (code) specializationsByUser.get(specialistId).add(code);
  };

  for (const entry of sources.standing) add(entry.userId, entry.specializationCode);
  for (const row of sources.assignments) add(row.specialistUserId, row.specialization?.specializationCode);

  const rows = await repo.findSpecialistsByIds(prisma, [...specializationsByUser.keys()], { search });

  const specialists = rows.map((person) => {
    const codes = [...(specializationsByUser.get(person.id) ?? [])];
    return dto.toRecipientOption(
      { ...person, companyId: company.id, companyName: company.companyName },
      {
        group: 'SPECIALIST',
        // The lines they cover on THIS company, not their job title.
        // "BOOKKEEPING, TAX" is what tells one specialist from another in a
        // picker; the specific_role name ("Tax Specialist") describes the person
        // globally and can disagree with what they actually do on this account.
        roleLabel: codes.length ? codes.join(', ') : 'Specialist',
        specializations: codes,
      }
    );
  });

  logEvent({
    event: 'email.recipients.specialists.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${specialists.length} specialist(s)`,
  });

  return dto.toSpecialistRecipientList({ company, specialists });
}

/**
 * GET /emails/recipients/accounting-managers?companyId=&search=
 *
 * The accounting manager on one company — the third group in the picker.
 *
 * A LIST OF AT MOST ONE, and the shape is deliberate.
 * `companies.accounting_manager_user_id` is a single nullable column, so the
 * answer is one person or nobody. Returning an array anyway keeps all three
 * recipient endpoints identical from a client's side: same envelope, same row
 * shape, same empty-list-when-nobody behaviour. An endpoint that returned a bare
 * object here would make the picker special-case one of its three sections, and
 * would break outright the day a company gains a second manager column.
 *
 * NOBODY IS NOT AN ERROR. An unstaffed account returns `[]` and a `total` of 0,
 * exactly as the specialist list does for an unstaffed service line — a 404
 * would say the company does not exist, which is a different and untrue thing.
 *
 * `search` is applied HERE rather than in the query, and that is the one place
 * this endpoint differs from its siblings: with a maximum of one candidate there
 * is nothing for the database to narrow, so filtering in the query would be a
 * WHERE clause that can only ever remove the single row already fetched. Same
 * fields as the other two — name and email, case-insensitive — so the behaviour
 * a client sees is identical.
 *
 * Same scope rule as the other two: `loadCompanyForRead` decides against the
 * database whether this caller may read that company.
 */
async function listAccountingManagerRecipients({ userId, requestId, query }) {
  const { caller, company } = await loadCompanyForRead(userId, query.companyId);

  /*
   * The role check, decided against the DATABASE rather than the token.
   *
   * `requireRole('CUSTOMER', 'SPECIALIST')` on the route is the coarse filter and
   * turns away the obvious cases first; this is the authoritative one, and it is
   * here for the reason stated at the top of requireRole itself — a claim is a
   * snapshot from when the token was signed, and this application promotes users
   * mid-session. `caller` was loaded from `users` by loadCompanyForRead, so it is
   * the current truth.
   *
   * An accounting manager is refused their OWN company's list on purpose: the
   * only entry would be themselves, and "email the accounting manager" is not a
   * thing the accounting manager does.
   */
  if (!ADDRESSER_ROLES.has(caller.role?.code)) throw accountingManagerListForbidden();

  const { search } = query;

  const { manager } = await repo.findCompanyAccountingManager(prisma, company.id);

  const matches =
    manager &&
    (!search ||
      [manager.firstName, manager.lastName, manager.email]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(search.toLowerCase())));

  const accountingManagers = matches
    ? [
        dto.toRecipientOption(
          { ...manager, companyId: company.id, companyName: company.companyName },
          {
            group: 'ACCOUNTING_MANAGER',
            // Their standing on THIS account, not their job title. Every person in
            // this list holds the same role, so the label says what they are TO the
            // company rather than repeating "Accounting Manager" as though it
            // distinguished them from anyone.
            roleLabel: 'Accounting Manager',
          }
        ),
      ]
    : [];

  logEvent({
    event: 'email.recipients.accounting_managers.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${accountingManagers.length} accounting manager(s)`,
  });

  return dto.toAccountingManagerRecipientList({ company, accountingManagers });
}

/* -------------------------------------------------------------------------- */
/* drafts                                                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* who may be put on which header                                             */
/* -------------------------------------------------------------------------- */

/**
 * The recipient groups each role may put on the TO header, keyed by the SENDER's
 * role code.
 *
 * This is the table the three picker endpoints already express, restated on the
 * write path because a picker is a suggestion and this is the enforcement: the
 * ids arrive from the client, and nothing in the request proves they came from
 * the list that was rendered.
 *
 *   CUSTOMER, SPECIALIST   all three groups, which is exactly what they can look
 *                          up — the accounting manager included, since
 *                          `requireRole('CUSTOMER','SPECIALIST')` on
 *                          GET /recipients/accounting-managers is what lets them
 *                          ask who that is.
 *   ACCOUNTING_MANAGER     the client and the staff on the account, and NOT the
 *                          ACCOUNTING_MANAGER group — the mirror of being refused
 *                          that picker. On a one-manager company the only entry
 *                          would be themselves.
 *
 * ADMIN IS ABSENT, AND ABSENT MEANS REFUSED. An admin is already turned away from
 * every endpoint here by the company-scope rule in loadCompanyForRead, so this
 * line is unreachable today. It is written as a refusal rather than left out so
 * that widening the scope rule later cannot silently widen this one with it.
 */
const ADDRESSABLE_GROUPS = {
  CUSTOMER: new Set(['CUSTOMER', 'SPECIALIST', 'ACCOUNTING_MANAGER']),
  SPECIALIST: new Set(['CUSTOMER', 'SPECIALIST', 'ACCOUNTING_MANAGER']),
  ACCOUNTING_MANAGER: new Set(['CUSTOMER', 'SPECIALIST']),
};

/** What each group is called on screen, for the error the user actually reads. */
const GROUP_LABEL = {
  CUSTOMER: 'customers',
  SPECIALIST: 'specialists',
  ACCOUNTING_MANAGER: 'the accounting manager',
};

/** The request field a recipient row came from. */
const FIELD_BY_TYPE = { TO: 'to', CC: 'cc', BCC: 'bcc' };

/**
 * Everyone on the company, and WHICH GROUP each of them is in.
 *
 * The same three queries the pickers run, folded into one map instead of one
 * flat set of ids. The group is the part that used to be thrown away here, and
 * it is the part the TO rule is decided on.
 *
 * A Set per person rather than a single group, because the sources are not
 * provably disjoint: nothing in the schema stops the id on
 * `companies.accounting_manager_user_id` from also appearing in the customer
 * roster. Collapsing such a person to one group would silently pick which of
 * their two capacities counts; holding both lets the TO rule accept them in
 * either.
 */
async function loadAddressBook(companyId) {
  const sources = await repo.listCompanySpecialistSources(prisma, companyId);
  const [customers, specialists, { manager }] = await Promise.all([
    repo.listCompanyCustomers(prisma, { companyId }),
    repo.findSpecialistsByIds(prisma, [
      ...new Set([
        ...sources.standing.map((s) => s.userId),
        ...sources.assignments.map((a) => a.specialistUserId),
      ]),
    ]),
    repo.findCompanyAccountingManager(prisma, companyId),
  ]);

  const groupsByUser = new Map();
  const add = (person, group) => {
    if (!person) return;
    if (!groupsByUser.has(person.id)) groupsByUser.set(person.id, new Set());
    groupsByUser.get(person.id).add(group);
  };

  for (const person of customers) add(person, 'CUSTOMER');
  for (const person of specialists) add(person, 'SPECIALIST');
  add(manager, 'ACCOUNTING_MANAGER');

  return groupsByUser;
}

/** Whichever headers are at fault, as the `fields` map the client renders. */
function fieldsForRows(rows, message) {
  const fields = {};
  for (const row of rows) fields[FIELD_BY_TYPE[row.recipientType]] = message;
  return fields;
}

/**
 * Turn the three recipient id lists into rows, refusing anyone not addressable.
 *
 * EVERY ID IS RE-RESOLVED AGAINST THE PICKER, never trusted from the request.
 * The client sends user ids; without this check a caller with legitimate access
 * to company 5 could address the message to any user id in the database — the
 * company scope would be satisfied by the message, and the recipient would not
 * be scoped by anything at all. The addressable set is recomputed here and the
 * request is intersected with it.
 *
 * FOUR RULES, AND THEY ARE NOT THE SAME ON EVERY HEADER:
 *
 *   1. ON THE COMPANY — every id on TO, CC or BCC must be someone this company
 *      actually has: its owner or a teammate, a specialist staffed on it, or its
 *      accounting manager. This is the security rule and it applies everywhere.
 *
 *   2. NOT THE SENDER ON TO — the composer cannot address the message to
 *      themselves. They are in their own company's picker (the owner IS a
 *      customer on it), so nothing else here would have caught it.
 *
 *   3. TO IS ONE GROUP — every id on TO must come from a SINGLE picker list.
 *      Compose is three screens, not one: the customer page addresses customers,
 *      the specialist page addresses specialists, and writing to the accounting
 *      manager addresses the manager. A TO carrying a teammate and a bookkeeper
 *      together is a message no page can have produced, so it is refused rather
 *      than half-honoured.
 *
 *   4. TO IS A GROUP THE SENDER MAY ADDRESS — see ADDRESSABLE_GROUPS. This is
 *      what stops an accounting manager putting a manager on TO: that group is
 *      not one they may write to, which is the write-side half of being refused
 *      that picker.
 *
 * CC AND BCC CARRY RULE 1 ONLY — anyone on the company may be copied, whichever
 * group they are in and whichever page the message was composed on. Copying the
 * accounting manager on a note to the bookkeeper is an ordinary thing to do, and
 * the group rule exists to say which LIST the message was addressed from, which
 * is a question only TO answers.
 *
 * The de-duplication is per (user, type), matching the table's primary key: the
 * same person listed twice on TO collapses to one row rather than failing the
 * insert on a key conflict. Somebody on both TO and CC stays on both — that is a
 * real thing to do and the header carries it.
 */
async function resolveRecipients({ caller, companyId, to, cc, bcc }) {
  const requested = [
    ...to.map((id) => ({ userId: id, recipientType: 'TO' })),
    ...cc.map((id) => ({ userId: id, recipientType: 'CC' })),
    ...bcc.map((id) => ({ userId: id, recipientType: 'BCC' })),
  ];

  const seen = new Set();
  const rows = requested.filter((row) => {
    const key = row.userId + ':' + row.recipientType;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Nobody named, nothing to resolve. Short-circuited because the alternative is
  // three queries to build an address book that will be intersected with an empty
  // list.
  if (!rows.length) return rows;

  /*
   * The address book is the UNION OF THE THREE PICKER ENDPOINTS, and it has to
   * stay that way. Anyone a picker offers must be sendable to, and anyone it does
   * not offer must not be — a group present in one and missing from the other is
   * either a name the user can select and then fail to send to, or an id they were
   * never shown that the API accepts anyway.
   */
  const groupsByUser = await loadAddressBook(companyId);

  /* ------------------------------------------------- rule 1: on the company - */

  const foreign = [...new Set(rows.map((r) => r.userId))].filter((id) => !groupsByUser.has(id));

  if (foreign.length) {
    const badRows = rows.filter((r) => foreign.includes(r.userId));
    throw new ApiError(400, 'Some of those recipients are not on this company.', {
      code: 'RECIPIENT_NOT_ON_COMPANY',
      fields: fieldsForRows(badRows, 'Choose recipients from this company.'),
      details: { userIds: foreign },
    });
  }

  /* -------------------------------- rules 2 and 3: what TO was addressed to - */

  const toIds = [...new Set(rows.filter((r) => r.recipientType === 'TO').map((r) => r.userId))];

  if (toIds.length) {
    /*
     * THE SENDER IS NOT SOMEONE THEY ARE WRITING TO.
     *
     * The owner appears in their own company's customer list — they ARE a
     * customer on it — so the picker offers them to themselves, and nothing above
     * would have stopped it: they are on the company and they are in an
     * addressable group. TO is the header that says who the message is FOR, and a
     * message addressed to its own author is a mistake in every case a screen can
     * produce it.
     *
     * REFUSED RATHER THAN SILENTLY DROPPED, because dropping is the worse
     * failure: a TO naming only the sender would become an empty TO, and the
     * message would either be refused later for a reason that does not mention
     * the real problem or go out to whoever was left on the header without anyone
     * being told a recipient was removed.
     *
     * CC AND BCC ARE UNTOUCHED. Copying yourself is how people keep a copy of what
     * they sent, and with no outbox screen in this API it is the only way to.
     */
    if (toIds.includes(caller.id)) {
      throw new ApiError(400, 'You cannot put yourself in To.', {
        code: 'SENDER_IN_TO',
        fields: { to: 'Add yourself to Cc or Bcc instead.' },
        details: { userIds: [caller.id] },
      });
    }

    /*
     * The groups that describe EVERY id on TO at once. One id leaves its own
     * groups; several leave only what they share, which is empty the moment two
     * pickers are mixed.
     */
    const shared = toIds.reduce(
      (acc, id) => acc.filter((group) => groupsByUser.get(id).has(group)),
      [...groupsByUser.get(toIds[0])]
    );

    if (!shared.length) {
      throw new ApiError(400, 'Everyone in To has to come from the same list.', {
        code: 'RECIPIENT_GROUP_MIXED',
        fields: {
          to: 'Pick from one list — customers, specialists, or the accounting manager.',
        },
        details: { userIds: toIds },
      });
    }

    /*
     * The role check, decided against the DATABASE rather than the token: `caller`
     * came from `users` via loadCompanyForRead, and a claim is a snapshot from when
     * the token was signed. Same reasoning as the gate on the manager picker, and
     * this is its write-side half — being unable to LIST a group and being unable
     * to SEND to it have to be the same rule, or the second is a hole in the first.
     */
    const allowed = ADDRESSABLE_GROUPS[caller.role?.code] ?? new Set();

    if (!shared.some((group) => allowed.has(group))) {
      throw new ApiError(403, 'You cannot send to ' + GROUP_LABEL[shared[0]] + ' on this company.', {
        code: 'RECIPIENT_GROUP_FORBIDDEN',
        fields: { to: 'Choose someone you can write to on this account.' },
        details: { userIds: toIds, group: shared[0], allowedGroups: [...allowed] },
      });
    }
  }

  return rows;
}

/**
 * POST /emails — compose and send, in one call.
 *
 * THE WHOLE FEATURE. One Send button on the screen, one request, and the message
 * is either in somebody's inbox or recorded as having failed to get there.
 *
 * THE ORDER MATTERS AND IT IS THIS:
 *
 *   1. check the caller may write to this company
 *   2. resolve every recipient against that company's roster
 *   3. measure every uploaded object in the bucket
 *   4. INSERT the message, its recipients and its attachments in ONE transaction
 *   5. hand it to SMTP
 *   6. mark SENT, or mark FAILED and 502
 *
 * Everything that can be refused is refused BEFORE step 4, so a request that was
 * never going to work leaves no row behind. The row is written before step 5
 * rather than after because the send is the thing that can half-succeed: if the
 * process dies mid-SMTP, a row marked neither SENT nor FAILED is a message that
 * may or may not have gone out and can be investigated, whereas no row at all is
 * mail that reached a client with nothing in the portal to show it.
 *
 * That transient row carries the column default, DRAFT. It is the one place the
 * value still occurs, it lasts as long as one SMTP handshake, and it is invisible
 * to the list screen — `validateMessageListQuery` will not accept DRAFT as a
 * filter, and a row stuck in it is crash residue that the retry endpoint accepts.
 *
 * WHY NOT SEND FIRST AND STORE AFTER. Because then a database failure would
 * discard the record of mail already delivered, which is the one outcome with no
 * recovery: the recipient has it, and the portal cannot say so.
 */
async function composeAndSend({ userId, requestId, body }) {
  const { caller, company } = await loadCompanyForRead(userId, body.companyId);

  const recipients = await resolveRecipients({ ...body, caller, companyId: company.id });

  // Belt and braces with the validator, which already requires a non-empty `to`.
  // This is the check that survives a validator refactor: the list here is what
  // actually reached the database, after deduplication.
  if (!recipients.some((r) => r.recipientType === 'TO')) {
    throw new ApiError(400, 'Add at least one recipient before sending.', {
      code: 'RECIPIENTS_REQUIRED',
      fields: { to: 'Choose who this message is for.' },
    });
  }

  const attachmentRows = await measureAttachments({ userId, requestId, files: body.files });

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const message = await repo.createMessage(tx, {
        data: {
          companyId: company.id,
          senderUserId: userId,
          subject: body.subject,
          bodyHtml: body.bodyHtml,
        },
        recipients,
      });

      if (attachmentRows.length) {
        await repo.createAttachments(
          tx,
          attachmentRows.map((row) => ({ ...row, emailMessageId: message.id }))
        );
      }

      return message;
    });
  } catch (err) {
    // Objects with no row are garbage, and nothing else will ever reference these
    // keys — the ticket that produced them is spent.
    await discardStoredObjects(attachmentRows.map((r) => r.fileKey), requestId);
    throw err;
  }

  return transmit({ userId, requestId, messageId: created.id, companyId: company.id });
}

/**
 * The uploaded objects, measured and turned into attachment rows — or a throw.
 *
 * This is the old `confirmUploads` endpoint, folded into the send. It stopped
 * being a request of its own the moment the draft went away: there was no longer a
 * row to attach anything to, and an endpoint whose only job is "remember these
 * bytes for the call after next" is a round trip the client pays for and a piece
 * of state that can be left dangling.
 *
 * EVERY FACT IS READ BACK FROM THE BUCKET, never taken from the request — that it
 * exists, its real size, and its type (from the extension in the key, which came
 * from the allowlist when the ticket was issued). The declared size the validator
 * checked was a claim; this is the measurement, and it is what makes the cap
 * enforceable rather than advisory.
 *
 * Nothing here writes to the database. It returns rows for the caller's
 * transaction, so a failure at any check below leaves no message and no
 * attachment — only the bucket objects, which are discarded on the way out.
 */
async function measureAttachments({ userId, requestId, files }) {
  if (!files.length) return [];

  if (!storage.isRemote()) throw directTransferUnavailable();

  /*
   * A key that is not this caller's own. The signed ticket is already spent by
   * now and proves nothing about who holds the key, so this is the check that
   * stops one user attaching another user's uploaded object to their own message.
   */
  const foreign = files.filter((f) => !isKeyForSender(f.key, userId));
  if (foreign.length) {
    throw new ApiError(400, 'Those uploads do not belong to you.', {
      code: 'INVALID_UPLOAD_KEY',
      fields: { files: 'Attach only the uploads this request issued.' },
      details: { keys: foreign.map((f) => f.key) },
    });
  }

  // `file_key` is UNIQUE. A key already on a sent message means a retried or
  // replayed request, and inserting it again would break on the index — a 500 for
  // what is really a duplicate submit.
  const already = await repo.findAttachmentsByKeys(prisma, files.map((f) => f.key));
  if (already.length) {
    throw new ApiError(409, 'Those files have already been sent on another message.', {
      code: 'ATTACHMENT_ALREADY_RECORDED',
      details: { attachmentIds: already.map((a) => a.id) },
    });
  }

  const stats = await Promise.all(files.map((file) => storage.statObject({ bucket: BUCKET, key: file.key })));

  const missing = files.filter((_, i) => !stats[i]);
  if (missing.length) {
    throw new ApiError(404, 'Some of those uploads did not arrive.', {
      code: 'UPLOAD_NOT_FOUND',
      fields: { files: 'Upload the file before sending.' },
      details: { fileNames: missing.map((f) => toDisplayName(f.fileName)) },
    });
  }

  /*
   * AN OBJECT THAT EXISTS AND IS EMPTY. Not the same condition as the one above:
   * the PUT reached the bucket and created the object, but carried no body — a
   * cancelled upload, a dropped connection, or a client that sent the headers and
   * nothing else.
   *
   * Checked HERE rather than left to the database. `email_attachments.size_bytes`
   * carries `CHECK (size_bytes > 0)`, which is the right constraint and would
   * catch it — but it catches it as a violated constraint inside the insert, which
   * surfaces as a 500 for what is plainly the caller's problem and says nothing
   * about which file. The object is discarded: zero bytes is not a document, and
   * leaving it stored would let the caller retry against a file that can never be
   * accepted.
   */
  const empty = files
    .map((file, i) => ({ file, sizeBytes: stats[i].sizeBytes }))
    .filter((f) => !(f.sizeBytes > 0));

  if (empty.length) {
    await discardStoredObjects(empty.map((f) => f.file.key), requestId);
    throw new ApiError(400, 'Some of those uploads are empty.', {
      code: 'UPLOAD_EMPTY',
      fields: { files: 'Upload the file again — nothing arrived in it.' },
      details: { fileNames: empty.map((f) => toDisplayName(f.file.fileName)) },
    });
  }

  const oversized = files
    .map((file, i) => ({ file, sizeBytes: stats[i].sizeBytes }))
    .filter((f) => f.sizeBytes > config.uploads.maxDocumentBytes);

  if (oversized.length) {
    await discardStoredObjects(oversized.map((f) => f.file.key), requestId);
    const mb = Math.round(config.uploads.maxDocumentBytes / (1024 * 1024));
    throw new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
      code: 'FILE_TOO_LARGE',
      fields: { files: `Each file must be under ${mb} MB.` },
      details: {
        files: oversized.map((f) => ({ fileName: toDisplayName(f.file.fileName), sizeBytes: f.sizeBytes })),
        maxBytes: config.uploads.maxDocumentBytes,
      },
    });
  }

  /*
   * The total, across everything this one message carries. Simpler than it used
   * to be: the incremental confirm step had to add what was arriving to what was
   * already recorded, because files could be attached over several calls. One
   * call means one complete set, so this is the only sum there is.
   */
  const totalBytes = stats.reduce((sum, s) => sum + Number(s.sizeBytes), 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    await discardStoredObjects(files.map((f) => f.key), requestId);
    const mb = Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024));
    throw new ApiError(413, `Attachments total more than ${mb} MB, which most mail servers reject.`, {
      code: 'ATTACHMENTS_TOO_LARGE',
      fields: { files: `Keep all attachments under ${mb} MB in total.` },
      details: { totalBytes, maxBytes: MAX_TOTAL_ATTACHMENT_BYTES },
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

/* -------------------------------------------------------------------------- */
/* attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * POST /emails/attachments/upload-url — permission to write, as links.
 *
 * NO MESSAGE ID IN THE PATH, and that is the visible half of dropping the draft.
 * There is nothing to hang the upload off yet, so the caller names the COMPANY
 * they are writing to and the key is scoped by the authenticated sender instead.
 *
 * `companyId` is not decoration. This endpoint hands out signed write access to a
 * private bucket, so it needs the same access decision every other endpoint on
 * this feature makes; without a company to check, "any authenticated user" would
 * be the only rule left.
 *
 * Mirrors projectDocumentService.createUploadTickets in what it does NOT do:
 * nothing is recorded. A ticket that is never used leaves nothing behind; an
 * upload that lands and is never sent leaves an unreferenced object, which is the
 * one piece of litter this design accepts in exchange for the request-size ceiling
 * disappearing.
 */
async function createUploadTickets({ userId, requestId, companyId, files }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const { company } = await loadCompanyForRead(userId, companyId);

  const uploads = await Promise.all(
    files.map(async (file) => {
      const key = emailAttachmentKey(userId, file.mimeType);
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
    event: 'email.attachment.upload_ticket.issued',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${uploads.length} ticket(s)`,
  });

  return { companyId: company.id, uploads };
}

/* -------------------------------------------------------------------------- */
/* sending                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the bytes, hand the message to SMTP, and record what happened.
 *
 * THE ONLY STATE TRANSITION THAT MATTERS, and the reason the row exists at all.
 * Everything before this is recoverable; this is the point past which the message
 * is in somebody's inbox and no edit here can reach it.
 *
 * Shared by `composeAndSend` and by the retry endpoint, which is the whole reason
 * it is a function and not the body of a route: the two differ only in how the row
 * came to exist, and a second copy of the SMTP handling would be a second place
 * for the FAILED bookkeeping to drift.
 *
 * The bytes are fetched from the bucket HERE, not carried from the upload — the
 * upload happened in a different request, quite possibly on a different serverless
 * instance, and there is nowhere in between to keep them.
 *
 * WHAT HAPPENS WHEN SMTP REFUSES. The row is marked FAILED with the transport's
 * own message on it and a 502 is returned. It is NOT deleted: the user needs to
 * see that an attempt was made and why it did not work, the attached bytes are
 * still in the bucket, and FAILED is not terminal — `POST /emails/:id/send` tries
 * the same row again.
 */
async function transmit({ userId, requestId, messageId, companyId }) {
  const full = await repo.findMessageForSend(prisma, messageId);

  const to = full.recipients.filter((r) => r.recipientType === 'TO');
  if (!to.length) {
    throw new ApiError(400, 'Add at least one recipient before sending.', {
      code: 'RECIPIENTS_REQUIRED',
      fields: { to: 'Choose who this message is for.' },
    });
  }

  if (!full.sender) {
    // Only reachable on a retry: the composer's account was deleted between the
    // failed attempt and this one. There is no address to put in Reply-To and no
    // person to attribute it to.
    throw new ApiError(409, 'The sender account no longer exists.', {
      code: 'SENDER_NOT_FOUND',
      details: { messageId },
    });
  }

  const address = (row) => ({ name: `${row.user.firstName} ${row.user.lastName}`.trim(), address: row.user.email });

  /*
   * Fetch every attachment's bytes before calling the transport, not lazily
   * during it. A stream that fails halfway through a send leaves the provider
   * holding a partial message and this code with no clean way to decide whether
   * it went out; fetching first means a storage failure is a plain 502 with
   * nothing sent.
   */
  let attachments;
  try {
    attachments = await Promise.all(
      full.attachments.map(async (a) => {
        // Returns the Buffer itself, or null when the object is gone.
        const content = await storage.getObject({ bucket: BUCKET, key: a.fileKey });
        // A row pointing at bytes that are not there. Sending the message anyway
        // would silently drop a file the user attached and can see on screen,
        // which is worse than refusing: they would never learn it did not go.
        if (!content) throw new Error(`attachment ${a.id} is missing from storage`);
        return { filename: a.originalName, content, contentType: a.mimeType };
      })
    );
  } catch (err) {
    logger.error(`Could not read attachments for message ${messageId}: ${err.message}`);
    throw new ApiError(502, 'The attachments could not be read. Try again.', {
      code: 'ATTACHMENT_READ_FAILED',
      details: { messageId },
    });
  }

  try {
    await transport.sendComposedEmail({
      senderEmail: full.sender.email,
      senderName: `${full.sender.firstName} ${full.sender.lastName}`.trim(),
      to: to.map(address),
      cc: full.recipients.filter((r) => r.recipientType === 'CC').map(address),
      bcc: full.recipients.filter((r) => r.recipientType === 'BCC').map(address),
      subject: full.subject,
      bodyHtml: full.bodyHtml,
      attachments,
    });
  } catch (err) {
    await repo.markFailed(prisma, messageId, String(err?.message ?? err).slice(0, 2000));

    logEvent({
      event: 'email.message.send',
      status: 'error',
      requestId,
      userId,
      companyId,
      detail: `message ${messageId}: ${err?.message ?? err}`,
    });

    throw new ApiError(502, 'The message could not be sent. It has been saved so you can try again.', {
      code: 'EMAIL_SEND_FAILED',
      details: { messageId, reason: String(err?.message ?? err) },
    });
  }

  await repo.markSent(prisma, messageId, new Date());

  logEvent({
    event: 'email.message.send',
    status: 'success',
    requestId,
    userId,
    companyId,
    detail: `message ${messageId}, ${full.recipients.length} recipient(s), ${full.attachments.length} attachment(s)`,
  });

  return dto.toMessage(await repo.findMessageById(prisma, messageId));
}

/*
 * THERE IS NO DELETE. Nothing on this feature is deletable, and that follows
 * directly from having no draft: the only rows that exist are a message that was
 * sent and a message whose send failed, and neither is litter.
 *
 * A SENT row is a record of mail that reached a real person — deleting it would
 * make the portal disagree with the world. A FAILED row is the user's own retry
 * button plus the reason the last attempt did not work; deleting it would leave
 * them with a message that vanished for no stated reason. The old
 * `DELETE /emails/:id` existed to discard an abandoned draft, and there are no
 * abandoned drafts any more.
 *
 * The one thing that CAN be abandoned is an upload: a file that got a ticket, or
 * even landed in the bucket, and then was never sent. That leaves an unreferenced
 * object and no row at all — see createUploadTickets. It is invisible to every
 * read in this file and is cleaned up by bucket lifecycle rules, not by an
 * endpoint, because there is nothing in the database naming it to delete.
 */

module.exports = {
  listCustomerRecipients,
  listSpecialistRecipients,
  listAccountingManagerRecipients,
  createUploadTickets,
  composeAndSend,
  // exported for unit testing
  _internals: { toDisplayName, isKeyForSender, customerRoleLabel, MAX_TOTAL_ATTACHMENT_BYTES },
};
