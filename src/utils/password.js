'use strict';

const bcrypt = require('bcrypt');

const config = require('../config');

/**
 * Password hashing helpers. bcrypt is deliberate: it is slow by design and
 * salts each hash automatically, so identical passwords produce different
 * hashes and a stolen table cannot be brute-forced cheaply.
 */

/*
 * A throwaway hash used only to spend roughly one bcrypt.compare worth of time
 * when the submitted email matches no account. Without it, "no such user"
 * returns noticeably faster than "wrong password", which leaks which emails are
 * registered. Computed once at startup with the configured cost so its timing
 * tracks the real comparisons.
 */
const DUMMY_HASH = bcrypt.hashSync('finopsys-enumeration-guard', config.auth.bcryptRounds);

/** Hash a plaintext password. The returned string embeds the salt and cost. */
async function hashPassword(plain) {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

/**
 * Burn a comparable amount of time as a real password check when there is no
 * user to check against. Always resolves false. Call this on the
 * email-not-found branch of login so the response timing matches the
 * wrong-password branch.
 */
async function verifyPasswordDummy(plain) {
  await bcrypt.compare(String(plain), DUMMY_HASH);
  return false;
}

/**
 * Compare a plaintext password against a stored hash. Returns false (never
 * throws) for a null/blank hash, so a user who has no password set — e.g. one
 * still in the INVITED state — simply fails to authenticate.
 */
async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, verifyPassword, verifyPasswordDummy };
