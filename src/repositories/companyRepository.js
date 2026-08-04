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

/** A company with owner, manager, and its primary address joined. */
function findCompanyDetail(client, companyId) {
  return client.company.findFirst({
    where: { id: companyId, deletedAt: null },
    include: {
      ...COMPANY_WITH_PEOPLE,
      addresses: {
        where: { isPrimary: true },
        include: { address: true },
        take: 1,
      },
    },
  });
}

/**
 * Every live company the user can reach, in one query.
 *
 * The three ways in are deliberately the same three the read-authorization rule
 * recognises, so the list can never show a company that a subsequent detail call
 * would refuse: owned, managed as accounting manager, or served through an ACTIVE
 * specialist assignment. An ADMIN skips the filter entirely.
 */
function companyAccessFilter({ userId, isAdmin }) {
  if (isAdmin) return {};
  return {
    OR: [
      { ownerUserId: userId },
      { accountingManagerUserId: userId },
      { specialistAssignments: { some: { specialistUserId: userId, assignmentStatus: 'ACTIVE' } } },
    ],
  };
}

function buildCompanyListWhere({ userId, isAdmin, status, search }) {
  return {
    deletedAt: null,
    ...companyAccessFilter({ userId, isAdmin }),
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { companyName: { contains: search, mode: 'insensitive' } },
            { companyEmail: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

function listCompaniesForUser(client, { userId, isAdmin, status, search, limit, offset, sort, order }) {
  return client.company.findMany({
    where: buildCompanyListWhere({ userId, isAdmin, status, search }),
    include: {
      ...COMPANY_WITH_PEOPLE,
      addresses: { where: { isPrimary: true }, include: { address: true }, take: 1 },
    },
    orderBy: { [sort]: order },
    take: limit,
    skip: offset,
  });
}

function countCompaniesForUser(client, { userId, isAdmin, status, search }) {
  return client.company.count({ where: buildCompanyListWhere({ userId, isAdmin, status, search }) });
}

function createCompany(client, data) {
  return client.company.create({ data });
}

function updateCompany(client, companyId, data) {
  return client.company.update({ where: { id: companyId }, data });
}

/**
 * Soft-delete a company.
 *
 * The tombstone column existed and every read already filtered on it, but
 * nothing ever set it — so there was no way to remove a company at all. A soft
 * delete rather than a real one because billing history, assignments, and
 * payments all reference the row and must survive for audit.
 */
function softDeleteCompany(client, companyId, deletedAt) {
  return client.company.update({
    where: { id: companyId },
    data: { deletedAt, status: 'ARCHIVED' },
  });
}

/** The primary address row linked to a company, or null. */
async function findPrimaryAddress(client, companyId) {
  const link = await client.companyAddress.findFirst({
    where: { companyId, isPrimary: true },
    include: { address: true },
  });
  return link?.address ?? null;
}

function updateAddress(client, addressId, data) {
  return client.address.update({ where: { id: addressId }, data });
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
      specialist: { select: { id: true, firstName: true, lastName: true, email: true } },
      specialization: true,
    },
    orderBy: [{ specialistUserId: 'asc' }, { specializationId: 'asc' }],
  });
}

/** A page of a company's assignments, with optional inactive rows. */
function listAssignmentsPage(client, companyId, { includeInactive, limit, offset, sort, order }) {
  const where = { companyId, ...(includeInactive ? {} : { assignmentStatus: 'ACTIVE' }) };
  return client.companySpecialistAssignment.findMany({
    where,
    include: {
      specialist: { select: { id: true, firstName: true, lastName: true, email: true } },
      specialization: true,
    },
    orderBy: { [sort]: order },
    take: limit,
    skip: offset,
  });
}

function countAssignments(client, companyId, { includeInactive }) {
  return client.companySpecialistAssignment.count({
    where: { companyId, ...(includeInactive ? {} : { assignmentStatus: 'ACTIVE' }) },
  });
}

/* --------------------------- user directory ------------------------------- */

/**
 * The user directory backing the "who can I assign?" pickers.
 *
 * This exists because three endpoints required a `userId` that the frontend had
 * no way to discover: assigning an accounting manager, assigning a specialist,
 * and (previously) naming an inviter. A required id with no lookup makes the
 * screen unbuildable.
 *
 * Only ACTIVE users are listed, and only the fields a picker needs — never a
 * password hash, never login-security columns.
 */
const DIRECTORY_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
};

function buildDirectoryWhere({ role, search }) {
  return {
    status: 'ACTIVE',
    ...(role ? { role: { code: role } } : {}),
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

function listDirectoryUsers(client, { role, search, limit, offset, sort, order }) {
  return client.user.findMany({
    where: buildDirectoryWhere({ role, search }),
    select: DIRECTORY_SELECT,
    orderBy: { [sort]: order },
    take: limit,
    skip: offset,
  });
}

function countDirectoryUsers(client, { role, search }) {
  return client.user.count({ where: buildDirectoryWhere({ role, search }) });
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
  DIRECTORY_SELECT,
  findUserWithRole,
  findUserByEmail,
  findCompanyById,
  findCompanyByEmail,
  findCompanyWithPeople,
  findCompanyDetail,
  listCompaniesForUser,
  countCompaniesForUser,
  createCompany,
  updateCompany,
  softDeleteCompany,
  createAddress,
  updateAddress,
  findPrimaryAddress,
  createCompanyAddress,
  findSpecializationsByCodes,
  findActiveAssignments,
  createAssignment,
  findAssignmentInCompany,
  findActiveAssignmentForUser,
  deactivateAssignment,
  listActiveAssignments,
  listAssignmentsPage,
  countAssignments,
  listDirectoryUsers,
  countDirectoryUsers,
  findIdempotencyKey,
  createIdempotencyKey,
};
