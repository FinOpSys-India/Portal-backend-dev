'use strict';

const { Prisma } = require('@prisma/client');

const { PERSON_SELECT } = require('./emailRepository');

/**
 * Data access for company-scoped chat.
 *
 * Same conventions as the other repositories here: the Prisma client is the
 * first argument (`prisma` for a standalone read, `tx` inside a transaction),
 * and every filter that must never be forgotten — `deletedAt: null` above all —
 * lives in this file rather than being retyped at each call site.
 *
 * WHAT IS AND IS NOT STORED, restated from db/schema/20_add_chat.sql because it
 * is what shapes every function below:
 *
 *   A conversation is (company, accounting manager, counterpart). The company is
 *   part of its IDENTITY, so there is no read here that does not know which
 *   company it is about.
 *
 *   A message has a sender and no receiver column. The receiver is whichever of
 *   the conversation's two sides did not send it — derived in chatDto, never
 *   stored, because a stored copy could disagree with the thread it hangs off.
 *
 *   Nobody's email address is stored. Every read joins the person, exactly as
 *   emailRepository does, which is also why PERSON_SELECT is imported from there
 *   rather than declared again: "the columns a person needs to appear on a
 *   screen" is one decision, and two copies of it drift the first time either is
 *   changed.
 *
 * THE ROSTER READS ARE NOT HERE EITHER. Who the customers and specialists of a
 * company are is answered by emailRepository.listCompanyCustomers and
 * listCompanySpecialistSources, which chatService calls directly. Those queries
 * merge four different ways of being attached to a company (the owner column,
 * company_members, the three standing specialist columns, the assignment table)
 * and getting any of them wrong silently makes somebody unreachable. One
 * implementation, two features.
 */

/* -------------------------------------------------------------------------- */
/* conversations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything a conversation needs to be authorized and rendered.
 *
 * Both sides are joined rather than returned as bare ids: every caller that
 * loads a thread also has to say who is in it, and a second query per side would
 * be two more round trips against a managed Postgres for columns this one
 * already reaches.
 */
const CONVERSATION_SELECT = {
  id: true,
  companyId: true,
  accountingManagerUserId: true,
  participantUserId: true,
  participantKind: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { id: true, companyName: true } },
  accountingManager: { select: PERSON_SELECT },
  participant: { select: PERSON_SELECT },
};

/** One thread by id, or null. */
function findConversationById(client, id) {
  return client.chatConversation.findUnique({
    where: { id },
    select: CONVERSATION_SELECT,
  });
}

/**
 * The thread between one manager and one counterpart on one company.
 *
 * Reads through the unique key, so this is a single index lookup and cannot
 * return more than one row — which is the schema's guarantee rather than this
 * function's: `UNIQUE (company_id, accounting_manager_user_id,
 * participant_user_id)`.
 */
function findConversationByPair(client, { companyId, accountingManagerUserId, participantUserId }) {
  return client.chatConversation.findUnique({
    where: {
      companyId_accountingManagerUserId_participantUserId: {
        companyId,
        accountingManagerUserId,
        participantUserId,
      },
    },
    select: CONVERSATION_SELECT,
  });
}

/**
 * Open the thread, or hand back the one that already exists.
 *
 * AN UPSERT AND NOT A find-then-create, and that is the whole reason this
 * function exists. Both sides of a thread can click "message" at the same
 * instant; a select followed by an insert would have both find nothing and both
 * insert, and the second one would die on the unique index — a 500 for two people
 * doing something entirely ordinary. The upsert resolves that in the database,
 * where the race actually is.
 *
 * `update: {}` is deliberate: reopening a thread must not touch a single column
 * on it. `lastMessageAt` belongs to the messages, and bumping `updatedAt` here
 * would make "opened the window" indistinguishable from "said something".
 *
 * `participantKind` is written ONCE, at creation, and never corrected
 * afterwards — see the enum's comment in db/schema/20_add_chat.sql. A person
 * whose role changes keeps their old threads in the section those conversations
 * were held in.
 */
