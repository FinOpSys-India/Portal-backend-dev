'use strict';

/**
 * Data access for projects.
 *
 * Every function takes the Prisma client as its first argument — `prisma` for a
 * standalone read, or the transaction client `tx` inside `$transaction` — the
 * same convention as companyRepository and userRepository, and what lets the
 * create path resolve the company's staffing and insert the project in one
 * atomic unit without this file knowing whether it is inside a transaction.
 *
 * Soft deletes are filtered HERE rather than in the service, so no caller can
 * forget: `deleted_at IS NULL` is part of every read below. A project that has
 * been removed keeps its row for history and is invisible to the API.
 */

/**
 * The columns a project row needs to render, and nothing else.
 *
 * An allowlist. The joins are the four questions the table asks of every row —
 * which company, which service, who is staffed on it, who created it — resolved
 * in one query instead of four round trips per row.
 *
 * The specialist join carries `specificRole` where the creator's does not. For
 * the person who opened a project, "Founder" (their job title) is what tells two
 * colleagues apart; for the person doing the work, what matters is which KIND of
 * specialist they are — a tax specialist and a bookkeeper are not
 * interchangeable, and the screen shows that beside the name.
 */
const PROJECT_SELECT = {
  id: true,
  companyId: true,
  projectName: true,
  deadlineDate: true,
  servicePlanId: true,
  assignedSpecialistUserId: true,
  createdByUserId: true,
  status: true,
  progressBar: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { id: true, companyName: true } },
  servicePlan: {
    select: {
      id: true,
      planCode: true,
      planName: true,
      specialization: {
        select: { id: true, specializationCode: true, specializationName: true },
      },
    },
  },
  // Null on a project nobody is staffed on yet — a real and common state, not a
  // missing value. See the note on the column in 17_add_projects.sql.
  assignedSpecialist: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      jobTitle: true,
      avatarKey: true,
      specificRole: { select: { code: true } },
    },
  },
  // jobTitle is included because "Founder" beside a name is what tells two
  // colleagues apart in a list; no password hash, no login-security column, and
  // no address.
  createdBy: {
    select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, avatarKey: true },
  },
};

/* -------------------------------------------------------------------------- */
/* the service catalog a company may open a project against                   */
/* -------------------------------------------------------------------------- */

/**
 * The plans on a company's ACTIVE subscription — the services it is paying for.
 *
 * This is what the "Service" dropdown on the project form is built from, and it
 * is also what the create endpoint validates against, so the form can never
 * offer a choice the write would refuse.
 *
 * The chain is entirely the schema's own: the ACTIVE subscription's items name
 * their `service_plan`, and each plan carries a `specialization_id` — which is
 * the service. At most one ACTIVE subscription exists per company (a partial
 * unique index enforces it), so this returns that one subscription's items.
 *
 * A company with no ACTIVE subscription gets an empty list. That is a real
 * state, not an error: it has been onboarded but has not checked out.
 */
function listPurchasedPlans(client, companyId) {
  return client.companySubscriptionItem.findMany({
    where: {
      quantity: { gt: 0 },
      subscription: { companyId, status: 'ACTIVE' },
    },
    select: {
      quantity: true,
      servicePlan: {
        select: {
          id: true,
          planCode: true,
          planName: true,
          isAddOn: true,
          quantityLabel: true,
          specializationId: true,
          specialization: {
            select: { id: true, specializationCode: true, specializationName: true },
          },
        },
      },
    },
    orderBy: { servicePlanId: 'asc' },
  });
}

/* -------------------------------------------------------------------------- */
/* company-side lookups the project rules need                                */
/* -------------------------------------------------------------------------- */

/**
 * The company as the project rules see it: who owns it, who manages it, and the
 * three standing-specialist columns the auto-assignment reads.
 *
 * Soft-deleted companies are excluded — a project cannot be opened against a
 * company that has been archived, and one that already exists on it should stop
 * appearing.
 */
function findCompanyForProjects(client, companyId) {
  return client.company.findFirst({
    where: { id: companyId, deletedAt: null },
    select: {
      id: true,
      companyName: true,
      ownerUserId: true,
      accountingManagerUserId: true,
      bookkeepingSpecialistUserId: true,
      payrollSpecialistUserId: true,
      taxSpecialistUserId: true,
    },
  });
}

/** Is this user a teammate on the company? (company_members — the FACT, post-accept.) */
function findMembership(client, { companyId, userId }) {
  return client.companyMember.findFirst({
    where: { companyId, userId },
    select: { id: true },
  });
}

/**
 * The company's ACTIVE specialist assignments for one specialization, newest
 * first — the FALLBACK the auto-assignment uses when the standing column on
 * `companies` is empty (or does not exist, as for FA_Q).
 */
function findActiveAssignmentsForSpecialization(client, { companyId, specializationId }) {
  return client.companySpecialistAssignment.findMany({
    where: { companyId, specializationId, assignmentStatus: 'ACTIVE' },
    select: { specialistUserId: true, assignedAt: true },
    orderBy: { assignedAt: 'desc' },
  });
}

