'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const repo = require('../repositories/userRepository');
const userDto = require('../dto/userDto');
const storage = require('../utils/storage');
const { avatarKeyFor } = require('../middlewares/uploadAvatar');
const ApiError = require('../utils/ApiError');
const { logEvent } = require('../utils/auditLog');

/**
 * The caller's own profile: read it, correct the phone number and address, and
 * manage the profile picture.
 *
 * There is no `userId` parameter anywhere in this file that is not the token's
 * subject. That is the whole authorization model for these endpoints and the
 * reason they need no role gate: "me" is not a value a request can supply, so
 * there is no id to tamper with and nothing to check. Editing someone ELSE is a
 * different, admin-gated operation that deliberately does not live here.
 */

/** The token verified but its subject is gone from the database. */
function userNotFound() {
  return new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
}

/**
 * Delete a picture we no longer reference, without ever failing the request over
 * it.
 *
 * An orphaned object costs a few kilobytes; a 500 after the database has already
 * committed costs the user their update and tells them, wrongly, that it did not
 * happen. The database row is the source of truth about which picture is current
 * — the object is downstream of it, so cleanup is best-effort by design.
 * `storage.removeObjects` never throws, which is what makes that true here.
 */
function discardAvatar(avatarKey, requestId) {
  return storage.removeObjects({
    bucket: config.storage.avatarBucket,
    keys: avatarKey,
    requestId,
  });
}

/**
 * GET /users/me — the profile page's initial load: the user, their address, and
 * their picture in one round trip.
 */
async function getMe({ userId }) {
  const user = await repo.findMe(prisma, userId);
  if (!user) throw userNotFound();
  return userDto.toMe(user);
}

/**
 * PATCH /users/me — the caller corrects their own phone number and/or address.
 *
 * Both parts commit together. A phone number that saved while the address failed
 * would leave the form showing a mix of old and new values with no way for the
 * user to tell which is which, so the two writes share one transaction.
 *
 * @param {{ userId: number, requestId: string, input: { phone?: string|null, address?: object|null } }} params
 */
async function updateMe({ userId, requestId, input }) {
  const { address, ...userFields } = input;

  const updated = await prisma.$transaction(async (tx) => {
    const current = await repo.findMeForUpdate(tx, userId);
    if (!current) throw userNotFound();

    if (address === null) {
      // Unlink rather than delete the row: another user or a company may point
      // at the same address, and this endpoint speaks only for its caller.
      userFields.addressId = null;
    } else if (address !== undefined) {
      const data = {
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
        countryCode: address.countryCode,
      };

      if (current.addressId) {
        /*
         * Update in place ONLY if this row is ours alone. `addresses` is shared
         * by users and companies, so mutating a row that something else
         * references would rewrite an address its owner never touched. When it
         * is shared we branch off a private copy instead — the caller gets their
         * correction, everyone else keeps theirs.
         */
        const shared = await repo.countOtherReferencesToAddress(tx, current.addressId, userId);
        if (shared === 0) {
          await repo.updateAddress(tx, current.addressId, data);
        } else {
          const created = await repo.createAddress(tx, data);
          userFields.addressId = created.id;
        }
      } else {
        // No address yet — the common case for a user who signed up before the
        // profile form collected one.
        const created = await repo.createAddress(tx, data);
        userFields.addressId = created.id;
      }
    }

    // `updateMe` re-reads through ME_SELECT, so the response reflects the address
    // written moments ago in this same transaction rather than a stale join.
    return repo.updateMe(tx, userId, userFields);
  });

  logEvent({
    event: 'user.profile.updated',
    status: 'success',
    requestId,
    userId,
    detail: Object.keys(input).join(','),
  });

  return userDto.toMe(updated);
}

/**
 * POST /users/me/avatar — store the uploaded picture and point the row at it.
 *
 * ORDER MATTERS, and it is: new picture stored → row updated → OLD picture
 * removed.
 *
 * Storing before updating is what makes the row's key always resolve: point the
 * row at an object that is not there yet and every profile load in between shows
 * a broken image. Removing the old one LAST is the same argument from the other
 * end — remove it first and a failed update leaves the user with no picture at
 * all, whereas this way the worst case is one stale object nobody references.
 *
 * And if the row update fails, the object just written is removed here.
 * Otherwise every failed save would leak two megabytes that nothing will ever
 * point to.
 *
 * The bytes arrive as `file.buffer` because the parser holds the upload in
 * memory — there is no path, and on a serverless host there is nowhere for one
 * to point.
 *
 * @param {{ userId: number, requestId: string, file: Express.Multer.File }} params
 */
async function setAvatar({ userId, requestId, file }) {
  const avatarKey = avatarKeyFor(userId, file.mimetype);

  await storage.putObject({
    bucket: config.storage.avatarBucket,
    key: avatarKey,
    body: file.buffer,
    contentType: file.mimetype,
  });

  let previousKey = null;
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const current = await repo.findMeForUpdate(tx, userId);
      if (!current) throw userNotFound();
      previousKey = current.avatarKey;
      return repo.updateMe(tx, userId, { avatarKey });
    });
  } catch (err) {
    await discardAvatar(avatarKey, requestId);
    throw err;
  }

  // Only now is the new picture the one of record, so the old one is garbage.
  await discardAvatar(previousKey, requestId);

  logEvent({ event: 'user.avatar.updated', status: 'success', requestId, userId });

  return userDto.toMe(updated);
}

/**
 * DELETE /users/me/avatar — back to no picture.
 *
 * Idempotent: deleting an avatar that is already absent is a success, not a 404.
 * The caller's intent ("I have no profile picture") is satisfied either way, and
 * a 404 here would only make a double-click look like an error.
 */
async function removeAvatar({ userId, requestId }) {
  let previousKey = null;

  const updated = await prisma.$transaction(async (tx) => {
    const current = await repo.findMeForUpdate(tx, userId);
    if (!current) throw userNotFound();
    previousKey = current.avatarKey;
    if (!current.avatarKey) return repo.findMe(tx, userId);
    return repo.updateMe(tx, userId, { avatarKey: null });
  });

  await discardAvatar(previousKey, requestId);

  if (previousKey) {
    logEvent({ event: 'user.avatar.removed', status: 'success', requestId, userId });
  }

  return userDto.toMe(updated);
}

module.exports = { getMe, updateMe, setAvatar, removeAvatar };
