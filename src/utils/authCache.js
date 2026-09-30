'use strict';

/**
 * A short-lived, in-process cache of the user row requireAuth checks on every
 * authenticated request (status, password-change time, role).
 *
 * Against a remote database that read is a full network round trip on every
 * single API call. Holding it for a few seconds removes it from all but the
 * first request in each window.
 *
 * The trade-off is staleness, bounded by TTL_MS: a password reset, a role
 * change or a deactivation can take up to that long to reach an access token
 * already in use. Writes made by this process call invalidateAuthUser so they
 * apply at once here; another instance (or a manual database edit) catches up
 * when its entry expires.
 */
// Off under Jest: tests swap the mocked user row between cases that share an id.
const TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 30 * 1000;
const MAX_ENTRIES = 5000;

const entries = new Map();

function getAuthUser(userId) {
  const entry = entries.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(userId);
    return null;
  }
  return entry.row;
}

function setAuthUser(userId, row) {
  // Map keeps insertion order, so the first key is the oldest entry.
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  entries.set(userId, { row, expiresAt: Date.now() + TTL_MS });
}

/** Drop a user's cached row after changing their role, status or password. */
function invalidateAuthUser(userId) {
  entries.delete(userId);
}

module.exports = { getAuthUser, setAuthUser, invalidateAuthUser };
