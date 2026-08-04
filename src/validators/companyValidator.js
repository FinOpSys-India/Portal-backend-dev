'use strict';

const ApiError = require('../utils/ApiError');
const common = require('./common');
const countries = require('../config/countries');

/**
 * Input validation for the company onboarding and team flows.
 *
 * Field names here are the canonical camelCase ones. A client may still send
 * snake_case (`company_name`, `address_line_1`) — middlewares/normalizeRequest
 * reconciles the two before this file runs, so there is one name to validate
 * against and reject-unknown stays strict.
 *
 * Normalisation rules, applied here once so the service and DB only ever see
 * canonical values:
 *   - strings are trimmed,
 *   - email is lower-cased,
 *   - revenueCurrency, countryCode and state are upper-cased,
 *   - unknown fields are REJECTED — the caller can never smuggle in a field the
 *     flow does not expect.
 *
 * Note what is deliberately absent: ownerUserId / user id are never read here.
 * Ownership comes only from the verified access token (req.user).
 */

const MAX = {
  companyName: common.LIMITS.companyName,
  companyPhone: common.LIMITS.phone,
  revenueCurrency: 3,
  line1: common.LIMITS.addressLine,
  line2: common.LIMITS.addressLine,
  city: common.LIMITS.city,
  state: common.LIMITS.state,
  postalCode: common.LIMITS.postalCode,
  country: common.LIMITS.country,
  countryCode: 2,
};

/**
 * Upper bound on head count. Previously unbounded here while the billing side
 * capped the same concept at 5000, so `employeeCount: 999999999` was accepted at
 * onboarding and rejected at checkout.
 */
const MAX_EMPLOYEE_COUNT = 1_000_000;

// Kept in sync with the CompanyType enum in schema.prisma.
const COMPANY_TYPES = new Set([
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'LIMITED_LIABILITY_COMPANY',
  'C_CORPORATION',
  'S_CORPORATION',
  'NON_PROFIT',
  'OTHER',
]);

const ADDRESS_FIELDS = [
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'countryCode',
];

const ONBOARDING_FIELDS = [
  'companyName',
  'companyType',
  'companyEmail',
  'companyPhone',
  'employeeCount',
  'lastYearRevenue',
  'revenueCurrency',
  'address',
];

/* -------------------------------------------------------------------------- */
/* field validators                                                           */
/* -------------------------------------------------------------------------- */

function validateCurrency(value) {
  const code = common.str(value, 'revenueCurrency', { max: MAX.revenueCurrency }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw common.fieldError('revenueCurrency', 'revenueCurrency must be a 3-letter ISO code.', 'Use a 3-letter code, e.g. USD.');
  }
  return code;
}

/**
 * Validate the nested address object.
 *
 * Beyond shape, three real-world rules are enforced that previously were not:
 * the country code must be a genuine ISO 3166-1 alpha-2 assignment, the postal
 * code must match its country's format where we know it, and a US state must be
 * a real state code. All three end up on Stripe invoices, so accepting
 * `{ country: 'France', countryCode: 'US', postalCode: 'abc' }` was not a
 * validation gap in the abstract — it was bad data on a customer's receipt.
 */
