'use strict';

const common = require('./common');
const ApiError = require('../utils/ApiError');

/**
 * Request validation for chat.
 *
 * Same division as every other validator here: this file decides whether the
 * REQUEST is well-formed, and the service decides whether it is ALLOWED. So
 * `participantUserId` is checked to be a positive integer here and checked to be
 * someone actually on the company there — the first question can be answered
 * from the request alone, the second cannot.
 */

const LIMITS = {
  /*
   * `chat_messages.body` is TEXT, so this is not a column width — it is a refusal
   * to accept a payload that would be pathological to store or render in a
   * scrolling window. 8 KB is several screens of typing; anything past it is a
   * paste accident, and a chat bubble is not where a 200 KB document belongs
   * (that is what the attachments are for).
   */
  body: 8_000,
  /*
   * Messages in one page. Fifty fills a tall window twice over, and the cap
   * matters because each row carries its sender and its attachments — a client
   * asking for a thousand would be asking for a megabyte of joined rows.
   */
  pageSize: 50,
  maxPageSize: 100,
};

/* -------------------------------------------------------------------------- */
/* cursors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A page cursor: `<createdAt ISO>|<message id>`, base64url.
 *
 * OPAQUE ON PURPOSE. What it encodes is a keyset position — the two columns the
 * ORDER BY uses — and encoding it means a client cannot hand-assemble one out of
 * a timestamp it invented, which would silently return a page from the middle of
 * somebody's thread. It also means the pair can gain a third column later
 * without a client noticing.
 *
 * It is NOT a security boundary and is not signed: every cursor a caller can
 * build names a position in a thread they have already been authorized to read,
 * because the conversation id is in the URL and checked separately. Signing it
 * would protect nothing.
 */
function encodeCursor({ createdAt, id }) {
  const raw = `${new Date(createdAt).toISOString()}|${id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(value, field) {
  const invalid = () =>
    new ApiError(400, `${field} is not a valid page cursor.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: 'Use the cursor returned by the previous page.' },
    });

  let raw;
  try {
    raw = Buffer.from(String(value), 'base64url').toString('utf8');
  } catch {
    throw invalid();
  }

  const at = raw.lastIndexOf('|');
  if (at <= 0) throw invalid();

  const createdAt = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);

  if (Number.isNaN(createdAt.getTime()) || !/^\d+$/.test(id)) throw invalid();

  /*
   * The id goes back as a BigInt, not a Number. `chat_messages.id` is BIGSERIAL,
   * so Prisma expects a BigInt in the WHERE clause, and converting through
   * Number would quietly lose precision above 2^53 — which is exactly the range
   * BIGSERIAL exists for.
   */
  return { createdAt, id: BigInt(id) };
}

/* -------------------------------------------------------------------------- */
/* queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `?companyId=&search=` — the two contact lists, the thread list, and the unread
 * badge.
 *
 * `companyId` is REQUIRED on every one of them, with no admin exemption, for the
 * reason the whole feature turns on: a chat list merged across companies would
 * put two clients' conversations on one screen.
 */
function validateCompanyQuery(query = {}) {
  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    // Absent means the whole list, which is what a screen asks for before the
    // user has typed anything.
    search: query.search ? common.str(query.search, 'search', { max: 120 }) : null,
  };
}

/**
 * `GET /chat/conversations/:id/messages?limit=&before=&after=`
 *
 * TWO CURSORS, AND THEY ARE NOT INTERCHANGEABLE. `before` pages backwards
 * through history as the user scrolls up. `after` fetches what arrived since a
 * known message — the reconnect path, for when the live subscription drops and
 * the window has to catch up. Sending both is a contradiction rather than an
 * intersection, so it is refused instead of being silently resolved one way.
 *
 * Neither is an offset. See chatRepository.listMessages for why a chat window
 * cannot page by offset.
 */
function validateMessageListQuery(query = {}) {
  common.rejectUnknown(query, ['limit', 'before', 'after'], 'query string');

  if (query.before && query.after) {
    throw new ApiError(400, 'Send either before or after, not both.', {
      code: 'VALIDATION_ERROR',
      fields: { before: 'Page backwards with before, or catch up with after.' },
    });
  }

  return {
    limit: common.integer(query.limit, 'limit', {
      min: 1,
      max: LIMITS.maxPageSize,
      required: false,
      defaultValue: LIMITS.pageSize,
    }),
    before: query.before ? decodeCursor(query.before, 'before') : null,
    after: query.after ? decodeCursor(query.after, 'after') : null,
  };
}

