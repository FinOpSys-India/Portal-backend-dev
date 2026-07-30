'use strict';

/**
 * Data-access layer for the company flows. Every function takes a Prisma client
 * as its first argument — pass the shared `prisma` for a standalone read, or a
 * transaction client (`tx`) to enrol the write in an in-flight transaction. This
 * keeps all company table access in one place while leaving transaction control
 * to the service.
 *
 * No business rules live here: these are thin, reusable queries. Role checks,
 * authorization, and orchestration belong in companyService.
 */

/** Columns needed to check a user's identity and role. */
const USER_ROLE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
};

/** A company row with owner + accounting-manager people joined. */
const COMPANY_WITH_PEOPLE = {
  owner: { select: { id: true, firstName: true, lastName: true } },
  accountingManager: { select: { id: true, firstName: true, lastName: true } },
};

/* -------------------------------- users ---------------------------------- */

function findUserWithRole(client, userId) {
  return client.user.findUnique({ where: { id: userId }, select: USER_ROLE_SELECT });
}

/**
 * Any user whose login email is this address. Case-insensitive: `users.email` is
 * unique but the column is plain VARCHAR, so 'Ada@x.com' and 'ada@x.com' can both
 * exist, and a rule that only caught the exact casing would not be a rule.
 */
function findUserByEmail(client, email) {
  return client.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true },
  });
}

/* ------------------------------ companies -------------------------------- */

/** Fetch a non-deleted company by id (no joins). */
function findCompanyById(client, companyId) {
  return client.company.findFirst({ where: { id: companyId, deletedAt: null } });
}

/** Fetch a non-deleted company by id with owner + accounting manager joined. */
function findCompanyWithPeople(client, companyId) {
  return client.company.findFirst({
    where: { id: companyId, deletedAt: null },
    include: COMPANY_WITH_PEOPLE,
  });
}

/**
 * Any live company already using this email.
 *
 * `findFirst`, not `findUnique`: the unique index behind this rule is functional
 * and partial (lower(company_email) WHERE deleted_at IS NULL), which Prisma
 * cannot model as a unique field — so there is no findUnique to call. Matched
 * case-insensitively for the same reason the index is on lower().
 */
function findCompanyByEmail(client, email) {
  return client.company.findFirst({
    where: { companyEmail: { equals: email, mode: 'insensitive' }, deletedAt: null },
  });
}

function createCompany(client, data) {
  return client.company.create({ data });
}

function updateCompany(client, companyId, data) {
  return client.company.update({ where: { id: companyId }, data });
}

/* ------------------------------ addresses -------------------------------- */

function createAddress(client, data) {
  return client.address.create({ data });
}

function createCompanyAddress(client, data) {
  return client.companyAddress.create({ data });
}

/* --------------------------- specializations ----------------------------- */

/** Resolve a set of specialization codes to their rows (active only). */
function findSpecializationsByCodes(client, codes) {
  return client.specialization.findMany({
    where: { specializationCode: { in: codes }, isActive: true },
  });
}

/* ------------------------- specialist assignments ------------------------ */

/** Active assignments for a company/specialist within a set of specialization ids. */
function findActiveAssignments(client, { companyId, specialistUserId, specializationIds }) {
  return client.companySpecialistAssignment.findMany({
    where: {
      companyId,
      specialistUserId,
      specializationId: { in: specializationIds },
      assignmentStatus: 'ACTIVE',
    },
  });
}

function createAssignment(client, data) {
  return client.companySpecialistAssignment.create({
    data,
    include: { specialization: true },
  });
}

/** A single assignment scoped to a company (so one company can't touch another's). */
function findAssignmentInCompany(client, { companyId, assignmentId }) {
  return client.companySpecialistAssignment.findFirst({
    where: { id: assignmentId, companyId },
  });
}

/** Does this user have any ACTIVE specialist assignment on the company? */
function findActiveAssignmentForUser(client, { companyId, userId }) {
  return client.companySpecialistAssignment.findFirst({
    where: { companyId, specialistUserId: userId, assignmentStatus: 'ACTIVE' },
  });
}

function deactivateAssignment(client, assignmentId, unassignedAt) {
  return client.companySpecialistAssignment.update({
    where: { id: assignmentId },
    data: { assignmentStatus: 'INACTIVE', unassignedAt },
    include: {
      specialist: { select: { id: true, firstName: true, lastName: true } },
      specialization: true,
    },
  });
}

/** All ACTIVE assignments for a company, with specialist + specialization joined. */
function listActiveAssignments(client, companyId) {
  return client.companySpecialistAssignment.findMany({
    where: { companyId, assignmentStatus: 'ACTIVE' },
    include: {
      specialist: { select: { id: true, firstName: true, lastName: true } },
      specialization: true,
    },
    orderBy: [{ specialistUserId: 'asc' }, { specializationId: 'asc' }],
  });
}

/* ----------------------------- idempotency ------------------------------- */

function findIdempotencyKey(client, { userId, idempotencyKey }) {
  return client.idempotencyKey.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
}

function createIdempotencyKey(client, data) {
  return client.idempotencyKey.create({ data });
}

module.exports = {
  USER_ROLE_SELECT,
  findUserWithRole,
  findUserByEmail,
  findCompanyById,
  findCompanyByEmail,
  findCompanyWithPeople,
  createCompany,
  updateCompany,
  createAddress,
  createCompanyAddress,
  findSpecializationsByCodes,
  findActiveAssignments,
  createAssignment,
  findAssignmentInCompany,
  findActiveAssignmentForUser,
  deactivateAssignment,
  listActiveAssignments,
  findIdempotencyKey,
  createIdempotencyKey,
};
