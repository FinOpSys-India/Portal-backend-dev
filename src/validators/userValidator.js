'use strict';

const common = require('./common');
const ApiError = require('../utils/ApiError');
const { validateAddress } = require('./companyValidator');

/**
 * Input validation for the caller's own profile — PATCH /users/me.
 *
 * What is deliberately NOT accepted here is the point of the file: no userId, no
 * email, no role, no status. Identity comes from the verified access token, and
 * a role is an internal staffing decision made by an admin (see
 * routes/companiesRoutes) — accepting either from the body would let anyone
 * promote themselves or edit someone else by editing a JSON field.
 *
 * The address is validated as a WHOLE object rather than merged field by field,
 * for the same reason the company patch does it: a half-updated address (new
 * street, old postcode) is worse than requiring the form to resubmit all of it,
 * because it is wrong in a way nobody notices until something is posted to it.
 */

const UPDATABLE_FIELDS = ['phone', 'address'];

function validateProfileUpdate(body = {}) {
  common.rejectUnknown(body, UPDATABLE_FIELDS);

  const present = UPDATABLE_FIELDS.filter((f) => body[f] !== undefined);
  if (!present.length) {
    throw new ApiError(400, 'Provide at least one field to update.', {
      code: 'VALIDATION_ERROR',
      details: { updatable: UPDATABLE_FIELDS },
    });
  }

  const out = {};

  if (body.phone !== undefined) {
    /*
     * `null` clears the number; a string is validated. The distinction matters:
     * the column is nullable and a user who no longer wants to share a phone
     * number needs some way to say so that is not "submit an empty string",
     * which common.phone would reject as blank.
     */
    out.phone = body.phone === null ? null : common.phone(body.phone);
  }

  if (body.address !== undefined) {
    out.address = body.address === null ? null : validateAddress(body.address);
  }

  return out;
}

module.exports = { validateProfileUpdate, UPDATABLE_FIELDS };
