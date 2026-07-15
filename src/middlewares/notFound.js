'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Catch-all for unmatched routes. Forwards a 404 to the error handler.
 */
module.exports = function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};
