'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const config = require('../config');
const common = require('../validators/common');
const {
  validateCompanyQuery,
  validateMessageListQuery,
  validateOpenConversation,
  validateSendMessage,
  validateMarkRead,
  validateUploadTicketRequest,
} = require('../validators/chatValidator');
const { isAllowedMimeType, ACCEPTED_LABEL } = require('../utils/documentTypes');
const chatService = require('../services/chatService');
const chatRealtimeService = require('../services/chatRealtimeService');

/**
 * HTTP layer for chat. Thin, like the other controllers here: identity from
 * req.user, ids from the URL, validate, delegate, wrap in the envelope. Every
 * access decision is in the service, where it can be made against the database.
 *
 * ONE THING IS WORTH NOTICING ABOUT THE URLS. A message id appears in a path
 * (`DELETE /chat/messages/:messageId`) and `chat_messages.id` is BIGSERIAL, so
 * it is parsed as a decimal string and converted to a BigInt rather than going
 * through `common.parseId` — which returns a Number and would silently lose
 * precision above 2^53. Everything else here is an ordinary integer id.
 */

/** A BIGSERIAL id out of a URL. See the note above. */
function parseMessageId(value, field = 'messageId') {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) || raw === '0') {
    throw common.fieldError(field, `${field} must be a message id.`, 'Invalid id.');
  }
  return BigInt(raw);
}

/* -------------------------------------------------------------------------- */
/* the accounting manager's portal                                            */
/* -------------------------------------------------------------------------- */

/**
 * GET /chat/contacts/customers?companyId=&search=
 *
 * Section one: the company's owner and teammates, each with their thread, unread
 * count and last message — or with nulls if nobody has written to them yet.
 */
const listCustomerContacts = asyncHandler(async (req, res) => {
  const query = validateCompanyQuery(req.query);

  const data = await chatService.listCustomerContacts({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Customer chats retrieved.',
    data,
  });
});

/**
 * GET /chat/contacts/specialists?companyId=&search=
 *
 * Section two. A separate endpoint rather than one response carrying both, for
 * the same reason the email picker splits them: the two sections are opened
 * independently, and a caller after specialists should not pay for the customer
 * query.
 */
const listSpecialistContacts = asyncHandler(async (req, res) => {
  const query = validateCompanyQuery(req.query);

  const data = await chatService.listSpecialistContacts({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialist chats retrieved.',
    data,
  });
});

/* -------------------------------------------------------------------------- */
/* threads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * GET /chat/conversations?companyId=
 *
 * Every thread on one company the caller is a side of. What the customer and
 * specialist portals open with, and what an accounting manager sees as their own
 * inbox for that account.
 */
const listConversations = asyncHandler(async (req, res) => {
  const query = validateCompanyQuery(req.query);

  const data = await chatService.listConversations({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Conversations retrieved.',
    data,
  });
});

/**
 * POST /chat/conversations — `{ companyId, participantUserId? }`
 *
 * 200, NOT 201, and idempotent: opening a chat window is not a creation event
 * the user thinks about, and clicking the same person twice must not be an
 * error. The caller cannot tell whether the row already existed, and should not
 * have to.
 */
const openConversation = asyncHandler(async (req, res) => {
  const body = validateOpenConversation(req.body);

  const data = await chatService.openConversation({
    userId: req.user.id,
    requestId: req.id,
    body,
  });

  return res.status(200).json({
    success: true,
    message: 'Conversation ready.',
    data,
  });
});

/**
 * GET /chat/conversations/:conversationId/messages?limit=&before=&after=
 *
 * One page of a thread, newest first. `before` scrolls back through history;
 * `after` catches up on what arrived while the live connection was down.
 */
const listMessages = asyncHandler(async (req, res) => {
  const conversationId = common.parseId(req.params.conversationId, 'conversationId');
  const query = validateMessageListQuery(req.query);

  const data = await chatService.listMessages({
    userId: req.user.id,
    requestId: req.id,
    conversationId,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Messages retrieved.',
    data,
  });
});

/**
 * POST /chat/conversations/:conversationId/messages — `{ body?, files? }`
 *
 * 201 with the stored message, including its derived receiver and its
 * attachments. The other side's screen updates from Supabase Realtime rather
 * than from this response — see chatRealtimeService.
 */