/* -------------------------------------------------------------------------- */
/* writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `POST /chat/conversations` — `{ companyId, participantUserId? }`
 *
 * `participantUserId` IS OPTIONAL, and its absence is a real request rather than
 * a lazy one. An accounting manager picks who to write to, so they send it. A
 * customer or a specialist has exactly one counterpart on a company — its
 * assigned accounting manager — and there is nothing for them to choose; the
 * service resolves it from `companies.accounting_manager_user_id`.
 *
 * Making it required would mean the customer's portal had to first fetch the
 * manager's user id in order to name it back to the server, which is a round
 * trip to tell the server something it already knows, and a value it would have
 * to re-check anyway.
 */
function validateOpenConversation(body = {}) {
  common.rejectUnknown(body, ['companyId', 'participantUserId']);
  common.requireFields(body, ['companyId']);

  return {
    companyId: common.parseId(body.companyId, 'companyId'),
    participantUserId:
      body.participantUserId === undefined || body.participantUserId === null
        ? null
        : common.parseId(body.participantUserId, 'participantUserId'),
  };
}

/**
 * The uploads being attached — `[{ key, fileName }]`.
 *
 * Identical in shape to emailValidator.attachedFiles, and `key` is
 * caller-supplied for the same narrow reason: it is a key this API generated and
 * signed a ticket for one call earlier. The service re-checks it against the
 * CONVERSATION's own prefix before it is used for anything (see
 * chatService.isKeyForConversation). Validating it here as a plain string is
 * correct; the authorization is not this file's job.
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

/**
 * `POST /chat/conversations/:id/messages` — `{ body?, files? }`
 *
 * NEITHER FIELD IS INDIVIDUALLY REQUIRED, and both cannot be absent. A message
 * is text, or files, or both — an attachment with no caption is an ordinary
 * thing to send, and so is a line of text with nothing attached. What is not a
 * message is neither.
 *
 * That rule cannot be a database CHECK, because it spans two tables; this is the
 * first of the two places it is enforced, and chatService re-checks it after the
 * uploads have been measured (a request whose only file turns out to be missing
 * from the bucket arrives here looking perfectly valid).
 *
 * A whitespace-only body is NOT text. It is trimmed to nothing and treated as
 * absent, which matches the column's `CHECK (body IS NULL OR length(btrim(body))
 * > 0)` — the alternative is a bubble containing a space, which no user meant to
 * send and the database would reject anyway.
 */
function validateSendMessage(body = {}, { maxFiles }) {
  common.rejectUnknown(body, ['body', 'files']);

  const files = attachedFiles(body.files, maxFiles);

  let text = null;
  if (body.body !== undefined && body.body !== null) {
    if (typeof body.body !== 'string' && typeof body.body !== 'number') {
      throw common.fieldError('body', 'body must be text.', 'Type a message.');
    }
    const trimmed = String(body.body).trim();
    if (trimmed.length > LIMITS.body) {
      throw common.fieldError(
        'body',
        `body cannot exceed ${LIMITS.body} characters.`,
        `Keep it under ${LIMITS.body} characters.`
      );
    }
    /*
     * Control characters are stripped rather than rejected, which is the one
     * place this validator is more forgiving than common.str — and the reason is
     * that people paste into a chat box. A pasted line from a spreadsheet or a
     * terminal carries tabs and carriage returns, and refusing the whole message
     * over one of them would be incomprehensible. Newlines and tabs are kept
     * (a chat message is multi-line by nature); everything else in the C0/C1
     * range goes.
     *
     * Nothing here goes into an HTTP or MIME header, unlike the email subject
     * line, so there is no injection to prevent — only rendering to protect.
     */
    // Checked numerically rather than with a character-class regex, so no raw
    // control byte is ever written into this source file — the same reason
    // validators/common.hasControlChars counts char codes. Newline and tab
    // survive; everything else in the C0/C1 range, and DEL, is dropped.
    const cleaned = [...trimmed.replace(/\r\n?/g, "\n")]
      .filter((ch) => {
        const code = ch.codePointAt(0);
        if (code === 0x0a || code === 0x09) return true;
        return code > 0x1f && code !== 0x7f;
      })
      .join("");
    text = cleaned.length ? cleaned : null;
  }

  if (!text && !files.length) {
    throw new ApiError(400, 'Type a message or attach a file.', {
      code: 'EMPTY_MESSAGE',
      fields: { body: 'Type a message or attach a file.' },
    });
  }

  return { body: text, files };
}

