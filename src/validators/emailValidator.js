'use strict';

const common = require('./common');
const ApiError = require('../utils/ApiError');

/**
 * Request validation for the email screen.
 *
 * Same division as every other validator here: this file decides whether the
 * REQUEST is well-formed, and the service decides whether it is ALLOWED. So a
 * recipient id is checked to be a positive integer here and checked to be
 * someone on the company there — the first question can be answered from the
 * request alone, the second cannot.
 */

const LIMITS = {
  // `email_messages.subject` is VARCHAR(500).
  subject: 500,
  /*
   * The body is TEXT in the database, so this cap is not a column width — it is a
   * refusal to accept a payload that would be pathological to store, render or
   * mail. 100 KB of HTML is a very long email; a megabyte is a paste accident or
   * an attack.
   */
  bodyHtml: 100_000,
  /*
   * Recipients per header. Generous for a real message and low enough that one
   * request cannot address the entire user table — which matters because every
   * id is resolved against the database before the send.
   */
  recipients: 100,
};

/**
 * The subject line.
 *
 * NOT `common.str`, for one reason: that helper treats a blank value as missing
 * and throws, and a blank subject is a legal email. Mail clients send them and
 * mail servers accept them; refusing here would be this API inventing a rule the
 * protocol does not have. Blank is stored as an empty string — the column is NOT
 * NULL, and "" is a truthful "they did not write one".
 *
 * Control characters ARE rejected, and that check is not cosmetic: this string
 * goes into a `Subject:` MIME header, and a raw newline in a header is header
 * injection — the way an attacker appends their own `Bcc:` to somebody else's
 * message.
 */
function subjectLine(value, field = 'subject') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw common.fieldError(field, `${field} must be text.`, 'Enter a valid subject.');
  }

  const s = String(value).trim();
  if (s.length > LIMITS.subject) {
    throw common.fieldError(
      field,
      `${field} cannot exceed ${LIMITS.subject} characters.`,
      `Must be at most ${LIMITS.subject} characters.`
    );
  }
  if (common.hasControlChars(s)) {
    throw common.fieldError(field, `${field} contains invalid characters.`, 'Remove any line breaks.');
  }
  return s;
}

/**
 * The message body.
 *
 * ALSO NOT `common.str`, and for a different reason: that helper rejects every
 * control character, and HTML from a rich-text editor is full of newlines. Using
 * it here would reject essentially every real body — the field would work in a
 * test with a one-line string and fail on the first message anybody actually
 * wrote.
 *
 * So newline, carriage return and tab are permitted and the rest of the C0 range
 * is not. The distinction matters because this value is NOT header material —
 * it is the MIME body, where a newline is ordinary text — while a NUL or an
 * escape sequence has no business in HTML and is a sign of something other than
 * an editor on the other end.
 *
 * NOT SANITISED HERE, deliberately. Stripping script tags at the validator is a
 * false comfort: the string is stored, mailed, and rendered by a mail client
 * that already refuses script, and a half-sanitiser invites the belief that the
 * output is safe to inject into the portal's own DOM. If this body is ever
 * rendered in-app, it needs a real sanitiser at the point of render.
 */
function htmlBody(value, field = 'bodyHtml') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw common.fieldError(field, `${field} must be text.`, 'Enter a message.');
  }

  const s = value.trim();
  if (s.length > LIMITS.bodyHtml) {
    throw common.fieldError(
      field,
      `${field} cannot exceed ${LIMITS.bodyHtml} characters.`,
      'The message is too long.'
    );
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) {
    throw common.fieldError(field, `${field} contains invalid characters.`, 'Remove any control characters.');
  }
  return s;
}

/**
 * A list of user ids from the request body.
 *
 * Absent becomes `[]` rather than `undefined`, deliberately — the compose form
 * holds the complete state of its To/Cc/Bcc fields, so "not sent" and "empty"
 * are the same thing and collapsing them here means the service never has to
 * guess which one it was handed. The one place that distinction DOES matter is
 * PATCH, where the caller needs to know whether recipients were mentioned at
 * all; that check reads `body.to !== undefined` on the raw body before this runs.
 */
