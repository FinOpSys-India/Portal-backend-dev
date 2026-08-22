'use strict';

const crypto = require('crypto');

const storage = require('./storage');

/**
 * What a project document may be, and what it is stored under.
 *
 * These two rules used to live inside the multipart parser, because that was
 * where a file first became something this API had an opinion about. There is no
 * parser any more: a document is uploaded straight to the bucket by the browser,
 * and the API's only contact with it is deciding — before a signed ticket is
 * issued — which types are allowed and which key the bytes will land under.
 *
 * So they are a pair of plain rules now rather than middleware, and they are
 * applied at exactly one moment: projectDocumentService.createUploadTickets. The
 * confirm step reads them back the other way (extension → type) to record what
 * the object really is, which is why the extension in the key has to be derived
 * from this table and never from the name the user chose.
 */

/*
 * What an accounting portal actually receives: statements and returns (PDF),
 * ledgers and workbooks (Excel/CSV), letters (Word), photographed receipts
 * (JPEG/PNG/WebP), and the occasional plain-text export.
 *
 * Absent on purpose: SVG and HTML (documents that can carry script), and every
 * archive and executable format. An allowlist rather than a blocklist, so a
 * format nobody considered is refused rather than accepted.
 */
const EXTENSION_BY_MIME = {
  'application/pdf': '.pdf',

  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  // Phone cameras on iOS default to this.
  'image/heic': '.heic',

  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',

  'text/csv': '.csv',
  'text/plain': '.txt',
};

/** The human list, used in every error raised about an unacceptable type. */
const ACCEPTED_LABEL = 'PDF, Word, Excel, CSV, plain text, or an image';

/**
 * The storage key for one document: `projects/<projectId>/<random><ext>`.
 *
 * Per-project rather than one flat prefix, for the same reason avatars are
 * per-user: it keeps a single listing from growing to a million entries, and it
 * makes "remove everything belonging to this project" one prefixed delete.
 *
 * The filename is 32 random hex characters and the extension comes from the MIME
 * allowlist, never from the upload. The name the user chose is kept in the
 * database as `original_name` and shown back to them; it is never what the bytes
 * are stored under, so two people uploading "invoice.pdf" cannot collide and
 * nothing in a filename can escape the prefix.
 *
 * THE SHAPE IS ALSO A CHECK, not just a convention. Because the browser now
 * uploads without this API seeing the bytes, the confirm call that follows has to
 * prove the key it names is one we issued for that project — which it does by
 * matching this exact form. A key that could be anything would make that
 * impossible. See projectDocumentService.isKeyForProject.
 *
 * `projectId` must already be a validated integer; the caller parses it from the
 * URL before anything reaches here.
 */
function documentKey(projectId, mimeType) {
  const ext = EXTENSION_BY_MIME[mimeType] ?? '';
  return storage.keyFor('projects', projectId, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

/**
 * The storage key for one email attachment:
 * `emails/outbox/<senderUserId>/<random><ext>`.
 *
 * Same shape and same reasoning as `documentKey` above — random name, extension
 * from the allowlist — with one deliberate difference: the prefix names the
 * SENDER, not the message.
 *
 * IT HAS TO. There is no message to name. The compose screen sends in a single
 * `POST /emails` that creates the row and hands it to SMTP in the same request,
 * so at the moment a file is uploaded no id exists yet — and inventing a
 * placeholder prefix would mean copying every byte to a real one afterwards.
 *
 * The sender is what makes the key CHECKABLE, which is the job the message id
 * used to do. `POST /emails` re-derives this prefix from the authenticated user
 * and refuses any key that does not match it, so a caller cannot attach an object
 * somebody else uploaded. See emailMessageService.isKeyForSender.
 *
 * `senderUserId` comes from the verified token, never from the request body.
 */
function emailAttachmentKey(senderUserId, mimeType) {
  const ext = EXTENSION_BY_MIME[mimeType] ?? '';
  return storage.keyFor('emails', 'outbox', senderUserId, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

/**
 * The storage key for one chat attachment:
 * `chat/<conversationId>/<random><ext>`.
 *
 * Same shape and reasoning as the two above — random name, extension from the
 * allowlist — and the prefix names the CONVERSATION, which is the one identifier
 * that already exists when a file is uploaded. Unlike an email attachment there
 * IS something to hang it off: a thread is opened before anything is typed in
 * it, so the upload can be scoped to the thread rather than to the sender.
 *
 * Scoping it to the thread is also what makes the key checkable at send time
 * without trusting the client: `POST /chat/conversations/:id/messages` rebuilds
 * this prefix from the id in its own URL — which it has already authorized the
 * caller against — and refuses any key that does not match. A key scoped to the
 * sender instead would let someone attach a file they uploaded for one client's
 * thread to a different client's thread. See chatService.isKeyForConversation.
 *
 * `conversationId` must already be a validated integer.
 */
function chatAttachmentKey(conversationId, mimeType) {
  const ext = EXTENSION_BY_MIME[mimeType] ?? '';
  return storage.keyFor('chat', conversationId, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

/** Whether a client-declared type may be uploaded at all. */
function isAllowedMimeType(mimeType) {
  return Boolean(EXTENSION_BY_MIME[mimeType]);
}

module.exports = {
  EXTENSION_BY_MIME,
  ACCEPTED_LABEL,
  documentKey,
  emailAttachmentKey,
  chatAttachmentKey,
  isAllowedMimeType,
};
