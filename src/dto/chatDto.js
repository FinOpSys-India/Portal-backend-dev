'use strict';

const { toPerson } = require('./projectDto');

/**
 * Response shapes for chat.
 *
 * Three rules, the first two carried over from projectDocumentDto and emailDto
 * because the same facts are true here:
 *
 *   1. `size_bytes` is BIGINT, so Prisma hands back a JavaScript BigInt — and
 *      `JSON.stringify` THROWS on a BigInt rather than rendering it. Every size
 *      that leaves this file goes through `toBytes`.
 *
 *   2. `file_key` never leaves this file, and is not even selected by the
 *      repository's read paths. What a client gets is a download URL pointing at
 *      the authorized endpoint.
 *
 *   3. A MESSAGE ID IS ALSO A BIGINT, which is new here — chat_messages.id is
 *      BIGSERIAL (see db/schema/20_add_chat.sql) and every other id in this API
 *      is a plain integer. It is rendered as a JSON NUMBER rather than a string,
 *      which is safe up to 2^53 and therefore safe for as long as the column
 *      matters; the alternative would make the client's cursor arithmetic and
 *      every `:messageId` in a URL a string in one feature and a number in the
 *      rest.
 *
 * AND THE ONE RULE THIS FILE ADDS: the RECEIVER of a message is computed here,
 * because it is not stored. A thread has exactly two sides, so the receiver is
 * whichever one did not send it. See `toMessage`.
 */

/** A BIGINT column as a JSON number. See rules 1 and 3 above. */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** One attachment as the client sees it. */
function toAttachment(attachment) {
  return {
    id: attachment.id,
    // `fileName` rather than `originalName`: the column is named for what it
    // holds as opposed to the generated storage name, but from the other side of
    // the screen there is only one name and this is it.
    fileName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: toNumber(attachment.sizeBytes),
    // Not a URL. The bytes are in a private bucket and leave only through
    // GET /chat/attachments/:id/download-url, which authorizes the caller and
    // signs a link that expires in a minute. A URL rendered here would have to
    // be signed for every attachment in every message of every page — most of
    // which nobody opens — and would still be expired by the time they did.
    downloadPath: `/chat/attachments/${attachment.id}/download-url`,
  };
}

/**
 * The two sides of a thread, from the point of view of one message.
 *
 * The sender is joined on the row. The receiver is DERIVED: if the sender is the
 * accounting manager then the receiver is the participant, and otherwise it is
 * the manager. That is the whole rule, it is one expression, and it is why
 * chat_messages has no recipient column — see consequence 3 in
 * db/schema/20_add_chat.sql.
 */
function receiverOf(message, conversation) {
  if (!conversation) return null;
  return message.senderUserId === conversation.accountingManagerUserId
    ? conversation.participant
    : conversation.accountingManager;
}

/**
 * One message.
 *
 * `sender` and `receiver` are full people rather than ids, each carrying their
 * email, because that is what the request asked of this feature and none of it
 * is stored: the addresses come off the joined `users` rows and therefore cannot
 * be stale. The company is on the message too — the thread it belongs to always
 * knows which account it is about, and a message dropped into a notification or
 * a search result should not have to be traced back to find out.
 *
 * `mine` is the one piece of pure presentation here, and it earns its place: it
 * is what decides which side of the window a bubble is drawn on, and a client
 * computing `senderUserId === myUserId` itself has to be told its own user id in
 * a context where it may not have it.
 */
function toMessage(message, { conversation, viewerUserId = null } = {}) {
  return {
    id: toNumber(message.id),
    conversationId: message.conversationId,
    companyId: conversation?.companyId ?? null,

    sender: toPerson(message.sender),
    receiver: toPerson(receiverOf(message, conversation)),

    // Null when the message carried only files. The client renders the
    // attachments and no bubble text, rather than an empty line.
    body: message.body ?? null,
    attachments: (message.attachments ?? []).map(toAttachment),

    /*
     * Whether there are files at all, which is not always answerable from the
     * array above: a PREVIEW line (chatRepository.findLatestMessages) counts the
     * attachments without fetching them, because a list needs to know that a
     * message carries files — an attachment-only message has a NULL body, and a
     * blank preview line reads as a bug — but has no use for which ones.
     */
    hasAttachments: Boolean(message.attachmentCount ?? (message.attachments?.length ?? 0)),

    // The timestamp the whole screen is ordered by, and the read receipt beside
    // it. `readAt` is null on an unread message and on every message the viewer
    // sent that the other side has not opened yet — which is the same column
    // answering both questions, because there are only two people here.
    createdAt: message.createdAt,
    readAt: message.readAt ?? null,

    mine: viewerUserId !== null ? message.senderUserId === viewerUserId : null,
  };
}

