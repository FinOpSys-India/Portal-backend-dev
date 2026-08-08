'use strict';

/**
 * Wraps an async route handler so rejected promises are forwarded to
 * Express's error handler instead of crashing the process.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
