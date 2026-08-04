'use strict';

const common = require('./common');

/**
 * Input validation for the onboarding flow.
 *
 * Every function returns only whitelisted, trimmed fields, so the raw request
 * body never reaches the service — and unknown fields are now REJECTED here too,
 * matching the company and billing validators. They used to be silently ignored,
 * which is the worst failure mode a form can have: the request succeeds and the
 * value the user typed was never stored.
 *
 * Note what is deliberately absent: neither the email nor the user id is
 * accepted. Those come only from the verified access token (req.user); the form
 * supplies profile fields and nothing that identifies the account.
 */

const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'jobTitle'];
// Provisioning takes no input at all: it assigns a role to the caller, and the
// caller comes from the token. An empty body is the whole contract.
const PROVISION_FIELDS = [];

/**
 * Validate the onboarding form: first name, last name, phone, and job title. All
 * four are required.
 */
function validateProfile(body = {}) {
  common.rejectUnknown(body, PROFILE_FIELDS);
  common.requireFields(body, PROFILE_FIELDS);

  return {
    firstName: common.str(body.firstName, 'firstName', { max: common.LIMITS.firstName }),
    lastName: common.str(body.lastName, 'lastName', { max: common.LIMITS.lastName }),
    phone: common.phone(body.phone),
    jobTitle: common.str(body.jobTitle, 'jobTitle', { max: common.LIMITS.jobTitle }),
  };
}

/**
 * Validate the provisioning payload — which is to say, confirm there isn't one.
 * `companyName` used to be accepted here to name the customer account; with that
 * table gone the field has nothing to set, so it is rejected rather than ignored.
 */
function validateProvision(body = {}) {
  common.rejectUnknown(body, PROVISION_FIELDS);
  return {};
}

module.exports = { validateProfile, validateProvision };