function openConversation(client, { companyId, accountingManagerUserId, participantUserId, participantKind }) {
  return client.chatConversation.upsert({
    where: {
      companyId_accountingManagerUserId_participantUserId: {
        companyId,
        accountingManagerUserId,
        participantUserId,
      },
    },
    create: { companyId, accountingManagerUserId, participantUserId, participantKind },
    update: {},
    select: CONVERSATION_SELECT,
  });
}

/**
 * Every thread on one company that this user is a side of.
 *
 * The `OR` is what makes one function serve both portals: an accounting manager
 * matches the first arm and sees every thread they hold on that company, while a
 * customer or a specialist matches the second and sees only their own. Neither
 * can see the other's, because the query has no arm that would return it.
 *
 * NULLS LAST on `lastMessageAt` is not expressible through Prisma's shorthand,
 * so it is spelled out: a thread that has been opened and never used sorts to
 * the bottom rather than the top, which is where "no activity" belongs on a list
 * ordered by activity.
 */
function listConversationsForUser(client, { companyId, userId }) {
  return client.chatConversation.findMany({
    where: {
      companyId,
      OR: [{ accountingManagerUserId: userId }, { participantUserId: userId }],
    },
    select: CONVERSATION_SELECT,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  });
}

/**
 * The threads this manager holds with a given set of people on one company.
 *
 * The shape the two portal lists need: they start from the ROSTER — everyone on
 * the company, thread or no thread — and this fills in the threads that happen
 * to exist. Nobody is dropped for not having been messaged yet, which is how the
 * first message to anyone ever gets sent.
 *
 * Keyed by participant id in the service. An empty `participantUserIds` returns
 * nothing without a query, because `IN ()` is a round trip that cannot match.
 */
function findConversationsForParticipants(client, { companyId, accountingManagerUserId, participantUserIds }) {
  if (!participantUserIds.length) return Promise.resolve([]);
  return client.chatConversation.findMany({
    where: {
      companyId,
      accountingManagerUserId,
      participantUserId: { in: participantUserIds },
    },
    select: CONVERSATION_SELECT,
  });
}

/**
 * Move a thread's `lastMessageAt` forward.
 *
 * Called inside the same transaction as the message insert — see
 * chatService.sendMessage. There are no triggers anywhere in this schema and
 * this is not the place to introduce the first: a trigger would perform this
 * write invisibly to the code that causes it, and the denormalised column would
 * then have two authors.
 *
 * The write also bumps `updatedAt` through Prisma's `@updatedAt`, which is
 * correct here and wrong in `openConversation` above: a message IS a change to
 * the thread.
 */
function touchConversation(client, { conversationId, lastMessageAt }) {
  return client.chatConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt },
    select: { id: true, lastMessageAt: true },
  });
}

/* -------------------------------------------------------------------------- */
/* messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A message in the shape every read returns it.
 *
 * `attachments` deliberately omits `fileKey`, exactly as MESSAGE_SELECT does in
 * emailRepository: it is an internal storage path, the client has no use for it,
 * and shipping it would invite a frontend to build its own bucket URL — which
 * must never work for a private bucket. The one read that needs the key asks for
 * it by name (`findAttachmentForDownload`).
 */
const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  senderUserId: true,
  body: true,
  readAt: true,
  createdAt: true,
  updatedAt: true,
  sender: { select: PERSON_SELECT },
  attachments: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
    orderBy: { id: 'asc' },
  },
};

