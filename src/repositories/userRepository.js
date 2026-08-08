'use strict';

/**
 * Data access for the caller's own profile.
 *
 * Every function takes the Prisma client as its first argument — `prisma` for a
 * standalone read, or the transaction client `tx` inside `$transaction` — which
 * is the same convention repositories/companyRepository follows, and is what
 * lets the profile update below write the address and the user row in one
 * atomic unit without this file knowing whether it is in a transaction.
 */

/**
 * The columns that make up a profile response.
 *
 * An allowlist, not an exclusion list: `passwordHash`, `failedLoginAttempts`,
 * `lockedUntil`, and `lastLoginIpHash` are not omitted here by remembering to
 * omit them — they are simply never named, so a column added to the model in
 * future is invisible to this endpoint until someone deliberately adds it.
 */
const ME_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  status: true,
  avatarKey: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
  address: {
    select: {
      id: true,
      line1: true,
      line2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      countryCode: true,
    },
  },
};

/** The caller's profile with role and address joined, or null if the row is gone. */
function findMe(client, userId) {
  return client.user.findUnique({ where: { id: userId }, select: ME_SELECT });
}

/** Just the two columns the write paths need to decide what to do. */
function findMeForUpdate(client, userId) {
  return client.user.findUnique({
    where: { id: userId },
    select: { id: true, addressId: true, avatarKey: true },
  });
}

/**
 * How many OTHER rows point at this address.
 *
 * `users.address_id` is a plain foreign key into a shared `addresses` table, and
 * nothing stops two rows referencing the same address — a household, or a seed
 * that reused one. Updating such a row in place would silently rewrite someone
 * else's address, so the service creates a fresh row instead when this is > 0.
 */
async function countOtherReferencesToAddress(client, addressId, exceptUserId) {
  const [users, companies] = await Promise.all([
    client.user.count({ where: { addressId, id: { not: exceptUserId } } }),
    client.companyAddress.count({ where: { addressId } }),
  ]);
  return users + companies;
}

function createAddress(client, data) {
  return client.address.create({ data });
}

function updateAddress(client, addressId, data) {
  return client.address.update({ where: { id: addressId }, data });
}

/** Apply a partial profile patch and return the full profile shape. */
function updateMe(client, userId, data) {
  return client.user.update({ where: { id: userId }, data, select: ME_SELECT });
}

module.exports = {
  ME_SELECT,
  findMe,
  findMeForUpdate,
  countOtherReferencesToAddress,
  createAddress,
  updateAddress,
  updateMe,
};