function validateAddress(address) {
  if (address === undefined || address === null || typeof address !== 'object' || Array.isArray(address)) {
    throw common.fieldError('address', 'address is required.', 'Provide the company address.');
  }
  common.rejectUnknown(address, ADDRESS_FIELDS, 'address');

  const line1 = common.str(address.addressLine1, 'addressLine1', { max: MAX.line1 });
  const line2 = common.str(address.addressLine2, 'addressLine2', { max: MAX.line2, required: false });
  const city = common.str(address.city, 'city', { max: MAX.city });
  const country = common.str(address.country, 'country', { max: MAX.country });

  const countryCode = common.str(address.countryCode, 'countryCode', { max: MAX.countryCode }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode) || !countries.isValidCountryCode(countryCode)) {
    throw common.fieldError('countryCode', 'countryCode must be a valid ISO 3166-1 alpha-2 code.', 'Use a valid 2-letter country code, e.g. US.');
  }

  const stateRequired = countries.requiresState(countryCode);
  const rawState = common.str(address.state, 'state', { max: MAX.state, required: stateRequired });

  // Canonicalised, not merely checked: for the US both "Texas" and "TX" are
  // accepted and stored as "TX". Rejecting the spelling a person actually types
  // in order to get the one an invoice needs just moves the work to the user.
  const { ok, value: state } = countries.normalizeState(rawState, countryCode);
  if (!ok) {
    throw common.fieldError('state', 'state must be a valid US state or territory.', 'Enter a valid state, e.g. CA or California.');
  }

  const postalCode = common.str(address.postalCode, 'postalCode', { max: MAX.postalCode });
  if (!countries.isValidPostalCode(postalCode, countryCode)) {
    throw common.fieldError('postalCode', `postalCode is not valid for ${countryCode}.`, 'Enter a valid postal code for the selected country.');
  }

  return { line1, line2, city, state, postalCode, country, countryCode };
}

/* -------------------------------------------------------------------------- */
/* public validators                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validate POST /onboarding/company. Returns canonical, whitelisted values only.
 * ownerUserId and any other stray field are rejected as unknown.
 */
function validateCompanyOnboarding(body = {}) {
  common.rejectUnknown(body, ONBOARDING_FIELDS);
  common.requireFields(body, ONBOARDING_FIELDS);

  return {
    companyName: common.str(body.companyName, 'companyName', { max: MAX.companyName }),
    companyType: common.enumValue(body.companyType, 'companyType', [...COMPANY_TYPES]),
    companyEmail: common.email(body.companyEmail, 'companyEmail'),
    companyPhone: common.phone(body.companyPhone, 'companyPhone'),
    employeeCount: common.integer(body.employeeCount, 'employeeCount', { min: 0, max: MAX_EMPLOYEE_COUNT }),
    lastYearRevenue: common.decimalAmount(body.lastYearRevenue, 'lastYearRevenue'),
    revenueCurrency: validateCurrency(body.revenueCurrency),
    address: validateAddress(body.address),
  };
}

/**
 * Validate PATCH /companies/:companyId — a partial update.
 *
 * Every field is optional, but at least one must be present: an empty patch is a
 * no-op that still costs a round trip and an audit entry, and it is far more
 * likely to be a client bug than an intention. `address`, when supplied, is
 * validated in full rather than merged field-by-field — a half-updated address
 * (new street, old postcode) is worse than requiring the whole object.
 */
const UPDATABLE_FIELDS = [
  'companyName',
  'companyType',
  'companyEmail',
  'companyPhone',
  'employeeCount',
  'lastYearRevenue',
  'revenueCurrency',
  'address',
];

function validateCompanyUpdate(body = {}) {
  common.rejectUnknown(body, UPDATABLE_FIELDS);

  const present = UPDATABLE_FIELDS.filter((f) => body[f] !== undefined);
  if (!present.length) {
    throw new ApiError(400, 'Provide at least one field to update.', {
      code: 'VALIDATION_ERROR',
      details: { updatable: UPDATABLE_FIELDS },
    });
  }

  const out = {};
  if (body.companyName !== undefined) out.companyName = common.str(body.companyName, 'companyName', { max: MAX.companyName });
  if (body.companyType !== undefined) out.companyType = common.enumValue(body.companyType, 'companyType', [...COMPANY_TYPES]);
  if (body.companyEmail !== undefined) out.companyEmail = common.email(body.companyEmail, 'companyEmail');
  if (body.companyPhone !== undefined) out.companyPhone = common.phone(body.companyPhone, 'companyPhone');
  if (body.employeeCount !== undefined) out.employeeCount = common.integer(body.employeeCount, 'employeeCount', { min: 0, max: MAX_EMPLOYEE_COUNT });
  if (body.lastYearRevenue !== undefined) out.lastYearRevenue = common.decimalAmount(body.lastYearRevenue, 'lastYearRevenue');
  if (body.revenueCurrency !== undefined) out.revenueCurrency = validateCurrency(body.revenueCurrency);
  if (body.address !== undefined) out.address = validateAddress(body.address);

  return out;
}

