'use strict';

const config = require('../config');
const storage = require('../utils/storage');

/**
 * Response shapes for the caller's own profile.
 *
 * The one job worth stating: `avatarKey` never leaves this file. The database
 * stores a key ("avatars/18/9f3c2a.jpg"), the client needs a URL, and the
 * translation happens here — in exactly one place. That is what made moving the
 * pictures off local disk and into a Supabase bucket an edit to this one
 * function: the stored keys did not change, only what they resolve to. Ship the
 * raw key to the client and every frontend gains its own copy of the rule for
 * turning it into a URL, and then you cannot move the files at all.
 */

/**
 * Absolute URL for a stored avatar key, or null when the user has no picture.
 *
 * Public either way — the avatars bucket is public and so is the local uploads
 * folder — because an <img src> cannot send an Authorization header. Safe
 * because the filename is 32 random hex characters and nothing confidential is
 * ever written there. Documents are the opposite case and go out through an
 * authorized route instead; see dto/projectDocumentDto.
 */
function avatarUrl(avatarKey) {
  return storage.publicUrl({ bucket: config.storage.avatarBucket, key: avatarKey });
}

/** An address row as the client sees it. Mirrors dto/companyDto.toAddress. */
function toAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    addressLine1: address.line1,
    addressLine2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    country: address.country,
    countryCode: address.countryCode ?? null,
  };
}

/**
 * The caller's own profile: who they are, how to reach them, where they are, and
 * their picture. Returned by GET /users/me and by every write that changes it,
 * so the client can replace its copy from the response instead of refetching.
 *
 * Login-security columns (password hash, failed attempts, lock, last-login IP)
 * are absent by construction — the repository's select does not fetch them.
 */
function toMe(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone ?? null,
    jobTitle: user.jobTitle ?? null,
    status: user.status,
    role: user.role?.code ?? null,
    specificRole: user.specificRole?.code ?? null,
    avatarUrl: avatarUrl(user.avatarKey),
    // null until onboarding (or this endpoint) collects one — the frontend must
    // handle its absence, since a user row exists long before an address does.
    address: toAddress(user.address),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

module.exports = { toMe, toAddress, avatarUrl };