const sendMessage = asyncHandler(async (req, res) => {
  const conversationId = common.parseId(req.params.conversationId, 'conversationId');
  const body = validateSendMessage(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
  });

  const data = await chatService.sendMessage({
    userId: req.user.id,
    requestId: req.id,
    conversationId,
    body,
  });

  return res.status(201).json({
    success: true,
    message: 'Message sent.',
    data,
  });
});

/**
 * POST /chat/conversations/:conversationId/read — `{ upToMessageId? }`
 *
 * Returns the count that was stamped AND the badge's new value, so the client
 * sets its badge from the server's answer rather than assuming zero — the two
 * differ whenever a message lands between the render and this call.
 */
const markRead = asyncHandler(async (req, res) => {
  const conversationId = common.parseId(req.params.conversationId, 'conversationId');
  const { upToMessageId } = validateMarkRead(req.body);

  const data = await chatService.markRead({
    userId: req.user.id,
    requestId: req.id,
    conversationId,
    upToMessageId,
  });

  return res.status(200).json({
    success: true,
    message: 'Marked as read.',
    data,
  });
});

/**
 * DELETE /chat/messages/:messageId
 *
 * Soft delete, sender only. 200 rather than 204 because the response carries the
 * thread the message was in, which is what the client needs to update the right
 * window without guessing.
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const messageId = parseMessageId(req.params.messageId);

  const data = await chatService.deleteMessage({
    userId: req.user.id,
    requestId: req.id,
    messageId,
  });

  return res.status(200).json({
    success: true,
    message: 'Message deleted.',
    data,
  });
});

/** GET /chat/unread-count?companyId= — the nav badge. */
const unreadCount = asyncHandler(async (req, res) => {
  const query = validateCompanyQuery(req.query);

  const data = await chatService.unreadCount({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Unread count retrieved.',
    data,
  });
});

/* -------------------------------------------------------------------------- */
/* attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * POST /chat/attachments/upload-url —
 * `{ conversationId, files: [{ fileName, mimeType, sizeBytes }] }`
 *
 * 201: a ticket is a thing that now exists and can be used once. The bytes never
 * pass through this API — see chatService.createUploadTickets.
 */
const requestUploadUrls = asyncHandler(async (req, res) => {
  const { conversationId, files } = validateUploadTicketRequest(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
    maxBytes: config.uploads.maxDocumentBytes,
    isAllowedMimeType,
    acceptedLabel: ACCEPTED_LABEL,
  });

  const data = await chatService.createUploadTickets({
    userId: req.user.id,
    requestId: req.id,
    conversationId,
    files,
  });

  return res.status(201).json({
    success: true,
    message: data.uploads.length === 1 ? 'Upload ready.' : `${data.uploads.length} uploads ready.`,
    data,
  });
});

/**
 * GET /chat/attachments/:attachmentId/download-url
 *
 * A short-lived signed link, not the bytes, and not a redirect either: the
 * client may be rendering an inline image preview rather than starting a
 * download, and a 302 forces one behaviour on both. Returning the URL lets the
 * caller decide, and keeps the response shape the same for every file type.
 */
const requestDownloadUrl = asyncHandler(async (req, res) => {
  const attachmentId = common.parseId(req.params.attachmentId, 'attachmentId');

  const data = await chatService.createDownloadLink({
    userId: req.user.id,
    requestId: req.id,
    attachmentId,
  });

  return res.status(200).json({
    success: true,
    message: 'Download link ready.',
    data,
  });
});

/* -------------------------------------------------------------------------- */
/* live updates                                                               */
/* -------------------------------------------------------------------------- */

/**
 * GET /chat/realtime-token
 *
 * The credential the browser opens its live chat connection with. Read-only, and
 * signed with the SUPABASE project secret rather than this API's — it opens
 * nothing here. See chatRealtimeService for the whole reasoning, and
 * db/schema/21_add_chat_realtime.sql for the policies that bound it.
 *
 * NO companyId, deliberately. The token identifies a PERSON, and the RLS
 * policies already limit what that person can see to threads they are a side of
 * — across every company they are on. Scoping the token per company would mean a
 * fresh token, and a fresh socket, every time the user switched accounts in the
 * company picker.
 */
const issueRealtimeToken = asyncHandler(async (req, res) => {
  const data = chatRealtimeService.issueRealtimeToken({ userId: req.user.id });

  return res.status(200).json({
    success: true,
    message: 'Realtime token issued.',
    data,
  });
});

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
  requestUploadUrls,
  requestDownloadUrl,
  issueRealtimeToken,
};
