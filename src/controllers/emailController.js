'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const config = require('../config');
const common = require('../validators/common');
const {
  validateRecipientQuery,
  validateSendMessage,
  validateUploadTicketRequest,
} = require('../validators/emailValidator');
const { isAllowedMimeType, ACCEPTED_LABEL } = require('../utils/documentTypes');
const emailMessageService = require('../services/emailMessageService');

/**
 * HTTP layer for the email screen. Thin, like the other controllers here:
 * identity from req.user, ids from the URL, validate, delegate, wrap in the
 * envelope. Every access decision is in the service, where it can be made
 * against the database.
 */

/**
 * GET /emails/recipients/customers?companyId=&search=
 *
 * The customer side of the account: its owner AND its teammates, in one list.
 */
const listCustomerRecipients = asyncHandler(async (req, res) => {
  const query = validateRecipientQuery(req.query);

  const data = await emailMessageService.listCustomerRecipients({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Customers retrieved.',
    data,
  });
});

/**
 * GET /emails/recipients/specialists?companyId=&search=
 *
 * The specialists on the account — all three service lines, merged with any
 * live assignment rows.
 *
 * A SEPARATE ENDPOINT from the customer list rather than one response carrying
 * both. The two are different screens' worth of people and are picked
 * independently; a caller that wants only specialists should not pay for the
 * customer query, and a caller that wants both issues two requests it can fire
 * in parallel.
 */
const listSpecialistRecipients = asyncHandler(async (req, res) => {
  const query = validateRecipientQuery(req.query);

  const data = await emailMessageService.listSpecialistRecipients({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialists retrieved.',
    data,
  });
});

/**
 * GET /emails/recipients/accounting-managers?companyId=&search=
 *
 * The accounting manager on the account. A list of at most one — the schema
 * allows a single manager per company — returned as an array so all three
 * recipient endpoints answer in the same shape.
 */
const listAccountingManagerRecipients = asyncHandler(async (req, res) => {
  const query = validateRecipientQuery(req.query);

  const data = await emailMessageService.listAccountingManagerRecipients({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Accounting managers retrieved.',
    data,
  });
});

/**
 * POST /emails/attachments/upload-url
 *
 *   { companyId, files: [{ fileName, mimeType, sizeBytes }] }
 *
 * The browser says what it is about to send and gets one signed URL per file to
 * PUT it to. Nothing is recorded — the message that will carry these files does
 * not exist yet and will not until the send.
 *
 * NO `:messageId` IN THE PATH. There is no draft to hang the upload off, so the
 * body names the company instead and the storage key is scoped by the
 * authenticated sender.
 *
 * 201 rather than 200: the response is a set of newly minted, one-shot
 * capabilities that did not exist before the request.
 */
const requestUploadUrls = asyncHandler(async (req, res) => {
  const { companyId, files } = validateUploadTicketRequest(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
    maxBytes: config.uploads.maxDocumentBytes,
    isAllowedMimeType,
    acceptedLabel: ACCEPTED_LABEL,
  });

  const data = await emailMessageService.createUploadTickets({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    files,
  });

  return res.status(201).json({
    success: true,
    message: data.uploads.length === 1 ? 'Upload ready.' : `${data.uploads.length} uploads ready.`,
    data,
  });
});

/**
 * POST /emails — compose and send, in one call.
 *
 *   { companyId, subject, bodyHtml, to, cc?, bcc?, files? }
 *
 * The Send button, and the only write on this feature. 201 with the SENT message
 * on success — created, so 201 rather than 200, even though the interesting half
 * of what happened was the SMTP handshake.
 *
 * A 502 on transport failure, after the row has been marked FAILED so the screen
 * can show what went wrong and offer a retry.
 */
const sendNewMessage = asyncHandler(async (req, res) => {
  const body = validateSendMessage(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
  });

  const data = await emailMessageService.composeAndSend({
    userId: req.user.id,
    requestId: req.id,
    body,
  });

  return res.status(201).json({
    success: true,
    message: 'Message sent.',
    data,
  });
});

module.exports = {
  listCustomerRecipients,
  listSpecialistRecipients,
  listAccountingManagerRecipients,
  requestUploadUrls,
  sendNewMessage,
};
