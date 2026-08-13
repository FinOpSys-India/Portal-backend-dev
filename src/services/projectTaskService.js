'use strict';

const { prisma } = require('../config/prisma');
const repo = require('../repositories/projectTaskRepository');
const projectService = require('./projectService');
const dto = require('../dto/projectTaskDto');
const ApiError = require('../utils/ApiError');
const { logEvent } = require('../utils/auditLog');

/**
 * Tasks: the pieces of work filed under a project.
 *
 * THE TWO RULES THIS FILE OWNS, and it owns them because the database was
 * deliberately not asked to:
 *
 *   1. A TASK IS DUE AFTER ITS PROJECT. `project_tasks` carries no CHECK for
 *      this — a CHECK sees only its own row and the comparison crosses tables —
 *      so it is enforced here, on BOTH sides. Filing or re-dating a task is the
 *      obvious side; moving the PROJECT's deadline later is the one that is easy
 *      to forget, and it is guarded by assertDeadlineLeavesTasksValid in
 *      projectService — which lives there rather than here only because a
 *      require in that direction would close a cycle. Guarding only the first
 *      side would leave the table able to hold rows that violate its own rule.
 *
 *   2. ONLY TWO PEOPLE MAY FILE OR MOVE A TASK — the company's OWN accounting
 *      manager, and the project's ASSIGNED specialist. The first runs the
 *      account, so planning its work is theirs; the second does the work, so
 *      breaking it into steps is theirs.
 *
 *      Nobody else: not the customer who opened the project, not a teammate on
 *      the account, not a different specialist on the same company, and not an
 *      admin. That last one is refused a step earlier still, by the read rule —
 *      access here follows from being on the company, not from rank.
 *
 *      Narrower than the projects feature, which also lets the CREATOR write.
 *      A customer can say what work they want done; how it is broken down is
 *      the firm's side of the account.
 *
 * READING is wider than writing and is not re-implemented here at all — it
 * delegates to projectService.loadProjectForRead / loadCompanyForRead. "May this
 * person see this project's tasks" is not a second question; it is the project
 * read rule applied to a different noun, and two copies of one rule drift the
 * first time either is changed.
 */

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

