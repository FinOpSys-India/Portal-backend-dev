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
 * The subdivisions of the CUSTOMER role, as seeded in `specific_roles`: OWNER
 * (holds the company) and TEAM (a teammate on it).
 *
 * Listed here only to bound a query-string FILTER. Which sub-role an invitation
 * actually grants is never decided from this list — the id comes from the client
 * and is resolved and cross-checked against the database in the service, so a
 * new sub-role added to the table works without editing this file.
 */
const CUSTOMER_SPECIFIC_ROLES = ['OWNER', 'TEAM'];

/**
 * Upper bound on head count. Previously unbounded here while the billing side
 * capped the same concept at 5000, so `employeeCount: 999999999` was accepted at
 * onboarding and rejected at checkout.
 */
const MAX_EMPLOYEE_COUNT = 1_000_000;

/**
 * Upper bound on a single specialist-assignment submission. There are four
 * specializations in the catalog, so anything beyond that cannot be a real
 * staffing decision — this only stops a client looping.
 */
const MAX_SPECIALIST_ASSIGNMENTS = 20;

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

/**
 * Validate PUT /admin/companies/:companyId/specialists.
 *
 *   { assignments: [ { specializationCode, specialistUserId }, … ] }
 *
 * The whole staffing of the company's active services is submitted at once, so
 * the shape checked here is a LIST of one specialist per service. Two rules are
 * enforced on the payload itself because they are answerable without touching
 * the database, and reaching a transaction only to reject a plainly malformed
 * body wastes a connection:
 *
 *   - the same service may not appear twice (which specialist would win?)
 *   - the same specialist may not appear twice. A user holds exactly ONE specific
 *     role, so they can only ever be eligible for one service; the same person
 *     against two services is a client bug every time, and saying so precisely
 *     beats letting it fail later as a role mismatch.
 *
 * Everything that needs the database — is the service active, does this user
 * exist, are they active, do they hold the role this service requires, is every
 * active service covered — is the service layer's job, and is checked inside the
 * write transaction.
 */
function validateSpecialistAssignments(body = {}) {
  common.rejectUnknown(body, ['assignments']);
  common.requireFields(body, ['assignments']);

  const rows = body.assignments;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw common.fieldError('assignments', 'assignments must be a non-empty array.', 'Select a specialist for each service.');
  }
  if (rows.length > MAX_SPECIALIST_ASSIGNMENTS) {
    throw common.fieldError('assignments', `assignments cannot exceed ${MAX_SPECIALIST_ASSIGNMENTS} entries.`, 'Too many assignments.');
  }

  const seenServices = new Set();
  const seenSpecialists = new Set();
  const out = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw common.fieldError('assignments', 'Each assignment must be an object.', 'Invalid assignment.');
    }
    common.rejectUnknown(row, ['specializationCode', 'specialistUserId'], 'assignment');
    common.requireFields(row, ['specializationCode', 'specialistUserId']);

    const specializationCode = common
      .str(row.specializationCode, 'specializationCode', { max: common.LIMITS.specializationCode })
      .toUpperCase();
    const specialistUserId = common.parseId(row.specialistUserId, 'specialistUserId');

    if (seenServices.has(specializationCode)) {
      throw new ApiError(400, 'Each service may be assigned only once.', {
        code: 'VALIDATION_ERROR',
        fields: { assignments: 'One specialist per service.' },
        details: { duplicateSpecializationCode: specializationCode },
      });
    }
    if (seenSpecialists.has(specialistUserId)) {
      throw new ApiError(400, 'The same specialist cannot be assigned to two services.', {
        code: 'VALIDATION_ERROR',
        fields: { assignments: 'Choose a different specialist for each service.' },
        details: { duplicateSpecialistUserId: specialistUserId },
      });
    }
    seenServices.add(specializationCode);
    seenSpecialists.add(specialistUserId);

    out.push({ specializationCode, specialistUserId });
  }

  return out;
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

/**
 * `?search=&includeInactive=&limit=&offset=&sort=&order=` for
 * GET /admin/accounting-managers.
 *
 * Note what is NOT sortable: `companyCount`. Ordering by the size of a joined
 * collection needs the count computed in the database, and the count this
 * endpoint reports deliberately excludes soft-deleted companies — a filter the
 * ORM cannot apply to a relation-count sort. Offering the option would mean the
 * order and the numbers displayed beside it came from two different definitions
 * of "how many", which is worse than not offering it. Sort by name and read the
 * counts.
 */
function validateAccountingManagerListQuery(query = {}) {
  common.rejectUnknown(
    query,
    ['limit', 'offset', 'sort', 'order', 'search', 'includeInactive'],
    'query string'
  );

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: ['firstName', 'lastName', 'email', 'createdAt'],
    defaultSort: 'firstName',
  });

  const search = query.search === undefined || query.search === null || query.search === ''
    ? null
    : common.str(query.search, 'search', { max: 255, required: false });

  return {
    ...page,
    // Ascending by name is what a directory should default to; `pagination`
    // defaults to descending, which is right for dated lists and wrong here.
    order: query.order === undefined || query.order === null || query.order === '' ? 'asc' : page.order,
    search,
    includeInactive: common.boolean(query.includeInactive, 'includeInactive', { defaultValue: false }),
  };
}

