'use strict';

const { prisma } = require('../config/prisma');
const repo = require('../repositories/projectRepository');
const companyRepo = require('../repositories/companyRepository');
const catalog = require('../config/serviceCatalog');
const dto = require('../dto/projectDto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');

/**
 * Projects: open a unit of work against a company, list what is open, and keep
 * the right specialist attached to it.
 *
 * THE THREE RULES THIS FILE OWNS
 *
 *   1. WHO MAY CREATE — an ACCOUNTING_MANAGER on that company, or a CUSTOMER on
 *      that company (its owner or a teammate). Nobody else, ADMIN included.
 *
 *      An admin is refused everywhere in this file, not only here: they cannot
 *      read a project, open one, edit one, or touch its documents. Projects are
 *      the client's working material, and access to them follows from being on
 *      the company rather than from rank. What an admin still does is appoint
 *      staff — see syncSpecialists, which reports counts and no content.
 *
 *   2. WHICH SERVICES ARE OFFERED — only the ones on the company's ACTIVE
 *      subscription. The dropdown is built from the same query the create path
 *      validates against, so the form can never offer a choice the write would
 *      refuse, and a client that skips the form and posts a plan id directly
 *      gets the same answer.
 *
 *   3. WHO IS STAFFED — resolved by the server from the company's standing
 *      specialist for that service line, never from the request. The result is
 *      STORED rather than derived on read (see the schema), which is what keeps
 *      a closed project's history true after the account is re-staffed. The
 *      cost of storing it is that a later staffing change does not reach
 *      projects that were opened unstaffed — which is what backfillSpecialists
 *      below exists to fix.
 */

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

function callerNotFound() {
  return new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
}
function companyNotFound() {
  return new ApiError(404, 'Company not found.', { code: 'COMPANY_NOT_FOUND' });
}
function companyAccessDenied() {
  return new ApiError(403, 'You do not have access to this company.', {
    code: 'COMPANY_ACCESS_DENIED',
  });
}
function projectNotFound() {
  return new ApiError(404, 'Project not found.', { code: 'PROJECT_NOT_FOUND' });
}
function projectAccessDenied() {
  return new ApiError(403, 'You do not have permission to perform this action.', {
    code: 'PROJECT_ACCESS_DENIED',
  });
}

/* -------------------------------------------------------------------------- */
/* who the caller is                                                          */
/* -------------------------------------------------------------------------- */

const isAdmin = (caller) => caller.role?.code === 'ADMIN';
const isCustomer = (caller) => caller.role?.code === 'CUSTOMER';
const isAccountingManager = (caller) => caller.role?.code === 'ACCOUNTING_MANAGER';

/** Load the caller with their role, or 401. */
async function loadCaller(userId) {
  const caller = await companyRepo.findUserWithRole(prisma, userId);
  if (!caller) throw callerNotFound();
  return caller;
}

/** Load a live company with the columns the project rules read, or 404. */
async function loadCompany(client, companyId) {
  const company = await repo.findCompanyForProjects(client, companyId);
  if (!company) throw companyNotFound();
  return company;
}

/** The three standing-specialist columns, as a set of user ids. */
function standingSpecialistIds(company) {
  return [
    company.bookkeepingSpecialistUserId,
    company.payrollSpecialistUserId,
    company.taxSpecialistUserId,
  ].filter(Boolean);
}

/**
 * READ access to a company's projects: the owner, a teammate, the company's
 * accounting manager, or a specialist working it.
 *
 * Wider than create access, and wider than companyService.assertReadAccess in
 * one specific way — it includes `company_members`. A teammate invited onto an
 * account can see the account's work; that is what being on the account means,
 * and the projects table is the first screen in this API where the distinction
 * comes up.
 *
 * AN ADMIN IS NOT ON THIS LIST, and that is the deliberate part. Everywhere else
 * in this API an admin outranks the check; here they do not, because a project
 * and its attachments are the client's own working material — their statements,
 * their returns, their notes — and administering the platform is not the same as
 * being party to the work. Access to a company's projects follows from being ON
 * that company, and an admin is on none of them.
 *
 * The consequence is that an admin cannot list, open, or download any project or
 * document, and that is the intent rather than an oversight. Staffing oversight
 * still works: syncSpecialists reports counts, not content.
 */