function idList(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ApiError(400, 'Choose at least one recipient.', {
        code: 'VALIDATION_ERROR',
        fields: { [field]: 'Choose who this message is for.' },
      });
    }
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, `${field} must be a list of user ids.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: 'Send a list of user ids.' },
    });
  }

  if (value.length > LIMITS.recipients) {
    throw new ApiError(400, `Send at most ${LIMITS.recipients} recipients per field.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: `No more than ${LIMITS.recipients} recipients.` },
      details: { requested: value.length, max: LIMITS.recipients },
    });
  }

  const ids = value.map((id, i) => common.parseId(id, `${field}[${i}]`));

  if (required && !ids.length) {
    throw new ApiError(400, 'Choose at least one recipient.', {
      code: 'VALIDATION_ERROR',
      fields: { [field]: 'Choose who this message is for.' },
    });
  }

  return ids;
}

/**
 * The uploads being attached to the message being sent — `[{ key, fileName }]`.
 *
 * Shared by nothing else, and optional: a message with no attachments sends in
 * one call with this field absent.
 *
 * `key` is caller-supplied, which is the exception this API makes nowhere except
 * here and the equivalent document endpoint. It is narrow on purpose: it is a key
 * this API generated and signed a ticket for one call earlier, and the service
 * re-checks it against the AUTHENTICATED SENDER's own prefix before it is used
 * for anything (emailMessageService.isKeyForSender). Validating it here as a
 * plain string is correct; the authorization is not this file's job.
 */
