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

/** Whether a client-declared type may be uploaded at all. */
function isAllowedMimeType(mimeType) {
  return Boolean(EXTENSION_BY_MIME[mimeType]);
}

module.exports = { EXTENSION_BY_MIME, ACCEPTED_LABEL, documentKey, isAllowedMimeType };
