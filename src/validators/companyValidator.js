'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Input validation for the company onboarding and team flows. Same hand-rolled
 * style as onboardingValidator / authValidator (no schema library): column
 * widths mirror schema.prisma so oversized input is a clean 400 rather than an
 * opaque database write error, and every function returns only whitelisted,
 * normalised fields so the raw request body never reaches the service.
 *
 * Normalisation rules (applied here, once, so the service and DB always see
 * canonical values):
 *   - strings are trimmed,
 *   - email is lower-cased,
 *   - revenue_currency and country_code are upper-cased,
 *   - unknown fields are REJECTED (a stray owner_user_id, id, etc. is a 400) —
 *     the caller can never smuggle in a field the flow does not expect.
 *
 * Note what is deliberately absent: owner_user_id / user id are never read here.
 * Ownership comes only from the verified access token (req.user).
 */

const MAX = {
  companyName: 255,
  companyEmail: 255,
  companyPhone: 30,
  revenueCurrency: 3,
  line1: 255,
  line2: 255,
  city: 120,
  state: 120,
  postalCode: 20,
  country: 100,
  countryCode: 2,
};

// The legal structures accepted by the company onboarding form. Kept in sync with
// the CompanyType enum in schema.prisma. Unknown values are rejected rather than
// silently coerced.
const COMPANY_TYPES = new Set([
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'LIMITED_LIABILITY_COMPANY',
  'C_CORPORATION',
  'S_CORPORATION',
  'NON_PROFIT',
  'OTHER',
]);

// Same permissive phone check as onboardingValidator: the digit-count bound is
// the real gate; the pattern just rejects obvious garbage.
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{5,}$/;
// Deliberately simple, RFC-pragmatic email shape. The real proof of a valid
// address is a delivered message, not a regex.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Reject any field on `body` that is not in the allowed set (400). */
function rejectUnknown(body, allowed, where) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ApiError(400, `Unknown field(s) in ${where}: ${unknown.join(', ')}.`, {
      code: 'VALIDATION_ERROR',
      details: { unknown, where },
    });
  }
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw new ApiError(400, 'Required fields are missing.', { details: { missing } });
  }
}

