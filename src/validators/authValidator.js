'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Input validation for the auth flows. Mirrors the hand-rolled style of the
 * invitation controller (no schema library in the project) and, like it, keeps
 * the column widths from schema.prisma so oversized input is a clean 400 rather
 * than an opaque database write error.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LENGTH = { email: 255, firstName: 100, lastName: 100 };

// Password policy. Deliberately checks composition, not just length: an 8-char
// minimum alone still permits "password". The 72-byte ceiling is bcrypt's own
// limit — it silently truncates beyond that, so anything longer is rejected
// rather than accepted with bytes that do not count toward the password.
const PASSWORD = {
  minLength: 8,
  maxBytes: 72,
};

function requireFields(body) {
  const missing = ['invitationToken', 'email', 'firstName', 'lastName', 'password'].filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === ''
  );
  if (missing.length) {
    throw new ApiError(400, 'Required fields are missing.', { details: { missing } });
  }
}

function validateName(value, field) {
  const name = String(value).trim();
  if (!name) {
    throw new ApiError(400, `${field} cannot be blank.`);
  }
  if (name.length > MAX_LENGTH[field]) {
    throw new ApiError(400, `${field} cannot exceed ${MAX_LENGTH[field]} characters.`);
  }
  return name;
}

function validateEmail(value) {
  const email = String(value).toLowerCase().trim();
  if (!EMAIL_PATTERN.test(email) || email.length > MAX_LENGTH.email) {
    throw new ApiError(400, 'A valid email address is required.');
  }
  return email;
}

/**
 * Enforce the password policy. Returns the password unchanged on success (it is
 * never trimmed or normalised — surrounding spaces are legitimate characters).
 * Collects every failed rule so the caller learns all of them at once.
 */
function validatePassword(value) {
  const password = String(value);
  const failures = [];

  if (password.length < PASSWORD.minLength) {
    failures.push(`be at least ${PASSWORD.minLength} characters`);
  }
  // bcrypt operates on bytes, and multi-byte characters make length() and the
  // byte count diverge, so measure the real input to bcrypt.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD.maxBytes) {
    failures.push(`be at most ${PASSWORD.maxBytes} bytes`);
  }
  if (!/[a-z]/.test(password)) failures.push('contain a lowercase letter');
  if (!/[A-Z]/.test(password)) failures.push('contain an uppercase letter');
  if (!/[0-9]/.test(password)) failures.push('contain a number');

  if (failures.length) {
    throw new ApiError(400, `Password must ${failures.join(', ')}.`, {
      details: { requirements: failures },
    });
  }
  return password;
}

/**
 * Validate and normalise a sign-up request body. Returns only the whitelisted,
 * cleaned fields — never the raw body — so nothing unexpected reaches the
 * service layer. The invitation token is passed through untrimmed and is not
 * echoed anywhere.
 */
function validateSignup(body) {
  requireFields(body);
  return {
    invitationToken: String(body.invitationToken),
    email: validateEmail(body.email),
    firstName: validateName(body.firstName, 'firstName'),
    lastName: validateName(body.lastName, 'lastName'),
    password: validatePassword(body.password),
  };
}

// validatePassword is exported so the password-reset flow enforces the identical
// policy. One definition means a rule tightened here cannot be silently skipped
// by the other path — which would let a user reset their way to a weaker
// password than sign-up would ever have accepted.
module.exports = { validateSignup, validatePassword, PASSWORD };
