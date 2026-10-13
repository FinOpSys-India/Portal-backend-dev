'use strict';

const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-request scratch space, reachable from any code running on behalf of the
 * request without threading `req` through every service signature.
 *
 * It exists for one reason: the database is a full network round trip away, and
 * requireAuth already reads the caller's user row. Services that need the same
 * row (`loadCaller`) pick it up from here instead of querying for it again.
 *
 * Outside a request (scripts, the billing sweep, tests that call a service
 * directly) there is no store, every getter returns undefined, and callers fall
 * back to querying as before.
 */
const storage = new AsyncLocalStorage();

/** Express middleware: open a fresh store for the lifetime of the request. */
function requestContext(req, res, next) {
  storage.run({}, next);
}

/**
 * Remember the caller row requireAuth loaded. It must carry the fields of
 * companyRepository.USER_ROLE_SELECT, since loadCaller hands it out in place of
 * that query's result.
 */
function setCaller(caller) {
  const store = storage.getStore();
  if (store) store.caller = caller;
}

/** The caller row for `userId` loaded earlier in this request, if any. */
function getCaller(userId) {
  const caller = storage.getStore()?.caller;
  return caller && caller.id === userId ? caller : undefined;
}

module.exports = { requestContext, setCaller, getCaller };
