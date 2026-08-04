'use strict';

/**
 * Response DTOs for the company flows. These are the ONLY shapes that leave the
 * service, so the API contract is defined in one place and internal columns
 * (soft-delete tombstones, raw FK ids we don't want to expose, etc.) never leak
 * by accident. Every id is serialized as a number, matching the integer surrogate
 * keys used throughout the schema.
 *
 * Keys are camelCase, matching every other module. The request side still
 * accepts snake_case (see middlewares/normalizeRequest), so a client written
 * against the older snake_case responses keeps working on the way IN — but there
 * is exactly one shape on the way OUT, which is what lets a client model the API
 * once instead of once per router.
 */

/** A Prisma Decimal (or string/number) rendered as a fixed-2 decimal string. */
function decimalString(value) {
  if (value === null || value === undefined) return null;
  // Prisma Decimal has toFixed; strings/numbers fall back to Number().
  if (typeof value.toFixed === 'function') return value.toFixed(2);
  return Number(value).toFixed(2);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

/** Minimal person view used inside the team payload. */
function toPerson(user) {
  if (!user) return null;
  return {
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email ?? null,
  };
}

/** The company object returned by onboarding, updates, and manager assignment. */
function toCompany(company) {
  return {
    id: company.id,
    companyName: company.companyName,
    companyType: company.companyType,
    companyEmail: company.companyEmail,
    companyPhone: company.companyPhone,
    employeeCount: company.employeeCount,
    lastYearRevenue: decimalString(company.lastYearRevenue),
    revenueCurrency: company.revenueCurrency,
    ownerUserId: company.ownerUserId,
    accountingManagerUserId: company.accountingManagerUserId ?? null,
    status: company.status,
    onboardingCompleted: company.onboardingCompleted,
    createdAt: iso(company.createdAt),
    updatedAt: iso(company.updatedAt),
  };
}

/** An address row rendered back to the client. */
function toAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    addressLine1: address.line1,
    addressLine2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    country: address.country,
    countryCode: address.countryCode ?? null,
  };
}

/** The full onboarding response: company + its primary address. */
function toCompanyOnboardingResponse({ company, address }) {
  return {
    company: toCompany(company),
    primaryAddress: toAddress(address),
  };
}

/**
 * A company with its primary address and the caller's relationship to it, used
 * by the detail and list endpoints. `accessRole` tells the frontend which
 * actions to render without it having to re-derive the authorization rules —
 * the server already knows the answer, and duplicating that logic in the client
 * is how the two drift apart.
 */
function toCompanyDetail({ company, address, accessRole }) {
  return {
    ...toCompany(company),
    primaryAddress: toAddress(address),
    owner: toPerson(company.owner),
    accountingManager: toPerson(company.accountingManager),
    ...(accessRole ? { accessRole } : {}),
  };
}

/** One specialist-assignment row (used by GET /specialists and the POST result). */
function toAssignment(assignment) {
  return {
    assignmentId: assignment.id,
    companyId: assignment.companyId,
    specialistUserId: assignment.specialistUserId,
    specializationCode: assignment.specialization?.specializationCode ?? null,
    specializationName: assignment.specialization?.specializationName ?? null,
    assignmentStatus: assignment.assignmentStatus,
    assignedAt: iso(assignment.assignedAt),
    unassignedAt: iso(assignment.unassignedAt),
    // Always present as a key — null rather than absent when the join was not
    // loaded, so a client can read `assignment.specialist?.userId` uniformly
    // instead of discovering that one endpoint omits the field entirely.
    specialist: toPerson(assignment.specialist),
  };
}

/**
 * The team payload:
 *   { companyId, owner, accountingManager, specialists: [{ ..., specializations }] }
 *
 * `assignments` is the list of ACTIVE assignments (with specialist +
 * specialization included); this collapses them to one entry per specialist.
 * Each specialization keeps its own `assignmentId`, so a "remove" button
 * rendered from this payload has the id it needs — previously it did not, and
 * the client had to call the specialists endpoint as well.
 */
function toTeam({ company, assignments }) {
  const bySpecialist = new Map();
  for (const a of assignments) {
    const key = a.specialistUserId;
    if (!bySpecialist.has(key)) {
      bySpecialist.set(key, { ...toPerson(a.specialist), specializations: [] });
    }
    const code = a.specialization?.specializationCode;
    if (!code) continue;
    const entry = bySpecialist.get(key);
    if (entry.specializations.some((s) => s.specializationCode === code)) continue;
    entry.specializations.push({
      assignmentId: a.id,
      specializationCode: code,
      specializationName: a.specialization?.specializationName ?? null,
    });
  }

  return {
    companyId: company.id,
    owner: toPerson(company.owner),
    accountingManager: toPerson(company.accountingManager),
    specialists: [...bySpecialist.values()],
  };
}

/** A user as returned by the directory endpoint. Never includes a password hash. */
function toDirectoryUser(user) {
  return {
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.code ?? null,
    specificRole: user.specificRole?.code ?? null,
    jobTitle: user.jobTitle ?? null,
    status: user.status,
  };
}

module.exports = {
  toCompany,
  toCompanyDetail,
  toAddress,
  toCompanyOnboardingResponse,
  toAssignment,
  toTeam,
  toPerson,
  toDirectoryUser,
};
