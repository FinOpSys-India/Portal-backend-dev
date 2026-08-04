'use strict';

const common = require('./common');

/**
 * Validation for the invitation endpoints.
 *
 * Note what is NOT accepted here: `invitedBy`. It used to be a required body
 * field on an endpoint with no authentication at all, which meant any caller on
 * the internet could send branded email on behalf of any active user — the
 * inviter's name and reply-to address were taken straight from whatever id the
 * request supplied. The inviter is now the authenticated caller, read from the
 * verified token, and a request that still sends `invitedBy` is rejected as an
 * unknown field rather than silently ignored, so a client built against the old
 * contract fails loudly instead of appearing to work.
 */

const CREATE_FIELDS = ['email', 'firstName', 'lastName', 'roleId', 'specificRoleId'];

/** Validate POST /invitations. */
function validateCreateInvitation(body = {}) {
  common.rejectUnknown(body, CREATE_FIELDS);
  common.requireFields(body, ['email', 'firstName', 'lastName', 'roleId']);

  return {
    email: common.email(body.email),
    firstName: common.str(body.firstName, 'firstName', { max: common.LIMITS.firstName }),
    lastName: common.str(body.lastName, 'lastName', { max: common.LIMITS.lastName }),
    roleId: common.parseId(body.roleId, 'roleId'),
    // Whether this is required depends on the role's own data — a role with
    // subdivisions demands one, a role without forbids one — so the conditional
    // check lives in the service, where the role has been loaded.
    specificRoleId:
      body.specificRoleId === undefined || body.specificRoleId === null
        ? null
        : common.parseId(body.specificRoleId, 'specificRoleId'),
  };
}

/** `?limit=&offset=&status=&search=` for GET /invitations. */
function validateInvitationListQuery(query = {}) {
  common.rejectUnknown(query, ['limit', 'offset', 'sort', 'order', 'status', 'search'], 'query string');

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: ['createdAt', 'expiresAt', 'email', 'status'],
    defaultSort: 'createdAt',
  });

  const status =
    query.status === undefined || query.status === null || query.status === ''
      ? null
      : common.enumValue(query.status, 'status', ['PENDING', 'SENT', 'ACCEPTED', 'EXPIRED', 'REVOKED']);

  const search =
    query.search === undefined || query.search === null || query.search === ''
      ? null
      : common.str(query.search, 'search', { max: 255, required: false });

  return { ...page, status, search };
}

module.exports = { validateCreateInvitation, validateInvitationListQuery };
