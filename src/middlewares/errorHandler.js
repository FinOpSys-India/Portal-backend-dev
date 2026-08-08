'use strict';

const config = require('../config');
const logger = require('../utils/logger');

/*
 * Prisma reports expected conditions (duplicate email, bad foreign key) as
 * errors that would otherwise fall through as 500s. Translate the ones that
 * are really client mistakes into a status, a stable code, and a safe message.
 * https://www.prisma.io/docs/reference/api-reference/error-reference
 */
const PRISMA_ERROR_MAP = {
  P2000: { status: 400, code: 'VALIDATION_ERROR', message: (e) => `The value for ${fieldList(e)} is too long.` },
  P2002: { status: 409, code: 'CONFLICT', message: (e) => `A record with that ${fieldList(e)} already exists.` },
  P2003: { status: 400, code: 'VALIDATION_ERROR', message: () => 'A referenced record does not exist.' },
  P2025: { status: 404, code: 'NOT_FOUND', message: () => 'Record not found.' },
};

/*
 * Errors raised by body-parser (express.json / express.urlencoded) before any
 * route runs. Without these they fell through to the generic branch below and
 * were reported as 500 INTERNAL_ERROR — so malformed JSON, which is squarely a
 * client mistake, read to the client as "the server is broken" and to us as a
 * server fault worth paging about.
 */
const BODY_PARSER_ERROR_MAP = {
  'entity.parse.failed': {
    status: 400,
    code: 'MALFORMED_JSON',
    message: 'The request body is not valid JSON.',
  },
  'entity.too.large': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'The request body is too large.',
  },
  'request.aborted': {
    status: 400,
    code: 'REQUEST_ABORTED',
    message: 'The request was aborted before it completed.',
  },
  'encoding.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_ENCODING',
    message: 'The request content encoding is not supported.',
  },
  'entity.verify.failed': {
    status: 400,
    code: 'MALFORMED_JSON',
    message: 'The request body could not be verified.',
  },
};

// P2002/P2003 name the column(s) in meta.target; P2000 uses meta.column_name.
function fieldList(err) {
  const target = err?.meta?.target ?? err?.meta?.column_name;
  if (Array.isArray(target)) return target.join(', ');
  if (typeof target === 'string') return target;
  return 'value';
}

/**
 * Reduce any thrown value to the fields we are willing to send: an HTTP status,
 * a stable machine code, a client-safe message, and any structured extras the
 * throw site chose to attach. Anything unrecognised becomes a generic 500 so an
 * unexpected error never leaks its internals.
 */
function translate(err) {
  if (err.name === 'PrismaClientKnownRequestError' && PRISMA_ERROR_MAP[err.code]) {
    const mapped = PRISMA_ERROR_MAP[err.code];
    return { statusCode: mapped.status, code: mapped.code, message: mapped.message(err) };
  }
  if (err.name === 'PrismaClientValidationError') {
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Invalid request data.' };
  }
  if (err.type && BODY_PARSER_ERROR_MAP[err.type]) {
    const mapped = BODY_PARSER_ERROR_MAP[err.type];
    return { statusCode: mapped.status, code: mapped.code, message: mapped.message };
  }
  // Some body-parser versions surface a bare SyntaxError with a `body` property
  // rather than a typed error.
  if (err instanceof SyntaxError && 'body' in err) {
    return { statusCode: 400, code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' };
  }

  const statusCode = err.statusCode || err.status || 500;
  return {
    statusCode,
    code: err.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
    message: err.message,
    fields: err.fields,
    details: err.details,
    headers: err.headers,
  };
}

/**
 * Central error handler. Must be registered last, after all routes.
 * Emits one consistent JSON shape:
 *   { success: false, error: { code, message, requestId, fields?, details? } }
 * and hides server-error internals outside development.
 */
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  const { statusCode, code, message, fields, details, headers } = translate(err);
  const isServerError = statusCode >= 500;

  if (isServerError) {
    logger.error(`[${req.id}] ${err.stack || err.message}`);
  } else {
    logger.warn(`[${req.id}] ${statusCode} ${code} ${message}`);
  }

  if (headers) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }

  // Never surface a raw server-error message (which may carry a stack, a SQL
  // string, or a file path) outside development — send a fixed line instead.
  const safeMessage =
    isServerError && !config.exposeErrorDetails ? 'An unexpected error occurred.' : message;

  /*
   * The stack is gated on an EXPLICIT opt-in, not on `NODE_ENV !== 'production'`.
   * The old test was true whenever NODE_ENV was simply unset — which it was in
   * every deployment that had not thought to set it — so staging servers were
   * returning file paths and internal call frames to any client that could
   * trigger a 500. An absent variable should not be what decides this.
   */
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: safeMessage,
      requestId: req.id,
      ...(fields ? { fields } : {}),
      ...(details ? { details } : {}),
      ...(config.exposeErrorDetails && err.stack ? { stack: err.stack } : {}),
    },
  });
};