function taskNotFound() {
  return new ApiError(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
}
function projectNotFound() {
  return new ApiError(404, 'Project not found.', { code: 'PROJECT_NOT_FOUND' });
}

/**
 * The 403 for someone who may see the project but is not the person working it.
 *
 * The message names the rule rather than saying "forbidden", because the caller
 * is very often a legitimate member of the account who simply is not the
 * assignee, and "you are not the specialist on this project" is the difference
 * between a user filing a bug and a user asking the right colleague.
 */
function notTheSpecialist() {
  return new ApiError(403, 'Only the specialist assigned to this project can manage its tasks.', {
    code: 'TASK_ACCESS_DENIED',
  });
}

/* -------------------------------------------------------------------------- */
/* the rules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * WRITE access — two people, and only two:
 *
 *   the company's OWN accounting manager   they run the account, so planning the
 *                                          work on it is theirs. "Own" is the
 *                                          load-bearing word: holding
 *                                          ACCOUNTING_MANAGER says what kind of
 *                                          actor the caller is, and
 *                                          `company.accountingManagerUserId`
 *                                          is what makes THIS account theirs.
 *
 *   the project's ASSIGNED specialist      they do the work, so breaking it into
 *                                          steps and moving those steps is
 *                                          theirs. Not any specialist on the
 *                                          company — the one on this project.
 *
 * Nobody else: not the customer who opened the project, not a teammate, and not
 * an admin (who is refused earlier still, by the read rule, since access here
 * follows from being on the company rather than from rank).
 *
 * THE ORDER MATTERS. The manager is checked FIRST, so they can file work against
 * a project nobody is staffed on yet — a real and common state. The task is
 * created with a null specialist, which is truthful rather than missing, and
 * projectService.backfillSpecialists carries it to whoever is appointed. A
 * specialist reaching an unstaffed project cannot be its assignee by
 * definition, so for them the same state is a 409 that says why.
 */
function assertTaskWriteAccess(caller, company, project) {
  if (company.accountingManagerUserId && company.accountingManagerUserId === caller.id) return;

  if (!project.assignedSpecialistUserId) {
    throw new ApiError(409, 'This project has no specialist assigned yet.', {
      code: 'PROJECT_UNSTAFFED',
      fields: { projectId: 'Assign a specialist to this project first.' },
    });
  }
  if (project.assignedSpecialistUserId !== caller.id) throw notTheSpecialist();
}

/**
 * Rule 1, on the task side: strictly after the project's own deadline.
 *
 * Equal dates are refused. A task due the same day the project is due has no
 * room to be a step toward it, and "after" was chosen over "on or after"
 * deliberately.
 *
 * The error names the project's date as well as the task's, because the caller's
 * next move is to pick a valid one and a message that does not say the bound
 * makes them guess.
 */
function assertDeadlineAfterProject(taskDeadline, projectDeadline) {
  if (!projectDeadline || !taskDeadline) return;
  if (taskDeadline.getTime() > projectDeadline.getTime()) return;

  const asDay = (d) => d.toISOString().slice(0, 10);
  throw new ApiError(400, 'A task deadline must fall after its project deadline.', {
    code: 'TASK_DEADLINE_BEFORE_PROJECT',
    fields: { deadlineDate: `Choose a date after ${asDay(projectDeadline)}.` },
    details: { projectDeadlineDate: asDay(projectDeadline), taskDeadlineDate: asDay(taskDeadline) },
  });
}

/**
 * The `companyId` a caller may optionally send with a create.
 *
 * Checked against the project rather than used, and a mismatch is refused rather
 * than ignored: a client that believes it is filing work on company 7 while the
 * project belongs to company 9 has a bug, and silently writing to 9 would hide
 * it behind a 201.
 */
function assertCompanyMatches(sentCompanyId, project) {
  if (sentCompanyId === null || sentCompanyId === undefined) return;
  if (sentCompanyId === project.companyId) return;

  throw new ApiError(400, 'companyId does not match the project.', {
    code: 'COMPANY_PROJECT_MISMATCH',
    fields: { companyId: 'This project belongs to a different company.' },
  });
}

/* -------------------------------------------------------------------------- */
/* the endpoints                                                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /tasks?companyId=… — every task on a company, across its projects.
 *
 * Access is the company read rule, so anyone on the account sees the work: the
 * owner, a teammate, the accounting manager, or a specialist on it. Narrowing
 * this to the assignee would make it useless as the screen it is for — a client
 * looking at what is outstanding on their account.
 *
 * `?specialistUserId=` is how the same endpoint answers "and only the ones this
 * specialist holds".
 */
async function listCompanyTasks({ userId, requestId, query }) {
  const { companyId, projectId, status, specialistUserId, search, limit, offset, sort, order } = query;

  const { company } = await projectService.loadCompanyForRead(prisma, { userId, companyId });

  const [tasks, total, statusCounts] = await Promise.all([
    repo.listCompanyTasks(prisma, {
      companyId, projectId, status, specialistUserId, search, limit, offset, sort, order,
    }),
    repo.countCompanyTasks(prisma, { companyId, projectId, status, specialistUserId, search }),
    repo.summarizeCompanyTasks(prisma, { companyId, projectId, specialistUserId, search }),
  ]);

  logEvent({
    event: 'task.company.list.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    taskCount: tasks.length,
  });

  return {
    companyId: company.id,
    companyName: company.companyName,
    ...dto.toTaskList({ tasks, statusCounts, total, limit, offset }),
  };
}

/**
 * GET /projects/:projectId/tasks — one project's tasks.
 *
 * loadProjectForRead does the work: it 404s a missing or soft-deleted project
 * before any task query runs, and applies the same read rule the project detail
 * screen does. A caller who cannot see the project cannot enumerate its tasks.
 */
async function listProjectTasks({ userId, requestId, projectId, query }) {
  const { status, specialistUserId, search, limit, offset, sort, order } = query;

  const { project, company } = await projectService.loadProjectForRead(prisma, { userId, projectId });

  const [tasks, total, statusCounts] = await Promise.all([
    repo.listProjectTasks(prisma, { projectId, status, specialistUserId, search, limit, offset, sort, order }),
    repo.countProjectTasks(prisma, { projectId, status, specialistUserId, search }),
    repo.summarizeProjectTasks(prisma, { projectId, specialistUserId, search }),
  ]);

  logEvent({
    event: 'task.project.list.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    taskCount: tasks.length,
  });

  return {
    projectId: project.id,
    companyId: company.id,
    ...dto.toTaskList({ tasks, statusCounts, total, limit, offset }),
  };
}

/** GET /tasks/:taskId — one task in full. */
async function getTask({ userId, requestId, taskId }) {
  const task = await repo.findTaskDetail(prisma, taskId);
  if (!task) throw taskNotFound();

  // The project read rule, asked about the project this task hangs off. It also
  // catches a task whose project has since been soft-deleted, which
  // findTaskDetail alone would still return.
  const { company } = await projectService.loadProjectForRead(prisma, { userId, projectId: task.projectId });

  logEvent({ event: 'task.read', status: 'success', requestId, userId, companyId: company.id, taskId });

  return dto.toTask(task);
}

/**
 * POST /tasks — file a task against a project.
 *
 * In one transaction, because three of the four things it decides are read from
 * rows that can move underneath it: who is staffed on the project, what the
 * project's deadline is, and whether the project still exists. Resolving the
 * specialist in one statement and inserting in another would let a project
 * re-staffed in between stamp a task with someone who had already left it.
 *
 * `specialistUserId` is COPIED from the project rather than referenced. The
 * database no longer holds the two together — the composite foreign key that
 * would have was dropped — so this assignment is the only thing that makes them
 * agree, and re-staffing a project must carry its tasks across (see
 * projectService.backfillSpecialists).
 */
async function createTask({ userId, requestId, input }) {
  const created = await prisma.$transaction(async (tx) => {
    const { caller, project, company } = await projectService.loadProjectForRead(tx, {
      userId,
      projectId: input.projectId,
    });

    assertCompanyMatches(input.companyId, project);
    assertTaskWriteAccess(caller, company, project);
    assertDeadlineAfterProject(input.deadlineDate, project.deadlineDate);

    return repo.createTask(tx, {
      projectId: project.id,
      taskName: input.taskName,
      description: input.description,
      deadlineDate: input.deadlineDate,
      status: input.status ?? undefined,
      specialistUserId: project.assignedSpecialistUserId,
      createdByUserId: caller.id,
    });
  });

  logEvent({
    event: 'task.created',
    status: 'success',
    requestId,
    userId,
    companyId: created.project?.companyId,
    projectId: created.projectId,
    taskId: created.id,
  });

  return dto.toTask(created);
}

/**
 * PATCH /tasks/:taskId/status — move a task through its states.
 *
 * The narrowest possible write, and the only one this feature exposes. Moving
 * TODO -> ACTIVE -> COMPLETED is what a specialist does with their own
 * breakdown; renaming a task or re-dating it is a different action that has not
 * been asked for, and adding it "while we are here" would widen the surface
 * without a screen behind it.
 *
 * No state machine is imposed. COMPLETED back to ACTIVE is a correction someone
 * makes after clicking the wrong row, and refusing it would leave them no way
 * to undo.
 */
async function updateTaskStatus({ userId, requestId, taskId, input }) {
  const updated = await prisma.$transaction(async (tx) => {
    const task = await repo.findTaskForAccess(tx, taskId);
    if (!task) throw taskNotFound();

    // A task on a soft-deleted project is not reachable, matching the lists.
    if (!task.project || task.project.deletedAt) throw projectNotFound();

    const { caller, project, company } = await projectService.loadProjectForRead(tx, {
      userId,
      projectId: task.projectId,
    });
    assertTaskWriteAccess(caller, company, project);

    return repo.updateTask(tx, taskId, { status: input.status });
  });

  logEvent({
    event: 'task.status.updated',
    status: 'success',
    requestId,
    userId,
    companyId: updated.project?.companyId,
    projectId: updated.projectId,
    taskId,
    detail: updated.status,
  });

  return dto.toTask(updated);
}

module.exports = {
  listCompanyTasks,
  listProjectTasks,
  getTask,
  createTask,
  updateTaskStatus,
  // Exported for tests and for any future caller that needs the same rule.
  assertDeadlineAfterProject,
  assertTaskWriteAccess,
};
