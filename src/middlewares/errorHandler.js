'use strict';

const config = require('../config');
const logger = require('../utils/logger');

/**
 * Central error handler. Must be registered last, after all routes.
 * Sends a consistent JSON error shape and hides internals in production.
 */
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    logger.error(err.stack || err.message);
  } else {
    logger.warn(`${statusCode} ${err.message}`);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message: isServerError && config.isProduction
        ? 'Internal server error'
        : err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(config.isProduction ? {} : { stack: err.stack }),
    },
  });
};
