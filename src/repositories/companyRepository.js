'use strict';

const catalog = require('../config/serviceCatalog');

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

/**
 * Columns needed to check a user's identity and role.
 *
 * `email` is here because the accounting-manager assignment response has to name
 * the person the admin just attached — a row that says "assigned" without saying
 * to whom is not an answer. Deliberately still no passwordHash, no login-security
 * columns, no reset state: this select is the ONLY way a user reaches the company
 * flows, so what it omits can never leak from them.
 */
const USER_ROLE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
};

/**
 * A company row with owner + accounting-manager + per-line specialists joined.
 *
 * Everyone is listed by name AND address: two people called "Sarah J" are
 * otherwise indistinguishable in a picker, and that applies to the owner in an
 * admin's company table as much as to the staff in an assignment response.
 * Still nothing beyond the four identity columns — no passwordHash, no
 * login-security or reset state ever reaches these joins.
 */
const STAFF_PERSON_SELECT = { id: true, firstName: true, lastName: true, email: true };

const COMPANY_WITH_PEOPLE = {
  owner: { select: STAFF_PERSON_SELECT },
  accountingManager: { select: STAFF_PERSON_SELECT },
  bookkeepingSpecialist: { select: STAFF_PERSON_SELECT },
  payrollSpecialist: { select: STAFF_PERSON_SELECT },
  taxSpecialist: { select: STAFF_PERSON_SELECT },
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

/**
 * The where-clause behind every company list.
 *
 * `managedByUserId` narrows to the accounts a specific accounting manager is
 * responsible for. That is deliberately NARROWER than the general access filter,
 * which also lets someone through as an owner or an assigned specialist: "the
 * accounts I manage" is a different question from "companies I can see", and the
 * manager's own screen asks the first.
 *
 * SCOPE AND SEARCH ARE COMBINED WITH `AND`, and that is load-bearing. Both
 * clauses want the key `OR`, so spreading them into one object made the second
 * silently REPLACE the first — which meant a non-admin who typed anything into
 * the search box had their access filter dropped and matched against every
 * company in the database. A leak that only appeared once you searched.
 */
function buildCompanyListWhere({ userId, isAdmin, managedByUserId, status, search }) {
  const scope = managedByUserId
    ? { accountingManagerUserId: managedByUserId }
    : companyAccessFilter({ userId, isAdmin });

  const searchFilter = search
    ? {
        OR: [
          { companyName: { contains: search, mode: 'insensitive' } },
          { companyEmail: { contains: search, mode: 'insensitive' } },
        ],
      }
    : null;

  const base = { deletedAt: null, ...(status ? { status } : {}) };

  // Only nest when both are present; an unsearched list keeps the flat shape.
  if (searchFilter && Object.keys(scope).length) {
    return { ...base, AND: [scope, searchFilter] };
  }
  return { ...base, ...scope, ...(searchFilter ?? {}) };
}

function listCompaniesForUser(client, { userId, isAdmin, managedByUserId, status, search, limit, offset, sort, order }) {
  return client.company.findMany({
    where: buildCompanyListWhere({ userId, isAdmin, managedByUserId, status, search }),
    include: {
      ...COMPANY_WITH_PEOPLE,
      addresses: { where: { isPrimary: true }, include: { address: true }, take: 1 },
    },
    orderBy: { [sort]: order },
    take: limit,
    skip: offset,
  });
}

function countCompaniesForUser(client, { userId, isAdmin, managedByUserId, status, search }) {
  return client.company.count({
    where: buildCompanyListWhere({ userId, isAdmin, managedByUserId, status, search }),
  });
}

function createCompany(client, data) {
  return client.company.create({ data });
}

function updateCompany(client, companyId, data) {
  return client.company.update({ where: { id: companyId }, data });
}

/**
 * Set or clear a company's accounting manager, returning the row with both
 * people already joined.
 *
 * One statement rather than an update followed by a read: the caller needs the
 * manager's name and email back, and re-reading the row would open a window in
 * which a concurrent write is what gets reported. Pass `null` to remove.
 */
function setAccountingManager(client, companyId, accountingManagerUserId) {
  return client.company.update({
    where: { id: companyId },
    data: { accountingManagerUserId },
    include: COMPANY_WITH_PEOPLE,
  });
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

/* ------------------------- active services (billing) ---------------------- */

/**
 * The ACTIVE subscription of each company in one query, with every line item and
 * the service each item belongs to.
 *
 * Batched over a list of company ids on purpose. The admin table shows active
 * services, the billing date, and the team for every row on the page; asking per
 * company would be three queries per row, and a 25-row page would open 75
 * connections to render one screen.
 *
 * `service_plans.specialization_id` is what makes "which services is this
 * company paying for?" answerable without a second catalog — the join is already
 * in the schema. At most one ACTIVE subscription exists per company (partial
 * unique index), so the result maps one-to-one onto companies.
 */
function listActiveSubscriptionsForCompanies(client, companyIds) {
  if (!companyIds.length) return Promise.resolve([]);
  return client.companySubscription.findMany({
    where: { companyId: { in: companyIds }, status: 'ACTIVE' },
    select: {
      id: true,
      companyId: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      items: {
        select: {
          quantity: true,
          // The price CAPTURED AT PURCHASE, not the catalog's current one — the
          // same rule the billing endpoints follow, so a manager reading an
          // account sees what that customer actually pays rather than today's
          // list price.
          unitAmount: true,
          currency: true,
          servicePlan: {
            select: {
              planCode: true,
              planName: true,
              isAddOn: true,
              quantityEnabled: true,
              quantityLabel: true,
              billingInterval: true,
              specialization: {
                select: { id: true, specializationCode: true, specializationName: true },
              },
            },
          },
        },
      },
    },
  });
}

/** ACTIVE specialist assignments across several companies, in one query. */
function listActiveAssignmentsForCompanies(client, companyIds) {
  if (!companyIds.length) return Promise.resolve([]);
  return client.companySpecialistAssignment.findMany({
    where: { companyId: { in: companyIds }, assignmentStatus: 'ACTIVE' },
    include: {
      // jobTitle is here for the manager's team view — "Tax Specialist" next to a
      // name is what tells two colleagues apart. Still no password hash, no
      // login-security column.
      specialist: { select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true } },
      specialization: true,
    },
    orderBy: [{ companyId: 'asc' }, { specializationId: 'asc' }],
  });
}

/* --------------------------- specialist eligibility ----------------------- */

/**
 * ACTIVE users holding the SPECIALIST role in one of the given specific roles.
 *
 * Both halves matter. The top-level role is what makes someone a specialist at
 * all; the specific role is what makes them the RIGHT specialist for a service —
 * a Tax Specialist is not eligible for a company's bookkeeping. Filtering on the
 * specific role alone would be unsafe, since `specific_roles.code` is unique only
 * within its parent role.
 */
function listEligibleSpecialists(client, specificRoleCodes) {
  if (!specificRoleCodes.length) return Promise.resolve([]);
  return client.user.findMany({
    where: {
      status: 'ACTIVE',
      role: { code: 'SPECIALIST' },
      specificRole: { code: { in: specificRoleCodes } },
    },
    select: DIRECTORY_SELECT,
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The display names of a set of specific roles, e.g. SPECIALIST_3 ->
 * "Bookkeeping Specialist".
 *
 * Read from the table rather than hardcoded so the picker's label follows the
 * seed, and — this is the point — so the label is still correct when NO eligible
 * user holds the role. Deriving it from the eligible users would leave the one
 * case that matters most, "nobody can be assigned here", with a blank heading.
 */
function findSpecificRolesByCodes(client, codes) {
  if (!codes.length) return Promise.resolve([]);
  return client.specificRole.findMany({
    where: { code: { in: codes }, role: { code: 'SPECIALIST' } },
    select: { id: true, code: true, name: true },
  });
}

/**
 * Soft-remove every ACTIVE assignment on a company for one specialization,
 * except the specialist we are keeping.
 *
 * "One specialist per service" is not enforceable by the existing index — it is
 * partial-unique on (company, specialist, specialization), which permits two
 * DIFFERENT specialists to be active for the same service — so replacing an
 * assignment means explicitly standing the previous one down. A soft removal,
 * matching removeSpecialist: the history is what says who was responsible for a
 * company's books last quarter.
 */
function deactivateOtherAssignments(client, { companyId, specializationId, keepSpecialistUserId, unassignedAt }) {
  return client.companySpecialistAssignment.updateMany({
    where: {
      companyId,
      specializationId,
      assignmentStatus: 'ACTIVE',
      ...(keepSpecialistUserId ? { specialistUserId: { not: keepSpecialistUserId } } : {}),
    },
    data: { assignmentStatus: 'INACTIVE', unassignedAt },
  });
}

/* --------------------- accounting-manager eligibility --------------------- */

/**
 * The top-level role code that makes a user assignable as an accounting manager.
 * Declared once here and imported by the service, so the eligibility QUERY and
 * the eligibility CHECK can never disagree about what "eligible" means.
 */
const ACCOUNTING_MANAGER_ROLE_CODE = 'ACCOUNTING_MANAGER';

/** The two conditions that make a user assignable, as a reusable where-fragment. */
const ELIGIBLE_MANAGER_WHERE = {
  status: 'ACTIVE',
  role: { code: ACCOUNTING_MANAGER_ROLE_CODE },
};

/**
 * Every user who may currently be assigned as an accounting manager.
 *
 * Returned as ONE collection for the whole admin page rather than per company —
 * the eligible set does not vary by company, and repeating it on every row turns
 * a 40-company page into 40 copies of the same list.
 *
 * Unpaginated on purpose: these are internal staff, counted in tens, and a
 * picker that silently omits the manager you are looking for is worse than a
 * slightly longer response.
 */
function listEligibleAccountingManagers(client) {
  return client.user.findMany({
    where: ELIGIBLE_MANAGER_WHERE,
    select: DIRECTORY_SELECT,
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
  });
}

/* ------------------ accounting managers and their portfolio --------------- */

/**
 * The fields of a company that belong on a manager's row: enough to identify the
 * account and see where it stands, and nothing more. Revenue, employee count,
 * addresses, and billing are all one click away on the company table — repeating
 * them inside every manager's list would multiply the payload by the number of
 * companies each manager holds to answer a question this screen does not ask.
 */
const MANAGED_COMPANY_SELECT = {
  id: true,
  companyName: true,
  companyEmail: true,
  status: true,
  onboardingCompleted: true,
  createdAt: true,
};

/**
 * Managers, optionally filtered.
 *
 * INACTIVE managers are excluded by default but can be asked for, because a
 * deactivated manager who still holds live companies is precisely the thing an
 * admin needs to find — those accounts are unstaffed and nothing else surfaces
 * them. Hiding them unconditionally would make the report reassuring rather than
 * useful.
 */
function buildAccountingManagerWhere({ search, includeInactive }) {
  return {
    role: { code: ACCOUNTING_MANAGER_ROLE_CODE },
    ...(includeInactive ? {} : { status: 'ACTIVE' }),
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

/**
 * Every accounting manager with the companies they are responsible for, in ONE
 * query — the join is done by the database, not by a loop issuing a second query
 * per manager.
 *
 * Soft-deleted companies are excluded in the JOIN rather than filtered
 * afterwards: a manager whose only companies are deleted must appear with an
 * empty list, not vanish from the report, and a WHERE on the outer query would
 * have dropped them.
 */
function listAccountingManagersWithCompanies(
  client,
  { search, includeInactive, limit, offset, sort, order }
) {
  return client.user.findMany({
    where: buildAccountingManagerWhere({ search, includeInactive }),
    select: {
      ...DIRECTORY_SELECT,
      managedCompanies: {
        where: { deletedAt: null },
        select: MANAGED_COMPANY_SELECT,
        orderBy: { companyName: 'asc' },
      },
    },
    // `id` breaks ties, so two managers sharing a first name keep a stable order
    // across pages instead of swapping places between requests.
    orderBy: [{ [sort]: order }, { id: 'asc' }],
    take: limit,
    skip: offset,
  });
}

function countAccountingManagers(client, { search, includeInactive }) {
  return client.user.count({ where: buildAccountingManagerWhere({ search, includeInactive }) });
}

/* -------------------------- the specialist directory ---------------------- */

const SPECIALIST_ROLE_CODE = 'SPECIALIST';

/**
 * The service lines that have a standing specialist COLUMN on `companies`, paired
 * with the specialization code each column represents.
 *
 * Derived from the catalog's forward map rather than re-listed, so adding a
 * fourth line changes one file. FA_Q is absent by construction — it has no
 * column (nothing sellable maps to it), and a FA_Q specialist is therefore
 * reachable only through the assignment table.
 */
const STANDING_SPECIALIST_COLUMNS = ['BOOKKEEPING', 'PAYROLL', 'TAX']
  .map((specializationCode) => ({
    specializationCode,
    column: catalog.specialistColumnForSpecialization(specializationCode),
  }))
  .filter((entry) => entry.column);

function buildSpecialistDirectoryWhere({ userIds, search, includeInactive }) {
  return {
    role: { code: SPECIALIST_ROLE_CODE },
    ...(includeInactive ? {} : { status: 'ACTIVE' }),
    // `null` means "no id restriction" (the admin's unscoped view); an EMPTY
    // array means "restricted to nothing", which must return nothing rather than
    // silently becoming unrestricted — hence the explicit null check.
    ...(userIds === null ? {} : { id: { in: userIds } }),
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

/**
 * One page of specialists. `specificRole` carries its display NAME here — the
 * seeded "Bookkeeping Specialist" — because that title is the specialist's own
 * standing speciality, which the directory shows whether or not they are
 * currently assigned to anything.
 */
function listSpecialistDirectory(client, { userIds, search, includeInactive, limit, offset, sort, order }) {
  return client.user.findMany({
    where: buildSpecialistDirectoryWhere({ userIds, search, includeInactive }),
    select: {
      ...DIRECTORY_SELECT,
      specificRole: { select: { code: true, name: true } },
    },
    orderBy: [{ [sort]: order }, { id: 'asc' }],
    take: limit,
    skip: offset,
  });
}

function countSpecialistDirectory(client, { userIds, search, includeInactive }) {
  return client.user.count({ where: buildSpecialistDirectoryWhere({ userIds, search, includeInactive }) });
}

/** The ids of every live company the caller can reach. Admin: every company. */
async function listAccessibleCompanyIds(client, { userId, isAdmin }) {
  const rows = await client.company.findMany({
    where: buildCompanyListWhere({ userId, isAdmin }),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Every specialist reachable through a set of companies.
 *
 * BOTH mechanisms count, and that is the point: a specialist can be attached to
 * a company by an ACTIVE row in the assignment table, or by holding one of the
 * three standing service-line columns. Consulting only one of the two would hide
 * real people from the people they actually work with — and which mechanism was
 * used is an internal modelling detail nobody outside this file should have to
 * know about.
 */
async function listSpecialistIdsForCompanies(client, companyIds) {
  if (!companyIds.length) return [];

  const [assignments, companies] = await Promise.all([
    client.companySpecialistAssignment.findMany({
      where: { companyId: { in: companyIds }, assignmentStatus: 'ACTIVE' },
      select: { specialistUserId: true },
      distinct: ['specialistUserId'],
    }),
    client.company.findMany({
      where: { id: { in: companyIds }, deletedAt: null },
      select: Object.fromEntries(STANDING_SPECIALIST_COLUMNS.map((c) => [c.column, true])),
    }),
  ]);

  const ids = new Set(assignments.map((a) => a.specialistUserId));
  for (const company of companies) {
    for (const { column } of STANDING_SPECIALIST_COLUMNS) {
      if (company[column]) ids.add(company[column]);
    }
  }
  return [...ids];
}

/**
 * The ACTIVE assignments of a page of specialists, optionally narrowed to a set
 * of companies.
 *
 * Fetched for the PAGE rather than for every specialist in the system: the page
 * is at most 100 rows, and this is one query for all of them instead of one per
 * row.
 */
function listAssignmentsForSpecialists(client, { specialistUserIds, companyIds }) {
  if (!specialistUserIds.length) return [];
  return client.companySpecialistAssignment.findMany({
    where: {
      specialistUserId: { in: specialistUserIds },
      assignmentStatus: 'ACTIVE',
      company: { deletedAt: null, ...(companyIds ? { id: { in: companyIds } } : {}) },
    },
    select: {
      specialistUserId: true,
      company: { select: { id: true, companyName: true, status: true } },
      specialization: { select: { specializationCode: true, specializationName: true } },
    },
    orderBy: { assignedAt: 'asc' },
  });
}

/** Companies where any of these users holds a standing service-line seat. */
function listStandingSpecialistCompanies(client, { specialistUserIds, companyIds }) {
  if (!specialistUserIds.length) return [];
  return client.company.findMany({
    where: {
      deletedAt: null,
      ...(companyIds ? { id: { in: companyIds } } : {}),
      OR: STANDING_SPECIALIST_COLUMNS.map(({ column }) => ({ [column]: { in: specialistUserIds } })),
    },
    select: {
      id: true,
      companyName: true,
      status: true,
      ...Object.fromEntries(STANDING_SPECIALIST_COLUMNS.map((c) => [c.column, true])),
    },
    orderBy: { companyName: 'asc' },
  });
}

/* --------------------------- the customer directory ----------------------- */

const CUSTOMER_ROLE_CODE = 'CUSTOMER';

function buildCustomerDirectoryWhere({ userIds, search, includeInactive }) {
  return {
    role: { code: CUSTOMER_ROLE_CODE },
    ...(includeInactive ? {} : { status: 'ACTIVE' }),
    // As in the specialist directory: null means unrestricted, an empty array
    // means restricted to nothing. They must not collapse into each other.
    ...(userIds === null ? {} : { id: { in: userIds } }),
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

/**
 * One page of customer-side users with the companies they own.
 *
 * `companyIds` filters the NESTED companies as well as (via `userIds`) the outer
 * rows, so a caller scoped to one company sees that company on the row and not
 * the customer's other accounts. Ownership is the only customer-to-company link
 * the schema has: a CUSTOMER/TEAM user has no company column, which is why such
 * a user comes back with an empty list rather than being silently dropped.
 */
function listCustomerDirectory(
  client,
  { userIds, companyIds, search, includeInactive, limit, offset, sort, order }
) {
  return client.user.findMany({
    where: buildCustomerDirectoryWhere({ userIds, search, includeInactive }),
    select: {
      ...DIRECTORY_SELECT,
      specificRole: { select: { code: true, name: true } },
      ownedCompanies: {
        where: { deletedAt: null, ...(companyIds ? { id: { in: companyIds } } : {}) },
        select: { id: true, companyName: true, status: true },
        orderBy: { companyName: 'asc' },
      },
    },
    orderBy: [{ [sort]: order }, { id: 'asc' }],
    take: limit,
    skip: offset,
  });
}

function countCustomerDirectory(client, { userIds, search, includeInactive }) {
  return client.user.count({ where: buildCustomerDirectoryWhere({ userIds, search, includeInactive }) });
}

/* ------------------------------- teammates -------------------------------- */

/**
 * The teammates of one company: the CUSTOMER users linked to it through
 * `company_members`.
 *
 * Membership is the filter, not the specific role, because membership is the
 * thing that is actually true — an owner is attached via `companies.owner_user_id`
 * and never appears here, so the roster is teammates by construction. The
 * specific role is still SELECTED (and optionally filtered on by the service) so
 * a client can label the row "Team" without a second lookup.
 *
 * `includeInactive` reaches past the ACTIVE default to show people who were
 * hibernated after joining; they are still on the roster and hiding them makes a
 * company look like it has fewer teammates than its members table says.
 */
function buildTeammateWhere({ companyId, specificRoleCode, search, includeInactive }) {
  return {
    role: { code: CUSTOMER_ROLE_CODE },
    ...(specificRoleCode ? { specificRole: { code: specificRoleCode } } : {}),
    ...(includeInactive ? {} : { status: 'ACTIVE' }),
    companyMemberships: { some: { companyId } },
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

function listTeammates(client, { companyId, specificRoleCode, search, includeInactive, limit, offset, sort, order }) {
  return client.user.findMany({
    where: buildTeammateWhere({ companyId, specificRoleCode, search, includeInactive }),
    select: {
      ...DIRECTORY_SELECT,
      createdAt: true,
      specificRole: { select: { code: true, name: true } },
      // Scoped to the company being asked about, so the row carries WHEN this
      // person joined THIS company rather than their earliest membership
      // anywhere. `take: 1` because (companyId, userId) is unique.
      companyMemberships: {
        where: { companyId },
        select: { id: true, companyId: true, createdAt: true },
        take: 1,
      },
    },
    // `id` breaks ties so paging is stable: two teammates with the same first
    // name would otherwise be free to swap places between page 1 and page 2.
    orderBy: [{ [sort]: order }, { id: 'asc' }],
    take: limit,
    skip: offset,
  });
}

function countTeammates(client, { companyId, specificRoleCode, search, includeInactive }) {
  return client.user.count({
    where: buildTeammateWhere({ companyId, specificRoleCode, search, includeInactive }),
  });
}

/**
 * The live companies a user OWNS, as the compact options the invite form needs.
 *
 * Deliberately not `listCompaniesForUser`: that one joins owner, manager, every
 * specialist, the primary address and the subscription, which is a great deal of
 * work for a dropdown that renders a name. ARCHIVED companies are excluded —
 * inviting someone onto a wound-down company is not a thing to offer.
 */
function listOwnedCompanyOptions(client, ownerUserId) {
  return client.company.findMany({
    where: { ownerUserId, deletedAt: null, status: { not: 'ARCHIVED' } },
    select: { id: true, companyName: true, companyEmail: true, status: true, onboardingCompleted: true },
    orderBy: { companyName: 'asc' },
  });
}

/**
 * Of `companyIds`, the ones this user owns — used to check an invite covers only
 * the caller's own companies.
 *
 * Returns the INTERSECTION rather than a boolean so the caller can name the
 * offending ids in the error. "You do not own companies 4 and 9" is actionable;
 * "access denied" is not.
 */
async function listOwnedCompanyIds(client, { ownerUserId, companyIds }) {
  if (!companyIds.length) return [];
  const rows = await client.company.findMany({
    where: { id: { in: companyIds }, ownerUserId, deletedAt: null, status: { not: 'ARCHIVED' } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** The customer-side users attached to a set of companies — today, their owners. */
async function listCustomerIdsForCompanies(client, companyIds) {
  if (!companyIds.length) return [];
  const rows = await client.company.findMany({
    where: { id: { in: companyIds }, deletedAt: null },
    select: { ownerUserId: true },
    distinct: ['ownerUserId'],
  });
  return rows.map((row) => row.ownerUserId);
}

/**
 * The company a new one should inherit its accounting manager from: the OLDEST
 * live company belonging to the same creator whose manager is still eligible.
 *
 * "Oldest" is the tie-break for a creator whose companies sit with different
 * managers — it makes inheritance deterministic and stable, where "newest" would
 * mean the answer changes every time another company is added. Eligibility is
 * checked in the JOIN, not afterwards, so a company pointing at a deactivated or
 * re-roled manager is simply not a candidate and the search falls through to the
 * next one instead of stopping there.
 *
 * ARCHIVED companies are excluded alongside soft-deleted ones: a wound-down
 * company should not go on deciding who staffs new ones.
 */
function findInheritableManagerSource(client, ownerUserId) {
  return client.company.findFirst({
    where: {
      ownerUserId,
      deletedAt: null,
      status: { not: 'ARCHIVED' },
      accountingManager: { is: ELIGIBLE_MANAGER_WHERE },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      accountingManagerUserId: true,
      accountingManager: { select: USER_ROLE_SELECT },
    },
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
  DIRECTORY_SELECT,
  ACCOUNTING_MANAGER_ROLE_CODE,
  listEligibleAccountingManagers,
  listAccountingManagersWithCompanies,
  countAccountingManagers,
  SPECIALIST_ROLE_CODE,
  STANDING_SPECIALIST_COLUMNS,
  listSpecialistDirectory,
  countSpecialistDirectory,
  listAccessibleCompanyIds,
  listSpecialistIdsForCompanies,
  listAssignmentsForSpecialists,
  listStandingSpecialistCompanies,
  CUSTOMER_ROLE_CODE,
  listCustomerDirectory,
  countCustomerDirectory,
  listCustomerIdsForCompanies,
  listTeammates,
  countTeammates,
  listOwnedCompanyOptions,
  listOwnedCompanyIds,
  findInheritableManagerSource,
  listActiveSubscriptionsForCompanies,
  listActiveAssignmentsForCompanies,
  listEligibleSpecialists,
  findSpecificRolesByCodes,
  deactivateOtherAssignments,
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
  setAccountingManager,
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