/**
 * `?companyId=&search=&includeInactive=&limit=&offset=&sort=&order=` — the query
 * contract shared by the people directories: GET /specialists and GET /customers.
 *
 * One function rather than two identical ones, because the two endpoints must
 * accept the same filter under the same name: a client that learns
 * `?companyId=&search=` on one of them has learned it on both, and a divergence
 * between them would be a bug nobody notices until a screen silently stops
 * filtering.
 *
 * `companyId` is the global company filter the frontend applies across screens.
 * It is validated here only as a SHAPE; whether the caller may see that company —
 * and whether they are even allowed to omit it — is decided in the service,
 * against the database. A filter must never be a way to reach data the caller
 * could not otherwise reach.
 */
function validateScopedDirectoryQuery(query = {}) {
  common.rejectUnknown(
    query,
    ['limit', 'offset', 'sort', 'order', 'search', 'includeInactive', 'companyId'],
    'query string'
  );

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: ['firstName', 'lastName', 'email', 'createdAt'],
    defaultSort: 'firstName',
  });

  const search = query.search === undefined || query.search === null || query.search === ''
    ? null
    : common.str(query.search, 'search', { max: 255, required: false });

  return {
    ...page,
    order: query.order === undefined || query.order === null || query.order === '' ? 'asc' : page.order,
    search,
    includeInactive: common.boolean(query.includeInactive, 'includeInactive', { defaultValue: false }),
    companyId:
      query.companyId === undefined || query.companyId === null || query.companyId === ''
        ? null
        : common.parseId(query.companyId, 'companyId'),
  };
}

/**
 * `?companyId=` for GET /specialists/:userId — and nothing else.
 *
 * The profile takes no paging, no search and no sort: it is one person, and a
 * parameter the endpoint would ignore is worse than one it rejects, because the
 * client that sent it believes it did something. `rejectUnknown` therefore does
 * most of the work here.
 *
 * Whether `companyId` is required, forbidden, or reachable at all depends on the
 * caller's role and is decided in the service — this validates the SHAPE only.
 */
function validateSpecialistDetailQuery(query = {}) {
  common.rejectUnknown(query, ['companyId'], 'query string');

  return {
    companyId:
      query.companyId === undefined || query.companyId === null || query.companyId === ''
        ? null
        : common.parseId(query.companyId, 'companyId'),
  };
}

/**
 * `?companyId=` for GET /customers/:userId — the same shape as the specialist
 * profile above, and for the same reason: one person, so no paging, no search
 * and no sort.
 *
 * Kept as its own function rather than shared with the specialist profile
 * because the rules BEHIND the parameter differ — there it is forbidden to an
 * admin and required of a manager; here it is required of everyone, because the
 * endpoint has one audience and no unscoped form. Both decisions are the
 * service's; this validates the SHAPE only.
 */
function validateCustomerDetailQuery(query = {}) {
  common.rejectUnknown(query, ['companyId'], 'query string');

  return {
    companyId:
      query.companyId === undefined || query.companyId === null || query.companyId === ''
        ? null
        : common.parseId(query.companyId, 'companyId'),
  };
}

/**
 * `?companyId=&search=&specificRole=&includeInactive=&limit=&offset=&sort=&order=`
 * for GET /teammates.
 *
 * `companyId` is the global company filter the frontend applies across screens,
 * and here it is REQUIRED rather than optional. A teammate roster is a property
 * of one company; there is no meaningful unscoped version of it, and returning a
 * merged list across an owner's companies would silently mix people who cannot
 * see each other's accounts.
 *
 * Required as a SHAPE rule, so it is checked here. Whether the caller may see
 * that particular company is a different question entirely, decided in the
 * service against the database — a filter must never be a way to reach data the
 * caller could not otherwise reach.
 *
 * `specificRole` is constrained to the CUSTOMER subdivisions. It exists so the
 * screen can ask for TEAM specifically; left off, the answer is every teammate
 * on the roster, which is the same set unless a company gains other customer
 * sub-roles later.
 */
function validateTeammateListQuery(query = {}) {
  common.rejectUnknown(
    query,
    ['companyId', 'limit', 'offset', 'sort', 'order', 'search', 'specificRole', 'includeInactive'],
    'query string'
  );
  common.requireFields(query, ['companyId']);

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: ['firstName', 'lastName', 'email', 'createdAt'],
    defaultSort: 'firstName',
  });

  const search =
    query.search === undefined || query.search === null || query.search === ''
      ? null
      : common.str(query.search, 'search', { max: 255, required: false });

  return {
    ...page,
    companyId: common.parseId(query.companyId, 'companyId'),
    // A name-sorted list reads A-Z; the shared pagination helper defaults to
    // descending, which is right for dates and wrong here.
    order: query.order === undefined || query.order === null || query.order === '' ? 'asc' : page.order,
    search,
    specificRole:
      query.specificRole === undefined || query.specificRole === null || query.specificRole === ''
        ? null
        : common.enumValue(query.specificRole, 'specificRole', CUSTOMER_SPECIFIC_ROLES),
    includeInactive: common.boolean(query.includeInactive, 'includeInactive', { defaultValue: false }),
  };
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
  // Exported for validators/userValidator: a user's own address and a company's
  // address are the same real-world thing and must obey the same rules (real ISO
  // country code, postcode that matches it, canonical US state). Two copies of
  // that logic would be two rules the moment either is touched.
  validateAddress,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
  validateSpecialistAssignments,
  validateCompanyListQuery,
  validateUserListQuery,
  validateAccountingManagerListQuery,
  validateScopedDirectoryQuery,
  validateSpecialistDetailQuery,
  validateCustomerDetailQuery,
  validateTeammateListQuery,
  validateSpecialistListQuery,
  parseId: common.parseId,
  COMPANY_TYPES,
  MAX_EMPLOYEE_COUNT,
};
