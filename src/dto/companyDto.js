'use strict';

/**
 * Response DTOs for the company flows. These are the ONLY shapes that leave the
 * service, so the API contract is defined in one place and internal columns
 * (soft-delete tombstones, raw FK ids we don't want to expose, etc.) never leak
 * by accident. Every id is serialized as a number, matching the integer surrogate
 * keys used throughout the schema.
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
    user_id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
  };
}

/** The company object returned by onboarding and manager assignment. */
function toCompany(company) {
  return {
    id: company.id,
    company_name: company.companyName,
    company_type: company.companyType,
    company_email: company.companyEmail,
    company_phone: company.companyPhone,
    employee_count: company.employeeCount,
    last_year_revenue: decimalString(company.lastYearRevenue),
    revenue_currency: company.revenueCurrency,
    owner_user_id: company.ownerUserId,
    accounting_manager_user_id: company.accountingManagerUserId ?? null,
    status: company.status,
    onboarding_completed: company.onboardingCompleted,
    created_at: iso(company.createdAt),
    updated_at: iso(company.updatedAt),
  };
}

/** An address row rendered back to the client. */
function toAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    address_line_1: address.line1,
    address_line_2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    postal_code: address.postalCode ?? null,
    country: address.country,
    country_code: address.countryCode ?? null,
  };
}

/** The full onboarding response: company + its primary address. */
function toCompanyOnboardingResponse({ company, address }) {
  return {
    company: toCompany(company),
    primary_address: toAddress(address),
  };
}

/** One specialist-assignment row (used by GET /specialists and POST result). */
function toAssignment(assignment) {
  return {
    assignment_id: assignment.id,
    company_id: assignment.companyId,
    specialist_user_id: assignment.specialistUserId,
    specialization_code: assignment.specialization?.specializationCode ?? null,
    specialization_name: assignment.specialization?.specializationName ?? null,
    assignment_status: assignment.assignmentStatus,
    assigned_at: iso(assignment.assignedAt),
    unassigned_at: iso(assignment.unassignedAt),
    specialist: assignment.specialist ? toPerson(assignment.specialist) : undefined,
  };
}

/**
 * The team payload:
 *   { company_id, owner, accounting_manager, specialists: [{ ..., specializations: [codes] }] }
 * `assignments` is the list of ACTIVE assignments (with specialist + specialization
 * included); this collapses them to one entry per specialist with a code array.
 */
function toTeam({ company, assignments }) {
  const bySpecialist = new Map();
  for (const a of assignments) {
    const key = a.specialistUserId;
    if (!bySpecialist.has(key)) {
      bySpecialist.set(key, {
        ...toPerson(a.specialist),
        specializations: [],
      });
    }
    const code = a.specialization?.specializationCode;
    const entry = bySpecialist.get(key);
    if (code && !entry.specializations.includes(code)) entry.specializations.push(code);
  }

  return {
    company_id: company.id,
    owner: toPerson(company.owner),
    accounting_manager: toPerson(company.accountingManager),
    specialists: [...bySpecialist.values()],
  };
}

module.exports = {
  toCompany,
  toAddress,
  toCompanyOnboardingResponse,
  toAssignment,
  toTeam,
  toPerson,
};
