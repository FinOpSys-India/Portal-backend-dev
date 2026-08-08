'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const multer = require('multer');

const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * The multipart parser for POST /projects/:projectId/documents.
 *
 * It follows the same three rules as uploadAvatar — generated filename,
 * extension from the MIME allowlist, size capped by multer itself — for the same
 * reasons, and adds two that only apply here.
 *
 *   4. Files land under `config.uploads.documentsDir`, NOT under
 *      `config.uploads.dir`. The latter is served by express.static to anyone
 *      with the URL; these are a company's financial records. See the comment on
 *      `documentsDir` in config/index.js.
 *
 *   5. The destination folder is keyed by `:projectId`, which is a URL segment
 *      and therefore attacker-controlled. It is re-checked against /^\d+$/ HERE,
 *      before it is ever joined into a path — the route's validator runs in the
 *      controller, which is AFTER this middleware has already written the file.
 *      "../../src" is a perfectly valid URL segment and would otherwise become a
 *      perfectly valid directory.
 *
 * WHAT THIS MIDDLEWARE DOES NOT DO is decide whether the caller may upload to
 * this project. That is per-record and needs the database (is the project real,
 * is it this company's, is the caller on that company), so it lives in the
 * service like every other authorization rule in this codebase. The consequence
 * is that bytes reach disk just before a request that turns out to be a 403 —
 * which is why projectDocumentService unlinks them on every failure path, and
 * why the route is rate-limited ahead of this parser.
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

const FIELD_NAME = 'documents';

/** The human list, used in every error this file raises. */
const ACCEPTED_LABEL = 'PDF, Word, Excel, CSV, plain text, or an image';

const PROJECT_ID_PATTERN = /^\d+$/;

/**
 * Where one project's files live: `<documentsDir>/projects/<projectId>/`.
 *
 * Per-project rather than one flat folder, for the same reason avatars are
 * per-user: it keeps a directory from growing to a million entries, and it makes
 * "remove everything belonging to this project" a single recursive delete.
 */
function projectDir(projectId) {
  return path.join(config.uploads.documentsDir, 'projects', String(projectId));
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const { projectId } = req.params;
    if (!PROJECT_ID_PATTERN.test(String(projectId ?? ''))) {
      return cb(
        new ApiError(400, 'projectId must be a positive integer.', {
          code: 'VALIDATION_ERROR',
          fields: { projectId: 'Select a project.' },
        })
      );
    }
    const dir = projectDir(projectId);
    return fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    const ext = EXTENSION_BY_MIME[file.mimetype];
    // 32 hex characters. The name the user chose is kept in the database as
    // `original_name` and shown back to them; it is never what the bytes are
    // stored under, so two people uploading "invoice.pdf" cannot collide and
    // nothing in a filename can escape the folder.
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});

const parser = multer({
  storage,
  limits: {
    fileSize: config.uploads.maxDocumentBytes,
    files: config.uploads.maxDocumentsPerRequest,
    /*
     * Unlike the avatar route, text parts ARE expected here: the form posts
     * `companyId` alongside the files. Two is one more than that endpoint needs,
     * which leaves room for a client that also sends `projectId` in the body
     * even though the URL already carries it — the validator rejects anything
     * beyond the allowlist with a named error, which is a better answer than
     * multer's opaque LIMIT_FIELD_COUNT.
     */
    fields: 4,
  },
  fileFilter(req, file, cb) {
    if (!EXTENSION_BY_MIME[file.mimetype]) {
      return cb(
        new ApiError(415, `Only ${ACCEPTED_LABEL} files are accepted.`, {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          fields: { [FIELD_NAME]: `Upload a ${ACCEPTED_LABEL} file.` },
          // The rejected name is echoed back because a drag-and-drop of twelve
          // files that fails needs to say WHICH one was wrong.
          details: { fileName: file.originalname, mimeType: file.mimetype },
        })
      );
    }
    return cb(null, true);
  },
}).array(FIELD_NAME, config.uploads.maxDocumentsPerRequest);

/**
 * Translate multer's own errors into this API's envelope.
 *
 * Same reasoning as uploadAvatar: left alone, a MulterError reaches the central
 * handler as an unrecognised exception and is reported as a 500 — telling
 * somebody who attached a 40 MB scan that the server broke, when the server did
 * exactly what it was built to do.
 */
function parseDocumentUpload(req, res, next) {
  parser(req, res, (err) => {
    if (!err) {
      if (!req.files || !req.files.length) {
        return next(
          new ApiError(400, 'No document was uploaded.', {
            code: 'VALIDATION_ERROR',
            fields: { [FIELD_NAME]: `Attach at least one file in the "${FIELD_NAME}" field.` },
          })
        );
      }
      return next();
    }

    if (err instanceof multer.MulterError) {
      const mb = Math.round(config.uploads.maxDocumentBytes / (1024 * 1024));
      const max = config.uploads.maxDocumentsPerRequest;

      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          return next(
            new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
              code: 'FILE_TOO_LARGE',
              fields: { [FIELD_NAME]: `Each file must be under ${mb} MB.` },
            })
          );
        case 'LIMIT_FILE_COUNT':
          return next(
            new ApiError(400, `Upload at most ${max} files at a time.`, {
              code: 'VALIDATION_ERROR',
              fields: { [FIELD_NAME]: `Attach no more than ${max} files.` },
            })
          );
        case 'LIMIT_UNEXPECTED_FILE':
          return next(
            new ApiError(400, `Send files in the "${FIELD_NAME}" field.`, {
              code: 'VALIDATION_ERROR',
              fields: { [FIELD_NAME]: `Attach the files as "${FIELD_NAME}".` },
            })
          );
        case 'LIMIT_FIELD_COUNT':
        case 'LIMIT_PART_COUNT':
          return next(
            new ApiError(400, 'The form carries more fields than this endpoint accepts.', {
              code: 'VALIDATION_ERROR',
              fields: { companyId: 'Send companyId and the files, and nothing else.' },
            })
          );
        default:
          return next(
            new ApiError(400, 'The upload could not be read.', {
              code: 'VALIDATION_ERROR',
              details: { reason: err.code },
            })
          );
      }
    }

    return next(err);
  });
}

module.exports = {
  parseDocumentUpload,
  EXTENSION_BY_MIME,
  ACCEPTED_LABEL,
  FIELD_NAME,
  projectDir,
};
