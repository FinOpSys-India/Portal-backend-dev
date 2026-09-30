'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * A per-request cache for the authenticated caller's own user row.
 *
 * requireAuth already reads the caller's row on every request, and then the
 * services read it again (loadCaller) to learn the caller's role. Against a
 * remote database each of those reads is a full network round trip. requireAuth
 * stores what it read here, and the services reuse it instead of asking again.
 *
 * Services only receive a userId, not the request, which is why this lives in
 * AsyncLocalStorage rather than on `req`. The store is created fresh for every
 * request and dies with it, so nothing is shared between requests. A lookup
 * only hits when the ids match; anything else — no store, a different user —
 * returns null and the caller falls back to the database, so a miss is always
 * safe.
 */
const storage = new AsyncLocalStorage();

/** Express middleware: give this request its own empty cache. */
function requestCacheMiddleware(req, res, next) {
  storage.run({ caller: null }, next);
}

/** Remember the caller row (USER_ROLE_SELECT shape) for the rest of the request. */
function setCachedCaller(caller) {
  const store = storage.getStore();
  if (store && caller) store.caller = caller;
}

/** The cached caller row for this user id, or null. */
function getCachedCaller(userId) {
  const store = storage.getStore();
  return store?.caller && store.caller.id === userId ? store.caller : null;
}

module.exports = { requestCacheMiddleware, setCachedCaller, getCachedCaller };
