'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const { validateProfileUpdate } = require('../validators/userValidator');
const userService = require('../services/userService');

/**
 * HTTP layer for "my own account". Thin by design, like the other controllers:
 * identity from req.user (never the body), validate, delegate, shape the
 * response. Every handler answers with the same profile object, so a client can
 * replace its cached user from any of them without a follow-up GET.
 */

/**
 * GET /users/me
 *
 * The profile page's initial load: the user, their address, and their avatar URL.
 */
const getMe = asyncHandler(async (req, res) => {
  const data = await userService.getMe({ userId: req.user.id });

  return res.status(200).json({
    success: true,
    message: 'Profile retrieved.',
    data,
  });
});

/**
 * PATCH /users/me
 *
 * The caller updates their own phone number and/or address. Partial: send only
 * what changed. `address` is submitted whole, never field-by-field.
 */
const updateMe = asyncHandler(async (req, res) => {
  const input = validateProfileUpdate(req.body);

  const data = await userService.updateMe({
    userId: req.user.id,
    requestId: req.id,
    input,
  });

  return res.status(200).json({
    success: true,
    message: 'Profile updated.',
    data,
  });
});

/**
 * POST /users/me/avatar
 *
 * multipart/form-data with a single `avatar` file. The file has already been
 * written to disk and validated (type, size, generated name) by the upload
 * middleware by the time this runs — see middlewares/uploadAvatar.
 */
const uploadAvatar = asyncHandler(async (req, res) => {
  const data = await userService.setAvatar({
    userId: req.user.id,
    requestId: req.id,
    file: req.file,
  });

  return res.status(200).json({
    success: true,
    message: 'Profile picture updated.',
    data,
  });
});

/**
 * DELETE /users/me/avatar
 *
 * Remove the picture. Idempotent — succeeds whether or not one was set.
 */
const deleteAvatar = asyncHandler(async (req, res) => {
  const data = await userService.removeAvatar({
    userId: req.user.id,
    requestId: req.id,
  });

  return res.status(200).json({
    success: true,
    message: 'Profile picture removed.',
    data,
  });
});

module.exports = { getMe, updateMe, uploadAvatar, deleteAvatar };
