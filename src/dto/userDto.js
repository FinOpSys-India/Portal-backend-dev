'use strict';

const config = require('../config');

/**
 * Response shapes for the caller's own profile.
 *
 * The one job worth stating: `avatarKey` never leaves this file. The database
 * stores a key ("avatars/18/9f3c2a.jpg"), the client needs a URL, and the
 * translation happens here — in exactly one place — so moving the files to a CDN
 * or a signed-URL bucket later is an edit to `avatarUrl()` and nothing else. Ship
 * the raw key to the client and every frontend gains its own copy of the rule
 * for turning it into a URL, and then you cannot move the files at all.
 */

/** Absolute URL for a stored avatar key, or null when the user has no picture. */
function avatarUrl(avatarKey) {
  if (!avatarKey) return null;
  return `${config.uploads.publicBaseUrl}${config.uploads.publicPath}/${avatarKey}`;
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