async function assertReadAccess(client, caller, company) {
  if (company.ownerUserId === caller.id) return;
  if (company.accountingManagerUserId && company.accountingManagerUserId === caller.id) return;
  if (standingSpecialistIds(company).includes(caller.id)) return;

  const [membership, assignment] = await Promise.all([
    repo.findMembership(client, { companyId: company.id, userId: caller.id }),
    repo.findActiveAssignmentForUser(client, { companyId: company.id, userId: caller.id }),
  ]);
  if (membership || assignment) return;

  throw companyAccessDenied();
}

/**
 * CREATE access: the company's own accounting manager, or a customer on the
 * account (its owner or a teammate).
 *
 * The role check and the company check are both required, and neither is
 * sufficient. Holding ACCOUNTING_MANAGER says what kind of actor the caller is;
 * being THIS company's manager is what makes the account theirs to open work on.
 * The same pairing is why an admin is refused despite outranking both — see the
 * header.
 */
async function assertCreateAccess(client, caller, company) {
  if (isAccountingManager(caller)) {
    if (company.accountingManagerUserId === caller.id) return;
    throw companyAccessDenied();
  }

  if (isCustomer(caller)) {
    if (company.ownerUserId === caller.id) return;
    const membership = await repo.findMembership(client, { companyId: company.id, userId: caller.id });
    if (membership) return;
    throw companyAccessDenied();
  }

  throw new ApiError(403, 'Only an accounting manager or a customer can create a project.', {
    code: 'PROJECT_CREATE_FORBIDDEN',
  });
}

/**
 * WRITE access to an existing project: the company's accounting manager,
 * whoever opened it, or the specialist it is assigned to.
 *
 * The specialist is on this list and not on the create list, which is the
 * asymmetry worth noticing: they do not decide what work exists, but moving a
 * project they are doing from TODO to COMPLETED is the whole point of their
 * having it. Excluding them would mean the progress bar could only be moved by
 * someone not doing the work.
 *
 * No admin here either, and it follows from the read rule rather than being a
 * separate decision: someone who may not see a project cannot coherently be
 * allowed to edit it.
 */
function assertWriteAccess(caller, company, project) {
  if (company.accountingManagerUserId === caller.id) return;
  if (project.createdByUserId === caller.id) return;
  if (project.assignedSpecialistUserId && project.assignedSpecialistUserId === caller.id) return;
  throw projectAccessDenied();
}

/**
 * DELETE access: narrower than write. A specialist may finish a project; making
 * it disappear from the customer's list is the account's decision, not the
 * assignee's.
 */
function assertDeleteAccess(caller, company, project) {
  if (company.accountingManagerUserId === caller.id) return;
  if (project.createdByUserId === caller.id) return;
  throw projectAccessDenied();
}

/**
 * Load a project the caller is allowed to SEE, together with the company it
 * belongs to and the caller's own row.
 *
 * Exported because the documents feature (projectDocumentService) needs exactly
 * this and must not grow its own copy of it. "May this person touch this
 * project's files" is not a second question — it is the same access rule applied
 * to a different noun, and two implementations of one rule drift the first time
 * either is changed.
 */
async function loadProjectForRead(client, { userId, projectId }) {
  const caller = await loadCaller(userId);

  const project = await repo.findProjectForAccess(client, projectId);
  if (!project) throw projectNotFound();

  const company = await loadCompany(client, project.companyId);
  await assertReadAccess(client, caller, company);

  return { caller, project, company };
}

/* -------------------------------------------------------------------------- */
/* the service the project is for                                             */
/* -------------------------------------------------------------------------- */

/** The services a company may open a project against, shaped for the form. */
async function loadServiceOptions(client, companyId) {
  const items = await repo.listPurchasedPlans(client, companyId);
  return dto.toServiceOptions(items);
}

/**
 * Turn what the request said about the service into the plan it must be.
 *
 * Resolved against the company's OWN purchased services rather than the plan
 * catalog at large. Validating a plan id for existence alone would let anyone
 * open a Tax project on a company that only pays for bookkeeping — and, because
 * the specialist is derived from the plan, quietly attach it to a specialist
 * that company never engaged.
 */
