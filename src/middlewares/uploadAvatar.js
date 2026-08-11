'use strict';

const crypto = require('crypto');

const multer = require('multer');

const config = require('../config');
const storage = require('../utils/storage');
const ApiError = require('../utils/ApiError');

/**
 * The multipart parser for POST /users/me/avatar.
 *
 * Every rule about what may be stored, where, and under what name is enforced
 * here rather than spread between the route and the service.
 *
 * Three rules, and the reason for each:
 *
 *   1. The filename is GENERATED, never taken from the upload. `originalname`
 *      is attacker-controlled: "../../server.js" would escape the directory,
 *      and even a benign "photo.jpg" reused by every user would collide across
 *      accounts. A random 32-hex name also means a replaced avatar gets a new
 *      URL, so no browser ever shows a stale cached picture.
 *   2. The extension comes from the MIME allowlist, not from the name — so a
 *      file called `x.php` uploaded as image/jpeg lands as `.jpg`, and nothing
 *      the static server hands back can be interpreted as code.
 *   3. Size is capped by multer itself, which aborts the request mid-stream.
 *      Checking after the fact would mean the whole file was already buffered.
 *
 * Objects are stored under `avatars/<userId>/`, and the user id comes from the
 * verified token (requireAuth runs first), never from the request — so one user
 * cannot write into another's prefix.
 *
 * THE PARSER HOLDS THE IMAGE IN MEMORY rather than writing it to disk, because a
 * serverless host has no durable disk: a file written during the upload is gone
 * before the request that wants to display it. userService hands the buffer to
 * the avatars bucket once the row is ready. One image of at most
 * `maxAvatarBytes` (2 MB) is resident at a time.
 */

// The set of formats a browser can display and we are willing to serve back.
// SVG is deliberately absent: it is a document, not an image — it can carry
// script, and we serve these files from our own origin.
const EXTENSION_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const FIELD_NAME = 'avatar';

/**
 * The storage key for one uploaded avatar: `avatars/<userId>/<random><ext>`.
 *
 * Per-user prefix: keeps one listing from growing to a million entries, and
 * makes "delete this account's files" one prefixed remove. The user id is the
 * token's subject, so nothing a client sends can steer it.
 */
function avatarKeyFor(userId, mimeType) {
  const ext = EXTENSION_BY_MIME[mimeType] ?? '';
  return storage.keyFor('avatars', userId, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

const parser = multer({
  // In memory — see the note above. userService writes it to the bucket.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxAvatarBytes,
    files: 1,
    // A profile picture is one part. Anything else in the form is a client bug
    // (or a probe), and silently ignoring it is the failure mode this codebase
    // rejects everywhere else — see validators/common.rejectUnknown.
    fields: 0,
  },
  fileFilter(req, file, cb) {
    if (!EXTENSION_BY_MIME[file.mimetype]) {
      return cb(
        new ApiError(415, 'Only JPEG, PNG, or WebP images are accepted.', {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          fields: { [FIELD_NAME]: 'Upload a JPEG, PNG, or WebP image.' },
        })
      );
    }
    return cb(null, true);
  },
}).single(FIELD_NAME);

/**
 * Translate multer's own errors into this API's error envelope.
 *
 * Left alone, a MulterError reaches the central handler as an unrecognised
 * exception and is reported as a 500 — telling a user who picked a 20 MB photo
 * that the server broke, when the server in fact worked exactly as designed.
 */
function uploadAvatar(req, res, next) {
  parser(req, res, (err) => {
    if (!err) {
      if (!req.file) {
        return next(
          new ApiError(400, 'No image was uploaded.', {
            code: 'VALIDATION_ERROR',
            fields: { [FIELD_NAME]: `Attach an image in the "${FIELD_NAME}" field.` },
          })
        );
      }
      return next();
    }

    if (err instanceof multer.MulterError) {
      const mb = Math.round(config.uploads.maxAvatarBytes / (1024 * 1024));
      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          return next(
            new ApiError(413, `The image is too large. Maximum size is ${mb} MB.`, {
              code: 'FILE_TOO_LARGE',
              fields: { [FIELD_NAME]: `Choose an image under ${mb} MB.` },
            })
          );
        case 'LIMIT_FILE_COUNT':
        case 'LIMIT_UNEXPECTED_FILE':
          return next(
            new ApiError(400, `Send exactly one image in the "${FIELD_NAME}" field.`, {
              code: 'VALIDATION_ERROR',
              fields: { [FIELD_NAME]: 'Attach a single image.' },
            })
          );
        // `fields: 0` above means any text part in the form trips this. Named
        // explicitly because the generic fallback ("the upload could not be
        // read") describes a corrupt request, and this one is perfectly
        // well-formed — it just carries something we do not accept.
        case 'LIMIT_FIELD_COUNT':
        case 'LIMIT_PART_COUNT':
          return next(
            new ApiError(400, `Send only the image — no other form fields are accepted.`, {
              code: 'VALIDATION_ERROR',
              fields: { [FIELD_NAME]: `Attach the image as "${FIELD_NAME}" and nothing else.` },
            })
          );
        default:
          return next(
            new ApiError(400, 'The upload could not be read.', {
              code: 'VALIDATION_ERROR',
              details: { reason: err.code },
            })
          );
      }
    }

    return next(err);
  });
}

module.exports = { uploadAvatar, EXTENSION_BY_MIME, avatarKeyFor };