/**
 * Which of these users may actually work the service in question.
 *
 * Three conditions, and all three are load-bearing:
 *
 *   status ACTIVE       an invited-but-never-signed-up or hibernated account is
 *                       a name in a column, not somebody who can do the work.
 *   role SPECIALIST     what makes them a specialist at all.
 *   specificRole        what makes them the RIGHT specialist — a Tax Specialist
 *                       is not eligible for a company's bookkeeping.
 *
 * The top-level role check is NOT redundant with the specific-role one:
 * `specific_roles.code` is unique only within its parent role, so matching on it
 * alone could select a user whose SPECIALIST_3 belongs to some other role
 * entirely. companyRepository.listEligibleSpecialists pairs them for the same
 * reason, and the two must agree — this is the rule the staffing screens
 * enforce, applied again at the moment a project is opened.
 *
 * `specificRoleCode` may be null, for a specialization the catalog maps to no
 * specialist kind. Then any ACTIVE specialist assigned to that specialization
 * qualifies, which is the truthful answer rather than a silent "nobody".
 */
function findEligibleSpecialists(client, { userIds, specificRoleCode }) {
  if (!userIds.length) return Promise.resolve([]);
  return client.user.findMany({
    where: {
      id: { in: userIds },
      status: 'ACTIVE',
      role: { code: 'SPECIALIST' },
      ...(specificRoleCode ? { specificRole: { code: specificRoleCode } } : {}),
    },
    select: { id: true },
  });
}

/** Is this user an ACTIVE specialist on the company, for any specialization? */
function findActiveAssignmentForUser(client, { companyId, userId }) {
  return client.companySpecialistAssignment.findFirst({
    where: { companyId, specialistUserId: userId, assignmentStatus: 'ACTIVE' },
    select: { id: true },
  });
}

/* -------------------------------------------------------------------------- */
/* projects                                                                   */
/* -------------------------------------------------------------------------- */

function buildProjectWhere({ companyId, status, assignedSpecialistUserId, search }) {
  const where = { companyId, deletedAt: null };

  if (status) where.status = status;
  if (assignedSpecialistUserId) where.assignedSpecialistUserId = assignedSpecialistUserId;

  // Name only. Searching the description would make a long note match a query
  // the user typed for a title, which reads as a bug from the other side of the
  // screen.
  if (search) where.projectName = { contains: search, mode: 'insensitive' };

  return where;
}

/**
 * One page of a company's projects.
 *
 * The default order is the deadline, ascending — soonest first — because that is
 * the question the table exists to answer. `sort`/`order` come from
 * common.pagination, which validates the column against an allowlist before it
 * ever reaches here.
 */
function listProjects(client, { companyId, status, assignedSpecialistUserId, search, limit, offset, sort, order }) {
  return client.project.findMany({
    where: buildProjectWhere({ companyId, status, assignedSpecialistUserId, search }),
    select: PROJECT_SELECT,
    // The secondary sort on id is not decoration: several projects routinely
    // share a deadline, and without a tiebreaker their relative order is
    // whatever the planner returns — which can differ between two requests for
    // the same page and make a row appear twice while another is skipped.
    orderBy: [{ [sort || 'deadlineDate']: order || 'asc' }, { id: 'desc' }],
    take: limit,
    skip: offset,
  });
}

function countProjects(client, { companyId, status, assignedSpecialistUserId, search }) {
  return client.project.count({
    where: buildProjectWhere({ companyId, status, assignedSpecialistUserId, search }),
  });
}

/** One project in full, or null when it is missing or soft-deleted. */
function findProjectDetail(client, projectId) {
  return client.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: PROJECT_SELECT,
  });
}

/**
 * The few columns the authorization step needs, without the joins.
 *
 * Kept separate from findProjectDetail because it runs on every write route,
 * where loading the company, the plan, and two user records only to decide
 * whether the caller may proceed is work thrown away on the 403 path.
 */
function findProjectForAccess(client, projectId) {
  return client.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, companyId: true, createdByUserId: true, assignedSpecialistUserId: true, status: true },
  });
}

function createProject(client, data) {
  return client.project.create({ data, select: PROJECT_SELECT });
}

function updateProject(client, projectId, data) {
  return client.project.update({ where: { id: projectId }, data, select: PROJECT_SELECT });
}

function softDeleteProject(client, projectId, deletedAt) {
  return client.project.update({
    where: { id: projectId },
    data: { deletedAt },
    select: { id: true, deletedAt: true },
  });
}

/**
 * The company's live projects that nobody is staffed on.
 *
 * Read by the re-staffing sweep: when a company's specialists change, these are
 * the projects that can now be filled in. COMPLETED work is deliberately left
 * alone — attaching a specialist to something that finished before they arrived
 * would rewrite history, which is the one thing the stored column exists to
 * prevent.
 */
function listUnassignedProjects(client, companyId) {
  return client.project.findMany({
    where: {
      companyId,
      deletedAt: null,
      assignedSpecialistUserId: null,
      status: { in: ['TODO', 'ACTIVE'] },
    },
    select: {
      id: true,
      servicePlan: {
        select: { specialization: { select: { id: true, specializationCode: true } } },
      },
    },
  });
}

/** Point a project at a specialist. Used by the create path and by the sweep. */
function setAssignedSpecialist(client, projectId, specialistUserId) {
  return client.project.update({
    where: { id: projectId },
    data: { assignedSpecialistUserId: specialistUserId },
    select: { id: true, assignedSpecialistUserId: true },
  });
}

module.exports = {
  PROJECT_SELECT,
  listPurchasedPlans,
  findCompanyForProjects,
  findMembership,
  findActiveAssignmentsForSpecialization,
  findEligibleSpecialists,
  findActiveAssignmentForUser,
  listProjects,
  countProjects,
  findProjectDetail,
  findProjectForAccess,
  createProject,
  updateProject,
  softDeleteProject,
  listUnassignedProjects,
  setAssignedSpecialist,
};