function resolveService(services, { servicePlanId, specializationId, serviceCode }) {
  if (!services.length) {
    throw new ApiError(409, 'This company has no active services to open a project against.', {
      code: 'NO_ACTIVE_SERVICES',
      fields: { specializationId: 'This company has no active subscription.' },
    });
  }

  /*
   * Whichever of the three the caller sent, the lookup is over the SAME list —
   * the company's purchased services, one entry per service, keyed by its base
   * plan. That is what makes `specializationId: 1` and `servicePlanId: 5`
   * interchangeable for a company on Bookkeeping Growth: they select the same
   * row, so they cannot disagree about the tier or about the specialist that
   * follows from it.
   */
  let match = null;
  if (servicePlanId) match = services.find((s) => s.servicePlanId === servicePlanId);
  else if (specializationId) match = services.find((s) => s.specializationId === specializationId);
  else match = services.find((s) => s.serviceCode === serviceCode);

  if (!match) {
    throw new ApiError(400, 'This company is not subscribed to that service.', {
      code: 'SERVICE_NOT_PURCHASED',
      fields: { specializationId: 'Choose one of the company’s active services.' },
      // The available set is echoed back so a client that guessed wrong can
      // correct itself without a second round trip to the services endpoint.
      details: {
        available: services.map((s) => ({
          specializationId: s.specializationId,
          servicePlanId: s.servicePlanId,
          serviceCode: s.serviceCode,
          serviceName: s.serviceName,
        })),
      },
    });
  }

  return match;
}

/* -------------------------------------------------------------------------- */
/* the auto-assignment                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Who staffs this service on this company — the rule the whole feature turns on.
 *
 * ONE project gets ONE specialist, and that specialist must match BOTH the
 * company and the service. Those are two separate conditions and the resolver
 * fails either of them independently:
 *
 *   the company   candidates are only ever read from THIS company's staffing —
 *                 its standing columns and its own assignment rows. Nobody
 *                 outside the account is reachable from here at all.
 *
 *   the service   a candidate is kept only if they hold the specialist kind that
 *                 serves this specialization (BOOKKEEPING -> SPECIALIST_3, and
 *                 so on through config/serviceCatalog) and their account is
 *                 ACTIVE. A tax specialist sitting in a company's bookkeeping
 *                 column — a stale assignment, a role changed after the fact —
 *                 is NOT assigned to its bookkeeping project.
 *
 * Candidates are gathered in priority order and the first eligible one wins,
 * which is what makes the answer single and deterministic:
 *
 *   1. The standing column on `companies` (bookkeeping / payroll / tax). This is
 *      the answer to "who is THE specialist on this line right now" — a single
 *      column, so it is single by construction, and it is what the admin grid
 *      shows.
 *
 *   2. ACTIVE rows in `company_specialist_assignments` for that specialization,
 *      newest first. That table deliberately permits SEVERAL active rows for one
 *      specialization (it is a record of work, not of responsibility), so it
 *      cannot answer "who is THE specialist" on its own — taking the newest
 *      eligible one is the tie-break, and it only ever runs when the column is
 *      empty or the person in it no longer qualifies. FA_Q has no column at all,
 *      so for that service this is the only source.
 *
 * Returns null when nobody qualifies. That is a real state, not a failure: the
 * project is created unassigned, appears as such, and is picked up by
 * backfillSpecialists as soon as somebody eligible is put on the line. Assigning
 * a wrong-service specialist would be worse than assigning none — it reads as
 * staffed to everyone downstream while the work sits with someone who cannot do
 * it.
 */
async function resolveSpecialist(client, company, { specializationId, serviceCode }) {
  // In priority order, de-duplicated: the standing specialist is usually also
  // one of the assignment rows, and asking about them twice would not change
  // the answer.
  const candidates = [];
  const consider = (userId) => {
    if (userId && !candidates.includes(userId)) candidates.push(userId);
  };

  const column = catalog.specialistColumnForSpecialization(serviceCode);
  if (column) consider(company[column]);

  const assignments = await repo.findActiveAssignmentsForSpecialization(client, {
    companyId: company.id,
    specializationId,
  });
  assignments.forEach((a) => consider(a.specialistUserId));

  if (!candidates.length) return null;

  // One query for the whole shortlist rather than one per candidate: the list is
  // short, but this runs inside the create transaction and once per project in
  // the backfill sweep.
  const eligible = await repo.findEligibleSpecialists(client, {
    userIds: candidates,
    specificRoleCode: catalog.specialistRoleForSpecialization(serviceCode),
  });
  const eligibleIds = new Set(eligible.map((u) => u.id));

  // `candidates` carries the priority; `eligibleIds` only says who is allowed.
  // Iterating the former is what keeps the standing specialist ahead of the
  // assignment rows.
  return candidates.find((id) => eligibleIds.has(id)) ?? null;
}

