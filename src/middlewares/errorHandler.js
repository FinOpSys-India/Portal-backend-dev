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
  const statusCode = err.statusCode || 500;
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
 * and hides server-error internals in production.
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
  // string, or a file path) in production — send a fixed line instead.
  const safeMessage =
    isServerError && config.isProduction ? 'An unexpected error occurred.' : message;

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: safeMessage,
      requestId: req.id,
      ...(fields ? { fields } : {}),
      ...(details ? { details } : {}),
      ...(config.isProduction ? {} : { stack: err.stack }),
    },
  });
};