function attachedFiles(value, maxFiles) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new ApiError(400, 'files must be a list of uploads.', {
      code: 'VALIDATION_ERROR',
      fields: { files: 'Send a list of { key, fileName }.' },
    });
  }

  if (value.length > maxFiles) {
    throw new ApiError(400, `Attach at most ${maxFiles} files.`, {
      code: 'VALIDATION_ERROR',
      fields: { files: `Send no more than ${maxFiles} files.` },
      details: { requested: value.length, maxFiles },
    });
  }

  const seen = new Set();
  return value.map((file, i) => {
    const at = `files[${i}]`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApiError(400, `${at} must be an object.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Each entry needs key and fileName.' },
      });
    }
    common.rejectUnknown(file, ['key', 'fileName'], at);

    const key = common.str(file.key, `${at}.key`, { max: 512 });

    // The same key twice would attach one object as two files and then break on
    // the unique index — a 500 for what is really a malformed request.
    if (seen.has(key)) {
      throw new ApiError(400, 'The same upload was sent twice.', {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Each upload may be attached once.' },
        details: { key },
      });
    }
    seen.add(key);

    return { key, fileName: common.str(file.fileName, `${at}.fileName`, { max: 255 }) };
  });
}

/** GET /emails/recipients?companyId=&search= */
function validateRecipientQuery(query = {}) {
  const companyId = common.parseId(query.companyId, 'companyId');
  return {
    companyId,
    // Optional. Absent means the whole picker, which is what a screen asks for
    // before the user has typed anything.
    search: query.search ? common.str(query.search, 'search', { max: 120 }) : null,
  };
}

/**
 * POST /emails — compose and send, in one call.
 *
 *   { companyId, subject, bodyHtml, to, cc?, bcc?, files? }
 *
 * THE ONLY WRITE ENDPOINT ON THIS FEATURE. There is no draft to create first and
 * nothing to edit afterwards, so every rule a send depends on is checked here
 * rather than spread across a create step and a send step:
 *
 *   - `to` is REQUIRED and must name at least one person. It used to be optional,
 *     because a draft with no recipients yet was a normal thing to save. Nothing
 *     is saved before the send now, so an empty To is simply a message with
 *     nowhere to go — a 400, not a state to store.
 *   - `subject` and `bodyHtml` are required as keys because both columns are NOT
 *     NULL. Either may be an empty string; see `subjectLine` and `htmlBody`.
 *   - `files` is optional, and its absence is the no-attachment path: one request
 *     and the message is gone.
 */
function validateSendMessage(body = {}, { maxFiles }) {
  common.rejectUnknown(body, ['companyId', 'subject', 'bodyHtml', 'to', 'cc', 'bcc', 'files']);
  common.requireFields(body, ['companyId', 'subject', 'bodyHtml', 'to']);

  return {
    companyId: common.parseId(body.companyId, 'companyId'),
    subject: subjectLine(body.subject),
    bodyHtml: htmlBody(body.bodyHtml),
    to: idList(body.to, 'to', { required: true }),
    cc: idList(body.cc, 'cc'),
    bcc: idList(body.bcc, 'bcc'),
    files: attachedFiles(body.files, maxFiles),
  };
}

/**
 * POST /emails/attachments/upload-url
 *
 *   { companyId, files: [{ fileName, mimeType, sizeBytes }] }
 *
 * The declared size is checked against the per-file cap here so an oversized file
 * is refused BEFORE a ticket is issued and before a byte is uploaded. It is a
 * claim, not a measurement — `POST /emails` re-reads the real size from the
 * bucket, which is what makes the cap enforceable rather than advisory.
 *
 * `companyId` IS in this body, and it is the piece that used to be free. The URL
 * carried a message id, and that id named the company; with no draft there is no
 * id, so the caller has to say which account they are writing to and the service
 * has to check they may reach it. Without it this endpoint would hand a signed
 * write ticket to any authenticated user for no stated account at all.
 */
function validateUploadTicketRequest(body = {}, { maxFiles, maxBytes, isAllowedMimeType, acceptedLabel }) {
  common.rejectUnknown(body, ['companyId', 'files']);
  common.requireFields(body, ['companyId', 'files']);

  const companyId = common.parseId(body.companyId, 'companyId');

  if (!Array.isArray(body.files) || !body.files.length) {
    throw new ApiError(400, 'Send the files you intend to attach.', {
      code: 'VALIDATION_ERROR',
      fields: { files: 'Send a list of { fileName, mimeType, sizeBytes }.' },
    });
  }

  if (body.files.length > maxFiles) {
    throw new ApiError(400, `Attach at most ${maxFiles} files at a time.`, {
      code: 'VALIDATION_ERROR',
      fields: { files: `Send no more than ${maxFiles} files.` },
      details: { requested: body.files.length, maxFiles },
    });
  }

  const files = body.files.map((file, i) => {
    const at = `files[${i}]`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApiError(400, `${at} must be an object.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Each entry needs fileName, mimeType and sizeBytes.' },
      });
    }
    common.rejectUnknown(file, ['fileName', 'mimeType', 'sizeBytes'], at);

    const mimeType = common.str(file.mimeType, `${at}.mimeType`, { max: 255 });
    if (!isAllowedMimeType(mimeType)) {
      throw new ApiError(415, `Only ${acceptedLabel} files are accepted.`, {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        fields: { files: `Attach a ${acceptedLabel} file.` },
        // Which file was wrong, because a selection of twelve that fails needs to
        // name the offender.
        details: { fileName: file.fileName, mimeType },
      });
    }

    const sizeBytes = Number(file.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ApiError(400, `${at}.sizeBytes must be a positive whole number of bytes.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Send each file size in bytes.' },
      });
    }
    if (sizeBytes > maxBytes) {
      const mb = Math.round(maxBytes / (1024 * 1024));
      throw new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
        code: 'FILE_TOO_LARGE',
        fields: { files: `Each file must be under ${mb} MB.` },
        details: { fileName: file.fileName, sizeBytes, maxBytes },
      });
    }

    return {
      fileName: common.str(file.fileName, `${at}.fileName`, { max: 255 }),
      mimeType,
      sizeBytes,
    };
  });

  return { companyId, files };
}

module.exports = {
  LIMITS,
  validateRecipientQuery,
  validateSendMessage,
  validateUploadTicketRequest,
};