function str(value, field, { max, required = true }) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${field} is required.`, { fields: { [field]: 'Required.' } });
    return null;
  }
  const s = String(value).trim();
  if (!s) {
    if (required) throw new ApiError(400, `${field} cannot be blank.`, { fields: { [field]: 'Required.' } });
    return null;
  }
  if (s.length > max) {
    throw new ApiError(400, `${field} cannot exceed ${max} characters.`, {
      fields: { [field]: `Must be at most ${max} characters.` },
    });
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/* field validators                                                           */
/* -------------------------------------------------------------------------- */

function validateEmail(value) {
  const email = str(value, 'company_email', { max: MAX.companyEmail }).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ApiError(400, 'A valid company email is required.', {
      fields: { company_email: 'Enter a valid email address.' },
    });
  }
  return email;
}

function validatePhone(value) {
  const phone = str(value, 'company_phone', { max: MAX.companyPhone });
  const digits = phone.replace(/\D/g, '');
  if (!PHONE_PATTERN.test(phone) || digits.length < 7 || digits.length > 15) {
    throw new ApiError(400, 'A valid company phone number is required.', {
      fields: { company_phone: 'Enter a valid phone number.' },
    });
  }
  return phone;
}

function validateCompanyType(value) {
  const type = str(value, 'company_type', { max: 60 }).toUpperCase();
  if (!COMPANY_TYPES.has(type)) {
    throw new ApiError(400, 'Unsupported company type.', {
      fields: { company_type: `Must be one of: ${[...COMPANY_TYPES].join(', ')}.` },
    });
  }
  return type;
}

function validateEmployeeCount(value) {
  // Accept an integer or an integer-valued string; reject anything else.
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ApiError(400, 'employee_count must be a non-negative integer.', {
      fields: { employee_count: 'Enter a whole number of 0 or more.' },
    });
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, 'employee_count must be a non-negative integer.', {
      fields: { employee_count: 'Enter a whole number of 0 or more.' },
    });
  }
  return n;
}

/**
 * Validate revenue as a non-negative decimal with at most two fraction digits.
 * Returned as a STRING so it reaches Prisma's Decimal without ever passing
 * through a binary float (which would round large values).
 */
function validateRevenue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ApiError(400, 'last_year_revenue must be a non-negative amount.', {
      fields: { last_year_revenue: 'Enter an amount of 0 or more.' },
    });
  }
  const raw = String(value).trim();
  // Up to 16 integer digits and 2 decimals fits DECIMAL(18,2).
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(raw)) {
    throw new ApiError(400, 'last_year_revenue must be a non-negative amount with at most 2 decimals.', {
      fields: { last_year_revenue: 'Enter a valid amount (max 2 decimal places).' },
    });
  }
  return raw;
}

function validateCurrency(value) {
  const code = str(value, 'revenue_currency', { max: MAX.revenueCurrency }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ApiError(400, 'revenue_currency must be a 3-letter ISO code.', {
      fields: { revenue_currency: 'Use a 3-letter code, e.g. USD.' },
    });
  }
  return code;
}

const ADDRESS_FIELDS = [
  'address_line_1',
  'address_line_2',
  'city',
  'state',
  'postal_code',
  'country',
  'country_code',
];

/**
 * Validate the nested address object. State is required by default (the portal is
 * US-centric); relax it per country by extending NO_STATE_COUNTRIES.
 */
const NO_STATE_COUNTRIES = new Set([]); // e.g. add 'VA', 'MC' for micro-states

function validateAddress(address) {
  if (address === undefined || address === null || typeof address !== 'object' || Array.isArray(address)) {
    throw new ApiError(400, 'address is required.', { fields: { address: 'Provide the company address.' } });
  }
  rejectUnknown(address, ADDRESS_FIELDS, 'address');

  const line1 = str(address.address_line_1, 'address_line_1', { max: MAX.line1 });
  const line2 = str(address.address_line_2, 'address_line_2', { max: MAX.line2, required: false });
  const city = str(address.city, 'city', { max: MAX.city });
  const postalCode = str(address.postal_code, 'postal_code', { max: MAX.postalCode });
  const country = str(address.country, 'country', { max: MAX.country });

  const countryCodeRaw = str(address.country_code, 'country_code', { max: MAX.countryCode }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCodeRaw)) {
    throw new ApiError(400, 'country_code must be a 2-letter ISO code.', {
      fields: { country_code: 'Use a 2-letter code, e.g. US.' },
    });
  }

  const stateRequired = !NO_STATE_COUNTRIES.has(countryCodeRaw);
  const state = str(address.state, 'state', { max: MAX.state, required: stateRequired });

  return {
    line1,
    line2,
    city,
    state,
    postalCode,
    country,
    countryCode: countryCodeRaw,
  };
}

/* -------------------------------------------------------------------------- */
/* public validators                                                          */
/* -------------------------------------------------------------------------- */

const ONBOARDING_FIELDS = [
  'company_name',
  'company_type',
  'company_email',
  'company_phone',
  'employee_count',
  'last_year_revenue',
  'revenue_currency',
  'address',
];

/**
 * Validate POST /onboarding/company. Returns canonical, whitelisted values only.
 * owner_user_id and any other stray field are rejected as unknown.
 */
function validateCompanyOnboarding(body = {}) {
  rejectUnknown(body, ONBOARDING_FIELDS, 'request body');
  requireFields(body, [
    'company_name',
    'company_type',
    'company_email',
    'company_phone',
    'employee_count',
    'last_year_revenue',
    'revenue_currency',
    'address',
  ]);

  return {
    companyName: str(body.company_name, 'company_name', { max: MAX.companyName }),
    companyType: validateCompanyType(body.company_type),
    companyEmail: validateEmail(body.company_email),
    companyPhone: validatePhone(body.company_phone),
    employeeCount: validateEmployeeCount(body.employee_count),
    lastYearRevenue: validateRevenue(body.last_year_revenue),
    revenueCurrency: validateCurrency(body.revenue_currency),
    address: validateAddress(body.address),
  };
}

/** Parse a path param / body id into a positive integer or throw 400. */
function parseId(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, `${field} must be a positive integer.`, {
      fields: { [field]: 'Invalid id.' },
    });
  }
  return n;
}

/** Validate PUT /companies/:companyId/accounting-manager body. */
function validateAccountingManagerAssignment(body = {}) {
  rejectUnknown(body, ['accounting_manager_user_id'], 'request body');
  requireFields(body, ['accounting_manager_user_id']);
  return { accountingManagerUserId: parseId(body.accounting_manager_user_id, 'accounting_manager_user_id') };
}

/** Validate POST /companies/:companyId/specialists body. */
function validateSpecialistAssignment(body = {}) {
  rejectUnknown(body, ['specialist_user_id', 'specialization_codes'], 'request body');
  requireFields(body, ['specialist_user_id', 'specialization_codes']);

  const specialistUserId = parseId(body.specialist_user_id, 'specialist_user_id');

  const codes = body.specialization_codes;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new ApiError(400, 'specialization_codes must be a non-empty array.', {
      fields: { specialization_codes: 'Provide at least one specialization code.' },
    });
  }
  // Normalise (trim + upper-case), reject blanks, and de-duplicate. Existence of
  // each code is verified against the specializations table in the service.
  const normalised = [];
  for (const c of codes) {
    if (typeof c !== 'string' || !c.trim()) {
      throw new ApiError(400, 'Each specialization code must be a non-empty string.', {
        fields: { specialization_codes: 'Codes must be non-empty strings.' },
      });
    }
    const code = c.trim().toUpperCase();
    if (code.length > 50) {
      throw new ApiError(400, 'specialization code is too long.', {
        fields: { specialization_codes: 'Code must be at most 50 characters.' },
      });
    }
    if (!normalised.includes(code)) normalised.push(code);
  }

  return { specialistUserId, specializationCodes: normalised };
}

module.exports = {
  validateCompanyOnboarding,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
  parseId,
  COMPANY_TYPES,
};