/**
 * Attach the current specialist to every live project on a company that has
 * none — the follow-up half of the auto-assignment.
 *
 * WHY THIS EXISTS. The specialist is stamped onto the project at creation, so a
 * project opened while the company was unstaffed stays unstaffed forever, no
 * matter who is appointed afterwards. That is the correct behaviour for a
 * project that already HAS a specialist (history must not move under people) and
 * plainly the wrong one for a project that has none. This closes exactly that
 * gap and nothing wider: it only ever fills a NULL.
 *
 * COMPLETED projects are skipped for the same reason — putting a name on
 * finished work that person never touched is a false record.
 *
 * Called after any staffing change on a company (see companyService), and
 * exposed as an endpoint so it can be re-run deliberately.
 *
 * Best-effort by design when called as a side effect: a failure here is logged
 * and swallowed by the caller, because a staffing change that succeeded must not
 * be reported as failed over a backfill that can simply be re-run.
 *
 * @returns {Promise<{ assigned: number, remaining: number }>}
 */
async function backfillSpecialists(companyId, { requestId } = {}) {
  const company = await repo.findCompanyForProjects(prisma, companyId);
  if (!company) return { assigned: 0, remaining: 0 };

  const pending = await repo.listUnassignedProjects(prisma, companyId);
  if (!pending.length) return { assigned: 0, remaining: 0 };

  let assigned = 0;
  for (const project of pending) {
    const specialization = project.servicePlan?.specialization;
    if (!specialization) continue;

    const specialistUserId = await resolveSpecialist(prisma, company, {
      specializationId: specialization.id,
      serviceCode: specialization.specializationCode,
    });
    if (!specialistUserId) continue;

    await repo.setAssignedSpecialist(prisma, project.id, specialistUserId);
    assigned += 1;
  }

  if (assigned) {
    logEvent({
      event: 'project.specialists.backfilled',
      status: 'success',
      requestId,
      companyId,
      projectCount: assigned,
    });
  }

  return { assigned, remaining: pending.length - assigned };
}

/**
 * The same sweep, triggered deliberately by a caller who is allowed to staff the
 * account. Separate from backfillSpecialists because that one runs as a side
 * effect of another operation and has no caller to authorize.
 */