/**
 * One thread, as a row in a list or as the header of an open window.
 *
 * `counterpart` is the OTHER person from the viewer's side, not a fixed one of
 * the two: the accounting manager's list shows the customer, and the customer's
 * list shows the accounting manager. One field, two screens, no client-side
 * branch on "am I the manager here".
 */
function toConversation(conversation, { viewerUserId = null, unreadCount = 0, lastMessage = null } = {}) {
  const viewerIsManager = viewerUserId !== null && conversation.accountingManagerUserId === viewerUserId;

  return {
    id: conversation.id,
    companyId: conversation.companyId,
    companyName: conversation.company?.companyName ?? null,

    participantKind: conversation.participantKind,
    accountingManager: toPerson(conversation.accountingManager),
    participant: toPerson(conversation.participant),
    counterpart: viewerIsManager
      ? toPerson(conversation.participant)
      : toPerson(conversation.accountingManager),

    // Null until the first message. The list sorts on it with NULLS LAST, so an
    // opened-but-unused thread sits at the bottom rather than the top.
    lastMessageAt: conversation.lastMessageAt ?? null,
    lastMessage: lastMessage ? toMessage(lastMessage, { conversation, viewerUserId }) : null,
    unreadCount,

    createdAt: conversation.createdAt,
  };
}

/**
 * One person in an accounting manager's contact list, with their thread folded
 * in.
 *
 * THE PERSON IS THE ROW, NOT THE THREAD, and that is the shape the portal needs:
 * both sections list everyone on the company, including the people who have
 * never been messaged. Those come back with `conversationId: null` and no
 * counts, and clicking one opens a thread — which is how a first message is ever
 * sent. A list built from conversations could not show them at all.
 */
function toContact(person, { kind, roleLabel, specializations = [], conversation = null, unreadCount = 0, lastMessage = null, viewerUserId = null }) {
  return {
    ...toPerson(person),
    kind,
    // "Owner" / "Team" for a customer; the service lines they cover on THIS
    // company for a specialist. A list of names with no roles beside them cannot
    // be picked from with any confidence.
    roleLabel,
    // Always an array, even when it holds one entry, so a client never has to
    // special-case the specialist who covers a single line. Empty for customers.
    specializations,

    conversationId: conversation?.id ?? null,
    lastMessageAt: conversation?.lastMessageAt ?? null,
    lastMessage: lastMessage && conversation ? toMessage(lastMessage, { conversation, viewerUserId }) : null,
    unreadCount,
  };
}

/**
 * A contact list — one of the two sections of the accounting manager's portal.
 *
 * The company is echoed at the top as well as being implied by every row,
 * because a client rendering a heading should not have to reach into
 * `contacts[0]` for the name, which is empty the moment the list is.
 */
function toContactList({ company, kind, contacts }) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    kind,
    contacts,
    total: contacts.length,
    // The sum across the section, so the tab can carry its own badge without a
    // second call or a client-side reduce over a paginated list.
    unreadTotal: contacts.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
  };
}

/** A list of threads — what the customer and specialist portals open with. */
function toConversationList({ company, conversations }) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    conversations,
    total: conversations.length,
    unreadTotal: conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
  };
}

/**
 * One page of a thread.
 *
 * MESSAGES COME BACK NEWEST FIRST, exactly as the query returned them, and the
 * client reverses them to paint the window. Sorting them here would mean the
 * cursor — which names the OLDEST row on the page — no longer matched the last
 * element, and every consumer would rediscover that the hard way.
 *
 * `nextCursor` is null when the page is not full, which is the only honest
 * signal that there is nothing older: a cursor that returns an empty page is one
 * wasted round trip per thread the user scrolls to the top of.
 */
function toMessagePage({ conversation, messages, viewerUserId, nextCursor, unreadCount }) {
  return {
    conversation: toConversation(conversation, { viewerUserId, unreadCount }),
    messages: messages.map((m) => toMessage(m, { conversation, viewerUserId })),
    nextCursor: nextCursor ?? null,
    hasMore: Boolean(nextCursor),
  };
}

module.exports = {
  toNumber,
  toAttachment,
  toMessage,
  toConversation,
  toContact,
  toContactList,
  toConversationList,
  toMessagePage,
};
