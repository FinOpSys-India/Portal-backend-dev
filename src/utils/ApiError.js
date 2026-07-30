'use strict';

/**
 * A machine-readable error code for each HTTP status, used when a throw site
 * does not supply its own (e.g. the spec's INVALID_CREDENTIALS / INVALID_OTP).
 * Gives every error response a stable `code` the client can branch on without
 * parsing the human message.
 */
const DEFAULT_CODES = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Operational error with an attached HTTP status code. Throw this from
 * controllers/services and let the central error handler format the response.
 *
 * @param {number} statusCode HTTP status to send.
 * @param {string} message    Safe, client-facing message.
 * @param {object} [options]
 * @param {string} [options.code]    Stable error code; defaults from status.
 * @param {object} [options.fields]  Per-field validation messages ({ email: '…' }).
 * @param {object} [options.details] Extra structured context to echo back.
 * @param {object} [options.headers] Response headers to set (e.g. Retry-After).
 */
class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code || DEFAULT_CODES[statusCode] || 'INTERNAL_ERROR';
    this.fields = options.fields;
    this.details = options.details;
    this.headers = options.headers;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
