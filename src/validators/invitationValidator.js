'use strict';

const ApiError = require('../utils/ApiError');
const common = require('./common');

/**
 * Ceiling on how many companies one invitation may name. Generous enough that no
 * real owner hits it, low enough that the request cannot be used to make the
 * service resolve an arbitrarily long id list.
 */
const MAX_COMPANIES_PER_INVITATION = 50;

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

/* -------------------------------------------------------------------------- */
/* teammate invitations                                                       */
/* -------------------------------------------------------------------------- */

const TEAMMATE_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'jobTitle',
  'companyIds',
  'roleId',
  'specificRoleId',
];

/** Deduplicated, order-preserving — so [3,3,7] validates and becomes [3,7]. */
function uniqueIds(values) {
  return [...new Set(values)];
}

/**
 * Validate POST /invitations/teammates — the owner's "add a teammate" form.
 *
 * EVERY field is required, including `specificRoleId`. That is stricter than
 * POST /invitations, where the specific role is conditional on the role's own
 * data, and it is deliberate: this endpoint exists for one shape of invitation
 * and the form always collects all of it. A half-filled submission is a bug in
 * the client, not a partial invitation to accept.
 *
 * `roleId` and `specificRoleId` still come from the client rather than being
 * hardcoded to CUSTOMER/TEAM here. They are ids, and ids belong to the database:
 * the service resolves them, checks the pair is consistent, and enforces what
 * they are allowed to be. Validating a *shape* here and the *meaning* there
 * keeps this file free of role codes that could drift out of sync with the
 * `roles` table.
 */
function validateCreateTeammateInvitation(body = {}) {
  common.rejectUnknown(body, TEAMMATE_FIELDS);
  common.requireFields(body, ['email', 'firstName', 'lastName', 'jobTitle', 'companyIds', 'roleId', 'specificRoleId']);

  if (!Array.isArray(body.companyIds)) {
    throw new ApiError(400, 'companyIds must be an array of company ids.', {
      code: 'VALIDATION_ERROR',
      fields: { companyIds: 'Select at least one company.' },
    });
  }
  if (body.companyIds.length === 0) {
    throw new ApiError(400, 'Select at least one company.', {
      code: 'VALIDATION_ERROR',
      fields: { companyIds: 'Select at least one company.' },
    });
  }
  // A bound on the array, not on the invitation: without one, a single request
  // could ask the service to validate ownership of an unbounded id list.
  if (body.companyIds.length > MAX_COMPANIES_PER_INVITATION) {
    throw new ApiError(400, `Select at most ${MAX_COMPANIES_PER_INVITATION} companies.`, {
      code: 'VALIDATION_ERROR',
      fields: { companyIds: `At most ${MAX_COMPANIES_PER_INVITATION} companies.` },
    });
  }

  return {
    email: common.email(body.email),
    firstName: common.str(body.firstName, 'firstName', { max: common.LIMITS.firstName }),
    lastName: common.str(body.lastName, 'lastName', { max: common.LIMITS.lastName }),
    jobTitle: common.str(body.jobTitle, 'jobTitle', { max: common.LIMITS.jobTitle }),
    // Each element is parsed individually so the error names the bad one
    // ("companyIds[2]") instead of rejecting the whole array anonymously.
    companyIds: uniqueIds(body.companyIds.map((value, i) => common.parseId(value, `companyIds[${i}]`))),
    roleId: common.parseId(body.roleId, 'roleId'),
    specificRoleId: common.parseId(body.specificRoleId, 'specificRoleId'),
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

module.exports = {
  validateCreateInvitation,
  validateCreateTeammateInvitation,
  validateInvitationListQuery,
  MAX_COMPANIES_PER_INVITATION,
};
