'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Input validation for the onboarding flow. Same hand-rolled style as
 * authValidator (no schema library), with the column widths mirrored from
 * schema.prisma so oversized input is a clean 400 rather than an opaque database
 * write error. Every function returns only whitelisted, trimmed fields, so the
 * raw request body never reaches the service.
 *
 * Note what is deliberately absent: neither the email nor the user id is
 * accepted here. Those come only from the verified access token (req.user); the
 * form supplies profile fields and nothing that identifies the account.
 */

const MAX_LENGTH = { firstName: 100, lastName: 100, phone: 30, jobTitle: 150, companyName: 255 };

// Permissive check: an optional leading '+', a leading digit, then digits and
// the usual separators (space, dot, hyphen, parentheses). The digit-count bound
// below is the real gate; this pattern just rejects obvious garbage. Not
// locale-specific — the app does not attempt to canonicalise numbers.
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{5,}$/;

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw new ApiError(400, 'Required fields are missing.', { details: { missing } });
  }
}

function validateName(value, field) {
  const name = String(value).trim();
  if (!name) {
    throw new ApiError(400, `${field} cannot be blank.`, { fields: { [field]: 'Required.' } });
  }
  if (name.length > MAX_LENGTH[field]) {
    throw new ApiError(400, `${field} cannot exceed ${MAX_LENGTH[field]} characters.`, {
      fields: { [field]: `Must be at most ${MAX_LENGTH[field]} characters.` },
    });
  }
  return name;
}

function validatePhone(value) {
  const phone = String(value).trim();
  if (!phone) {
    throw new ApiError(400, 'Phone number is required.', { fields: { phone: 'Required.' } });
  }
  if (phone.length > MAX_LENGTH.phone) {
    throw new ApiError(400, `Phone number cannot exceed ${MAX_LENGTH.phone} characters.`, {
      fields: { phone: `Must be at most ${MAX_LENGTH.phone} characters.` },
    });
  }
  const digits = phone.replace(/\D/g, '');
  if (!PHONE_PATTERN.test(phone) || digits.length < 7 || digits.length > 15) {
    throw new ApiError(400, 'A valid phone number is required.', {
      fields: { phone: 'Enter a valid phone number.' },
    });
  }
  return phone;
}

function validateJobTitle(value) {
  const jobTitle = String(value).trim();
  if (!jobTitle) {
    throw new ApiError(400, 'Job title is required.', { fields: { jobTitle: 'Required.' } });
  }
  if (jobTitle.length > MAX_LENGTH.jobTitle) {
    throw new ApiError(400, `Job title cannot exceed ${MAX_LENGTH.jobTitle} characters.`, {
      fields: { jobTitle: `Must be at most ${MAX_LENGTH.jobTitle} characters.` },
    });
  }
  return jobTitle;
}

/**
 * Validate the onboarding form: first name, last name, phone, and job title. All
 * four are required. The email and user id are intentionally not read here.
 */
function validateProfile(body = {}) {
  requireFields(body, ['firstName', 'lastName', 'phone', 'jobTitle']);
  return {
    firstName: validateName(body.firstName, 'firstName'),
    lastName: validateName(body.lastName, 'lastName'),
    phone: validatePhone(body.phone),
    jobTitle: validateJobTitle(body.jobTitle),
  };
}

/**
 * Validate the optional provisioning payload. The only thing a client may supply
 * is a display name for the customer account; when omitted the service derives
 * one from the user. Anything else in the body is ignored.
 */
function validateProvision(body = {}) {
  if (body.companyName === undefined || body.companyName === null || String(body.companyName).trim() === '') {
    return { companyName: null };
  }
  const companyName = String(body.companyName).trim();
  if (companyName.length > MAX_LENGTH.companyName) {
    throw new ApiError(400, `Company name cannot exceed ${MAX_LENGTH.companyName} characters.`, {
      fields: { companyName: `Must be at most ${MAX_LENGTH.companyName} characters.` },
    });
  }
  return { companyName };
}

module.exports = { validateProfile, validateProvision };
