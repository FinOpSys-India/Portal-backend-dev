'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const common = require('../validators/common');
const roleService = require('../services/roleService');

/**
 * HTTP layer for the role catalog.
 *
 * GET /roles — no parameters, and deliberately none.
 *
 * There are four roles. The client fetches them once after login, caches them,
 * and each invite page picks the one it needs with a `find` on the code. A
 * server-side filter would be a second way to ask the same question, so it is
 * not offered: an unknown query key is a 400 rather than a silently ignored
 * filter, which is the same rule every other endpoint here follows.
 */
const listRoles = asyncHandler(async (req, res) => {
  common.rejectUnknown(req.query, [], 'query string');

  const roles = await roleService.listRoles();

  return res.status(200).json({
    success: true,
    message: 'Roles retrieved.',
    data: { roles },
  });
});

module.exports = { listRoles };