async function syncSpecialists({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(prisma, companyId);

  // Staffing is the accounting manager's job, and an admin oversees it. A
  // customer cannot re-run this: it decides who works on their account.
  const allowed = isAdmin(caller) || company.accountingManagerUserId === caller.id;
  if (!allowed) throw companyAccessDenied();

  const result = await backfillSpecialists(companyId, { requestId });

  return { companyId, ...result };
}

/* -------------------------------------------------------------------------- */
/* the endpoints                                                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /projects/services?companyId=… — the "Service" dropdown for the new
 * project form, and nothing else.
 *
 * Read access rather than create access, deliberately: this is the same list
 * embedded in GET /projects, and a specialist or an admin looking at the table
 * should see what the company has without being able to open work on it.
 */
async function listServices({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(prisma, companyId);
  await assertReadAccess(prisma, caller, company);

  const services = await loadServiceOptions(prisma, companyId);

  logEvent({
    event: 'project.services.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    detail: `${services.length} service(s)`,
  });

  return { companyId, companyName: company.companyName, services };
}

/**
 * GET /projects?companyId=… — the projects table.
 *
 * One response carries the page, the total, and the company's service list,
 * because that is what the screen renders: a table plus a "New project" form
 * that must be ready the moment the page is. Splitting them would mean the
 * button opens a form with an empty dropdown for as long as a second request
 * takes.
 */
async function listProjects({ userId, requestId, query }) {
  const { companyId, status, assignedSpecialistUserId, search, limit, offset, sort, order } = query;

  const caller = await loadCaller(userId);
  const company = await loadCompany(prisma, companyId);
  await assertReadAccess(prisma, caller, company);

  const [projects, total, services] = await Promise.all([
    repo.listProjects(prisma, { companyId, status, assignedSpecialistUserId, search, limit, offset, sort, order }),
    repo.countProjects(prisma, { companyId, status, assignedSpecialistUserId, search }),
    loadServiceOptions(prisma, companyId),
  ]);

  logEvent({
    event: 'project.list.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    projectCount: projects.length,
  });

  return dto.toProjectList({ projects, services, total, limit, offset });
}

/** GET /projects/:projectId — one project in full. */
async function getProject({ userId, requestId, projectId }) {
  const caller = await loadCaller(userId);

  const project = await repo.findProjectDetail(prisma, projectId);
  if (!project) throw projectNotFound();

  const company = await loadCompany(prisma, project.companyId);
  await assertReadAccess(prisma, caller, company);

  logEvent({ event: 'project.read', status: 'success', requestId, userId, companyId: company.id, projectId });

  return dto.toProject(project);
}

/**
 * POST /projects — open a project.
 *
 * Everything the request does not supply is resolved here, in one transaction:
 * which plan the named service is, who is staffed on it, and who is recorded as
 * having created it. The transaction is what makes the staffing read and the
 * insert one decision — without it, a specialist reassigned between the two
 * reads would be stamped onto a project after they had already left the line.
 */
async function createProject({ userId, requestId, input }) {
  const caller = await loadCaller(userId);

  const project = await prisma.$transaction(async (tx) => {
    const company = await loadCompany(tx, input.companyId);
    await assertCreateAccess(tx, caller, company);

    const services = await loadServiceOptions(tx, company.id);
    const service = resolveService(services, input);

    const assignedSpecialistUserId = await resolveSpecialist(tx, company, {
      specializationId: service.specializationId,
      serviceCode: service.serviceCode,
    });

    return repo.createProject(tx, {
      companyId: company.id,
      projectName: input.projectName,
      deadlineDate: input.deadlineDate,
      servicePlanId: service.servicePlanId,
      assignedSpecialistUserId,
      createdByUserId: caller.id,
      description: input.description,
    });
  });

  logEvent({
    event: 'project.created',
    status: 'success',
    requestId,
    userId,
    companyId: project.companyId,
    projectId: project.id,
    specialistUserId: project.assignedSpecialistUserId ?? undefined,
    // A project opened with nobody on the line is worth being able to find in
    // the log — it is the state backfillSpecialists later resolves.
    detail: project.assignedSpecialistUserId ? 'assigned' : 'unassigned',
  });

  return dto.toProject(project);
}

/**
 * PATCH /projects/:projectId — correct the name, the deadline, or the note, and
 * move the status (which is what moves the progress bar).
 *
 * The SERVICE cannot be changed here; see the validator for why.
 */
async function updateProject({ userId, requestId, projectId, input }) {
  const caller = await loadCaller(userId);

  const updated = await prisma.$transaction(async (tx) => {
    const project = await repo.findProjectForAccess(tx, projectId);
    if (!project) throw projectNotFound();

    const company = await loadCompany(tx, project.companyId);
    assertWriteAccess(caller, company, project);

    return repo.updateProject(tx, projectId, input);
  });

  logEvent({
    event: 'project.updated',
    status: 'success',
    requestId,
    userId,
    companyId: updated.companyId,
    projectId,
    detail: Object.keys(input).join(','),
  });

  return dto.toProject(updated);
}

/**
 * DELETE /projects/:projectId — soft delete.
 *
 * The row survives with `deleted_at` set, matching how companies are removed:
 * a project is a record of work that was requested, and losing it would take
 * the reason for a past charge with it.
 */
async function deleteProject({ userId, requestId, projectId }) {
  const caller = await loadCaller(userId);

  const companyId = await prisma.$transaction(async (tx) => {
    const project = await repo.findProjectForAccess(tx, projectId);
    if (!project) throw projectNotFound();

    const company = await loadCompany(tx, project.companyId);
    assertDeleteAccess(caller, company, project);

    await repo.softDeleteProject(tx, projectId, new Date());
    return company.id;
  });

  logEvent({ event: 'project.deleted', status: 'success', requestId, userId, companyId, projectId });

  return { id: projectId, deleted: true };
}

/**
 * The side-effect entry point for companyService: re-run the backfill after a
 * staffing change, and never let it fail the change that triggered it.
 *
 * The staffing write has already committed by the time this runs. Throwing here
 * would report a completed operation as failed, and the client's retry would
 * re-apply an assignment that was already applied — a worse outcome by far than
 * a few projects staying unassigned until the next sweep.
 */
async function backfillAfterStaffingChange(companyId, { requestId } = {}) {
  try {
    return await backfillSpecialists(companyId, { requestId });
  } catch (err) {
    logger.error(
      `[${requestId}] Project specialist backfill failed for company ${companyId}: ${err.message}`
    );
    return { assigned: 0, remaining: 0 };
  }
}

module.exports = {
  listServices,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  syncSpecialists,
  backfillSpecialists,
  backfillAfterStaffingChange,
  // Shared with projectDocumentService — see loadProjectForRead above.
  loadProjectForRead,
  assertWriteAccess,
};