/**
 * One page of a thread, newest first.
 *
 * KEYSET PAGINATION, NOT OFFSET, and on a chat window that is not a preference.
 * Messages arrive while the user is scrolling: with `skip`, every new message
 * shifts the window by one and the next page repeats a row or drops one. A
 * cursor names a position in the data rather than a distance from the start, so
 * what has arrived since does not move it.
 *
 * The cursor is (createdAt, id) rather than id alone. Ids are monotonic here, so
 * id alone would in fact work — but the ORDER BY is on createdAt, and a cursor
 * that does not match the sort is the kind of thing that silently starts
 * skipping rows the day a backfill inserts a message with an older timestamp.
 *
 * `after` is the other direction and exists for reconnects: the browser holds a
 * live subscription (see db/schema/21_add_chat_realtime.sql), and when the socket
 * drops it needs everything it missed — which is "after the last id I have", not
 * "the newest fifty".
 */
function listMessages(client, { conversationId, limit, before, after }) {
  const where = {
    conversationId,
    deletedAt: null,
    ...(before
      ? {
          OR: [
            { createdAt: { lt: before.createdAt } },
            { createdAt: before.createdAt, id: { lt: before.id } },
          ],
        }
      : {}),
    ...(after
      ? {
          OR: [
            { createdAt: { gt: after.createdAt } },
            { createdAt: after.createdAt, id: { gt: after.id } },
          ],
        }
      : {}),
  };

  return client.chatMessage.findMany({
    where,
    select: MESSAGE_SELECT,
    // Newest first in both directions. A catch-up fetch still returns the most
    // recent page of what was missed, which is what a client that has been
    // offline for a week actually wants; the rest is reachable with `before`.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

/** One message, joined, in the shape a send or a read returns it. */
function findMessageById(client, id) {
  return client.chatMessage.findUnique({ where: { id }, select: MESSAGE_SELECT });
}

/**
 * Just enough of a message to decide who may act on it.
 *
 * The conversation is joined because both access questions this API asks about a
 * message — may you read it, may you delete it — are questions about the thread
 * it is in. Selecting the thread's two sides here is what lets the service
 * answer them without a second query.
 */
function findMessageForAccess(client, id) {
  return client.chatMessage.findUnique({
    where: { id },
    select: {
      id: true,
      conversationId: true,
      senderUserId: true,
      deletedAt: true,
      conversation: {
        select: {
          id: true,
          companyId: true,
          accountingManagerUserId: true,
          participantUserId: true,
        },
      },
    },
  });
}

/**
 * Write the message.
 *
 * Attachments are nested rather than inserted separately, so one round trip
 * writes the row and everything hanging off it — and, more to the point, a
 * failure anywhere in it writes neither. A message that exists without the file
 * it was sent to deliver is worse than no message.
 */
function createMessage(client, { conversationId, senderUserId, body, attachments }) {
  return client.chatMessage.create({
    data: {
      conversationId,
      senderUserId,
      body,
      ...(attachments?.length ? { attachments: { createMany: { data: attachments } } } : {}),
    },
    select: MESSAGE_SELECT,
  });
}

/**
 * Mark as read everything in a thread the reader did NOT send.
 *
 * `senderUserId: { not: readerUserId }` is the whole rule, and it is why no
 * reads table is needed: with two sides, "unread by me" is exactly "sent by the
 * other one and not yet stamped". A reader cannot mark their own message read,
 * which is meaningless, and cannot mark the other side's copy read either,
 * because there is no such row.
 *
 * `readAt: null` in the filter keeps the write idempotent AND truthful: a second
 * call touches nothing, so the timestamp goes on staying the moment the message
 * was first opened rather than the last time the window was focused.
 *
 * `upToMessageId` bounds it to what the client has actually rendered. Without
 * it, opening a thread would stamp messages that arrive milliseconds later and
 * were never on screen.
 */
function markRead(client, { conversationId, readerUserId, upToMessageId, readAt }) {
  return client.chatMessage.updateMany({
    where: {
      conversationId,
      senderUserId: { not: readerUserId },
      readAt: null,
      deletedAt: null,
      ...(upToMessageId ? { id: { lte: upToMessageId } } : {}),
    },
    data: { readAt },
  });
}

/**
 * How many messages in each of these threads this user has not read.
 *
 * ONE grouped query for the whole list rather than a count per row. The two
 * portal sections render up to a few dozen people each, and a per-row count
 * would be a few dozen round trips to a managed Postgres — which is latency, not
 * work: the counts themselves are index-only scans over the partial unread
 * index.
 *
 * Threads with nothing unread are simply absent from the result. The service
 * defaults them to 0 rather than this query returning zero rows it had to
 * manufacture.
 */
async function countUnreadByConversation(client, { conversationIds, userId }) {
  if (!conversationIds.length) return new Map();

  const rows = await client.chatMessage.groupBy({
    by: ['conversationId'],
    where: {
      conversationId: { in: conversationIds },
      senderUserId: { not: userId },
      readAt: null,
      deletedAt: null,
    },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.conversationId, row._count._all]));
}

/**
 * The newest live message in each of these threads — the preview line.
 *
 * RAW SQL, AND THE ONLY RAW QUERY IN THIS FILE. `findMany` with
 * `distinct: ['conversationId']` expresses exactly this and was the first
 * version of it, but Prisma applies `distinct` in the query engine rather than
 * emitting DISTINCT ON: the database would return EVERY live message of every
 * listed thread and the engine would throw away all but one per thread. On a
 * contact list of forty people with a year of history behind them, that is the
 * whole chat table crossing the wire to render forty preview lines.
 *
 * DISTINCT ON with a matching ORDER BY makes Postgres do the same job in the
 * index: one row per conversation, and the ordering decides which one. The
 * conversation_id leg of the ORDER BY is required for DISTINCT ON to be
 * well-defined — it is not decoration.
 *
 * `attachment_count` is here because a preview line has to say something about a
 * message that is only a file: `body` is NULL on those, and a blank preview
 * reads as a bug. Joining the attachment rows themselves would multiply the
 * result; a scalar subquery keeps it one row per thread.
 *
 * The shape returned matches what MESSAGE_SELECT produces (a nested `sender`,
 * camelCase keys) so chatDto.toMessage cannot tell the two apart.
 */
async function findLatestMessages(client, { conversationIds }) {
  if (!conversationIds.length) return [];

  const rows = await client.$queryRaw`
    SELECT DISTINCT ON (m.conversation_id)
      m.id,
      m.conversation_id,
      m.sender_user_id,
      m.body,
      m.read_at,
      m.created_at,
      m.updated_at,
      u.first_name,
      u.last_name,
      u.email,
      u.job_title,
      u.avatar_key,
      (SELECT count(*) FROM chat_attachments a WHERE a.message_id = m.id) AS attachment_count
    FROM chat_messages m
    JOIN users u ON u.id = m.sender_user_id
    WHERE m.conversation_id IN (${Prisma.join(conversationIds)})
      AND m.deleted_at IS NULL
    ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sender: {
      id: row.sender_user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      jobTitle: row.job_title,
      avatarKey: row.avatar_key,
    },
    // Deliberately not the attachment ROWS. A preview needs to know that there
    // are files, not which ones; the thread itself carries them.
    attachments: [],
    attachmentCount: Number(row.attachment_count ?? 0),
  }));
}

/**
 * The unread total across every thread on one company that this user is in.
 *
 * The nav badge. Counted rather than summed from the list endpoints, because the
 * badge is rendered on screens that never load either list — and a badge derived
 * from a list is a badge that lies whenever the list is paginated.
 */
function countUnreadForUser(client, { companyId, userId }) {
  return client.chatMessage.count({
    where: {
      readAt: null,
      deletedAt: null,
      senderUserId: { not: userId },
      conversation: {
        companyId,
        OR: [{ accountingManagerUserId: userId }, { participantUserId: userId }],
      },
    },
  });
}

/**
 * Soft delete. The row stays and the thread keeps its shape — but the files do
 * NOT survive it; see `takeAttachmentKeys` and chatService.deleteMessage.
 *
 * Conditional on `deletedAt: null` so a double-clicked delete does not rewrite
 * the timestamp of the first one — the same idempotence `markRead` gets from its
 * own null check. `updateMany` rather than `update` because a conditional update
 * that matches nothing must be a no-op, not a P2025 thrown at a user who clicked
 * twice.
 *
 * Returns `{ count }`, and the caller is expected to read it: a count of 0 means
 * this delete lost the race (or is the second click), and the purge below has
 * already been done by whoever won.
 */
function softDeleteMessage(client, { id, deletedAt }) {
  return client.chatMessage.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt },
  });
}

/**
 * The storage keys still held by one message's attachments.
 *
 * `not: null` because a purged row keeps every column except this one, so a
 * message whose files are already gone yields an empty list rather than a list
 * of nulls to hand to the bucket.
 */
function findAttachmentKeys(client, messageId) {
  return client.chatAttachment.findMany({
    where: { messageId, fileKey: { not: null } },
    select: { id: true, fileKey: true },
  });
}

/**
 * Forget where the bytes were. Everything else about the attachment stays.
 *
 * SEPARATE FROM THE OBJECT DELETE ON PURPOSE, and ordered after it: the key is
 * the only record of what to remove, so dropping it before the bucket call would
 * turn a failed removal into an object nothing can ever name again. Doing it in
 * this order can leave an orphaned object if the process dies in between, which
 * is the cheaper of the two failures.
 *
 * Scoped by `fileKey: { not: null }` so a re-run touches nothing.
 */
function clearAttachmentKeys(client, messageId) {
  return client.chatAttachment.updateMany({
    where: { messageId, fileKey: { not: null } },
    data: { fileKey: null },
  });
}

/* -------------------------------------------------------------------------- */
/* attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rows already pointing at any of these storage keys.
 *
 * `file_key` is UNIQUE, so this is not the constraint — it is the difference
 * between a 409 that says which files were already sent and a 500 out of the
 * index. It is needed because the browser uploads straight to the bucket, which
 * leaves the caller holding keys that a retried, replayed or double-clicked send
 * would submit twice.
 */
function findAttachmentsByKeys(client, keys) {
  return client.chatAttachment.findMany({
    where: { fileKey: { in: keys } },
    select: { id: true, fileKey: true },
  });
}

/**
 * One attachment with everything the download check needs: the file, the message
 * it is on, and the two sides of the thread it belongs to.
 *
 * THE ONE READ THAT SELECTS `fileKey`. Everything else in this file hides it —
 * see MESSAGE_SELECT — and this is the single code path with a reason to know
 * it: it is about to sign a URL for those exact bytes. The key still does not
 * reach the client; what leaves is the signed URL.
 *
 * `deletedAt` on the message comes back too rather than being filtered here, so
 * the service can answer "that file was deleted" with a 404 that says so instead
 * of one indistinguishable from "no such attachment".
 */
function findAttachmentForDownload(client, id) {
  return client.chatAttachment.findUnique({
    where: { id },
    select: {
      id: true,
      fileKey: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      message: {
        select: {
          id: true,
          deletedAt: true,
          conversation: {
            select: {
              id: true,
              companyId: true,
              accountingManagerUserId: true,
              participantUserId: true,
            },
          },
        },
      },
    },
  });
}

module.exports = {
  CONVERSATION_SELECT,
  MESSAGE_SELECT,
  findConversationById,
  findConversationByPair,
  openConversation,
  listConversationsForUser,
  findConversationsForParticipants,
  touchConversation,
  listMessages,
  findMessageById,
  findMessageForAccess,
  createMessage,
  markRead,
  countUnreadByConversation,
  findLatestMessages,
  countUnreadForUser,
  softDeleteMessage,
  findAttachmentKeys,
  clearAttachmentKeys,
  findAttachmentsByKeys,
  findAttachmentForDownload,
};