/**
 * `POST /chat/conversations/:id/read` — `{ upToMessageId? }`
 *
 * Optional, and absent means "everything in this thread". That is the honest
 * default for the common case — the user opened the window and read it — while
 * sending the id bounds the write to what was actually on screen, which matters
 * on a busy thread where messages land while the user is looking at it.
 *
 * Returned as a BigInt, for the reason given in `decodeCursor`.
 */
function validateMarkRead(body = {}) {
  common.rejectUnknown(body, ['upToMessageId']);

  if (body.upToMessageId === undefined || body.upToMessageId === null || body.upToMessageId === '') {
    return { upToMessageId: null };
  }

  const raw = String(body.upToMessageId).trim();
  if (!/^\d+$/.test(raw) || raw === '0') {
    throw common.fieldError('upToMessageId', 'upToMessageId must be a message id.', 'Invalid id.');
  }

  return { upToMessageId: BigInt(raw) };
}

/**
 * `POST /chat/attachments/upload-url` —
 * `{ conversationId, files: [{ fileName, mimeType, sizeBytes }] }`
 *
 * `conversationId` RATHER THAN `companyId`, which is the one place this differs
 * from its email counterpart, and it follows from the keys being scoped to the
 * thread: the object will land under `chat/<conversationId>/…`, so the caller
 * has to name the thread they are writing to and the service has to check they
 * are one of its two sides. The company comes from the thread; asking for it as
 * well would be a second copy of a fact that can only disagree.
 *
 * The declared size is checked against the per-file cap here so an oversized file
 * is refused BEFORE a ticket is issued and before a byte is uploaded. It is a
 * claim, not a measurement — the send re-reads the real size from the bucket,
 * which is what makes the cap enforceable rather than advisory.
 */
function validateUploadTicketRequest(body = {}, { maxFiles, maxBytes, isAllowedMimeType, acceptedLabel }) {
  common.rejectUnknown(body, ['conversationId', 'files']);
  common.requireFields(body, ['conversationId', 'files']);

  const conversationId = common.parseId(body.conversationId, 'conversationId');

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

  return { conversationId, files };
}

/* -------------------------------------------------------------------------- */
/* reactions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The emoji a message or file can carry: the frontend's REACTIONS keys, in its
 * order, and exactly the values of the `chat_reaction_kind` enum.
 */
const REACTIONS = ['like', 'laugh', 'sad', 'wow', 'love', 'thanks'];

/**
 * `attachmentId`, optional wherever it appears: absent means the reaction is on
 * the message itself, present means on that file. Whether the file is actually
 * on the message is the service's check, not this file's.
 */
function optionalAttachmentId(value) {
  if (value === undefined || value === null || value === '') return null;
  return common.parseId(value, 'attachmentId');
}

/**
 * `PUT /chat/messages/:id/reaction` — `{ reaction, attachmentId? }`
 *
 * NO USER ID IS ACCEPTED. Who reacted is the caller, from the verified token —
 * `rejectUnknown` turns away a body that tries to name anyone.
 *
 * Lower-cased by hand rather than through common.enumValue, which upper-cases:
 * these are the frontend's keys and are stored and returned exactly as sent.
 */
function validateSetReaction(body = {}) {
  common.rejectUnknown(body, ['reaction', 'attachmentId']);
  common.requireFields(body, ['reaction']);

  const reaction = String(body.reaction).trim().toLowerCase();
  if (!REACTIONS.includes(reaction)) {
    throw new ApiError(400, 'reaction is not a supported value.', {
      code: 'VALIDATION_ERROR',
      fields: { reaction: `Must be one of: ${REACTIONS.join(', ')}.` },
      details: { allowed: REACTIONS },
    });
  }

  return { reaction, attachmentId: optionalAttachmentId(body.attachmentId) };
}

/**
 * `?attachmentId=` on `DELETE /chat/messages/:id/reaction`. A query string
 * rather than a body, because some proxies and HTTP clients drop the body of a
 * DELETE.
 */
function validateReactionTarget(query = {}) {
  common.rejectUnknown(query, ['attachmentId'], 'query string');
  return { attachmentId: optionalAttachmentId(query.attachmentId) };
}

module.exports = {
  LIMITS,
  REACTIONS,
  encodeCursor,
  decodeCursor,
  validateCompanyQuery,
  validateMessageListQuery,
  validateOpenConversation,
  validateSendMessage,
  validateMarkRead,
  validateUploadTicketRequest,
  validateSetReaction,
  validateReactionTarget,
};