/** Validate PUT /companies/:companyId/accounting-manager body. */
function validateAccountingManagerAssignment(body = {}) {
  common.rejectUnknown(body, ['accountingManagerUserId']);
  common.requireFields(body, ['accountingManagerUserId']);
  return {
    accountingManagerUserId: common.parseId(body.accountingManagerUserId, 'accountingManagerUserId'),
  };
}

/** Validate POST /companies/:companyId/specialists body. */
function validateSpecialistAssignment(body = {}) {
  common.rejectUnknown(body, ['specialistUserId', 'specializationCodes']);
  common.requireFields(body, ['specialistUserId', 'specializationCodes']);

  const specialistUserId = common.parseId(body.specialistUserId, 'specialistUserId');

  const codes = body.specializationCodes;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw common.fieldError('specializationCodes', 'specializationCodes must be a non-empty array.', 'Provide at least one specialization code.');
  }

  // Normalise (trim + upper-case), reject blanks, and de-duplicate. Existence of
  // each code is verified against the specializations table in the service.
  const normalised = [];
  for (const c of codes) {
    if (typeof c !== 'string' || !c.trim()) {
      throw common.fieldError('specializationCodes', 'Each specialization code must be a non-empty string.', 'Codes must be non-empty strings.');
    }
    const code = c.trim().toUpperCase();
    if (code.length > common.LIMITS.specializationCode) {
      throw common.fieldError('specializationCodes', 'specialization code is too long.', `Code must be at most ${common.LIMITS.specializationCode} characters.`);
    }
    if (!normalised.includes(code)) normalised.push(code);
  }

  return { specialistUserId, specializationCodes: normalised };
}

/** `?limit=&offset=&sort=&order=` for GET /companies. */
const COMPANY_SORTABLE = ['createdAt', 'companyName', 'status', 'updatedAt'];

function validateCompanyListQuery(query = {}) {
  common.rejectUnknown(query, ['limit', 'offset', 'sort', 'order', 'status', 'search'], 'query string');

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: COMPANY_SORTABLE,
    defaultSort: 'createdAt',
  });

  const status = query.status === undefined || query.status === null || query.status === ''
    ? null
    : common.enumValue(query.status, 'status', ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']);

  const search = query.search === undefined || query.search === null || query.search === ''
    ? null
    : common.str(query.search, 'search', { max: 255, required: false });

  return { ...page, status, search };
}

/** `?limit=&offset=&role=` for GET /users. */
function validateUserListQuery(query = {}) {
  common.rejectUnknown(query, ['limit', 'offset', 'sort', 'order', 'role', 'search'], 'query string');

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: ['firstName', 'lastName', 'email', 'createdAt'],
    defaultSort: 'firstName',
  });

  const role = query.role === undefined || query.role === null || query.role === ''
    ? null
    : common.enumValue(query.role, 'role', ['ADMIN', 'ACCOUNTING_MANAGER', 'SPECIALIST', 'CUSTOMER']);

  const search = query.search === undefined || query.search === null || query.search === ''
    ? null
    : common.str(query.search, 'search', { max: 255, required: false });

  return { ...page, role, search };
}

/** `?limit=&offset=` for GET /companies/:companyId/specialists. */
function validateSpecialistListQuery(query = {}) {
  common.rejectUnknown(query, ['limit', 'offset', 'sort', 'order', 'includeInactive'], 'query string');

  const page = common.pagination(query, {
    defaultLimit: 50,
    maxLimit: 200,
    sortable: ['assignedAt', 'specialistUserId'],
    defaultSort: 'assignedAt',
  });

  return { ...page, includeInactive: common.boolean(query.includeInactive, 'includeInactive', { defaultValue: false }) };
}

module.exports = {
  validateCompanyOnboarding,
  validateCompanyUpdate,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
  validateCompanyListQuery,
  validateUserListQuery,
  validateSpecialistListQuery,
  parseId: common.parseId,
  COMPANY_TYPES,
  MAX_EMPLOYEE_COUNT,
};
