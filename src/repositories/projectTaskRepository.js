'use strict';

/**
 * Data access for project tasks.
 *
 * Same conventions as projectRepository: the Prisma client is the first
 * argument, so a function works identically inside `$transaction` and outside
 * it, and `deleted_at IS NULL` is applied HERE rather than in the service, so no
 * caller can forget it.
 *
 * The table carries ONE index — `project_tasks(project_id)` — which is what both
 * list queries below are built around. The company-wide list has no company
 * column to filter on (a task's company is its project's), so it filters through
 * the `project` relation instead; Postgres resolves that against the same index
 * from the projects side.
 */

/**
 * The columns a task row needs to render, and nothing else.
 *
 * `project` is joined onto every row, including the per-project list where it is
 * technically redundant. It costs one join for the whole page and it is what
 * makes a row self-describing — the company-wide table shows the project name as
 * a column, and the same object serves both screens rather than two shapes that
 * drift.
 *
 * `project.deadlineDate` is selected because it is not decoration: the rule that
 * a task falls after its project's deadline is checked against it, and a client
 * rendering a date picker needs the lower bound without a second request.
 */
const TASK_SELECT = {
  id: true,
  projectId: true,
  taskName: true,
  description: true,
  status: true,
  deadlineDate: true,
  specialistUserId: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  project: {
    select: {
      id: true,
      companyId: true,
      projectName: true,
      status: true,
      deadlineDate: true,
      company: { select: { id: true, companyName: true } },
    },
  },
  // Null on a task whose project is unstaffed — a real state, not missing data.
  // Carries specificRole for the same reason projects do: which KIND of
  // specialist holds the work is the point of naming them.
  specialist: {
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
  createdBy: {
    select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, avatarKey: true },
  },
};

/**
 * The few columns the authorization step needs, plus the project columns the
 * rules are decided against.
 *
 * Kept separate from TASK_SELECT for the same reason findProjectForAccess is:
 * loading two user records and a company only to return a 403 is work thrown
 * away on the path where it is most wasteful.
 */
const TASK_ACCESS_SELECT = {
  id: true,
  projectId: true,
  specialistUserId: true,
  createdByUserId: true,
  status: true,
  deadlineDate: true,
  project: {
    select: {
      id: true,
      companyId: true,
      createdByUserId: true,
      assignedSpecialistUserId: true,
      deadlineDate: true,
      deletedAt: true,
    },
  },
};

/* -------------------------------------------------------------------------- */
/* where clauses                                                              */
/* -------------------------------------------------------------------------- */

/** One project's tasks. */
function buildProjectTaskWhere({ projectId, status, specialistUserId, search }) {
  const where = { projectId, deletedAt: null };

  if (status) where.status = status;
  if (specialistUserId) where.specialistUserId = specialistUserId;
  // Name only, matching the projects list: searching the description would make
  // a long note match a query typed for a title, which reads as a bug from the
  // other side of the screen.
  if (search) where.taskName = { contains: search, mode: 'insensitive' };

  return where;
}

/**
 * A company's tasks, across its projects.
 *
 * The company is reached THROUGH the project, because `project_tasks` has no
 * company column — deliberately, so the two can never disagree (see the model in
 * prisma/schema.prisma). `project.deletedAt: null` matters as much as the
 * task's own: a soft-deleted project's tasks must leave the list with it, or
 * removing a project would leave its work visibly behind.
 */
function buildCompanyTaskWhere({ companyId, projectId, status, specialistUserId, search }) {
  const where = {
    deletedAt: null,
    project: {
      companyId,
      deletedAt: null,
      ...(projectId ? { id: projectId } : {}),
    },
  };

  if (status) where.status = status;
  if (specialistUserId) where.specialistUserId = specialistUserId;
  if (search) where.taskName = { contains: search, mode: 'insensitive' };

  return where;
}

/* -------------------------------------------------------------------------- */
/* reads                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The secondary sort on id is not decoration, in either list: tasks routinely
 * share a deadline, and without a tiebreaker their relative order is whatever
 * the planner returns — which can differ between two requests for the same page
 * and make a row appear twice while another is skipped.
 *
 * The default is the deadline ascending — soonest first — because that is the
 * question a task list exists to answer.
 */
const taskOrder = (sort, order) => [{ [sort || 'deadlineDate']: order || 'asc' }, { id: 'desc' }];

function listProjectTasks(client, { projectId, status, specialistUserId, search, limit, offset, sort, order }) {
  return client.projectTask.findMany({
    where: buildProjectTaskWhere({ projectId, status, specialistUserId, search }),
    select: TASK_SELECT,
    orderBy: taskOrder(sort, order),
    take: limit,
    skip: offset,
  });
}

function countProjectTasks(client, { projectId, status, specialistUserId, search }) {
  return client.projectTask.count({
    where: buildProjectTaskWhere({ projectId, status, specialistUserId, search }),
  });
}

function listCompanyTasks(client, { companyId, projectId, status, specialistUserId, search, limit, offset, sort, order }) {
  return client.projectTask.findMany({
    where: buildCompanyTaskWhere({ companyId, projectId, status, specialistUserId, search }),
    select: TASK_SELECT,
    orderBy: taskOrder(sort, order),
    take: limit,
    skip: offset,
  });
}

function countCompanyTasks(client, { companyId, projectId, status, specialistUserId, search }) {
  return client.projectTask.count({
    where: buildCompanyTaskWhere({ companyId, projectId, status, specialistUserId, search }),
  });
}

/**
 * How many of a list's tasks sit in each status — the counters above the table.
 *
 * One grouped query rather than three counts, and it deliberately ignores
 * `status` from the filter: a "3 TODO / 1 ACTIVE" summary computed after
 * filtering to TODO would only ever report the filter back to itself.
 */
function summarizeCompanyTasks(client, { companyId, projectId, specialistUserId, search }) {
  return client.projectTask.groupBy({
    by: ['status'],
    where: buildCompanyTaskWhere({ companyId, projectId, specialistUserId, search }),
    _count: { _all: true },
  });
}

function summarizeProjectTasks(client, { projectId, specialistUserId, search }) {
  return client.projectTask.groupBy({
    by: ['status'],
    where: buildProjectTaskWhere({ projectId, specialistUserId, search }),
    _count: { _all: true },
  });
}

/** One task in full, or null when it is missing or soft-deleted. */
function findTaskDetail(client, taskId) {
  return client.projectTask.findFirst({
    where: { id: taskId, deletedAt: null },
    select: TASK_SELECT,
  });
}

/** One task plus the project columns the access rules read. */
function findTaskForAccess(client, taskId) {
  return client.projectTask.findFirst({
    where: { id: taskId, deletedAt: null },
    select: TASK_ACCESS_SELECT,
  });
}

/**
 * Live tasks on a project that fall after a candidate date.
 *
 * Read by the project-update path: a task must be due ON OR BEFORE its project,
 * so pulling a project's deadline earlier can invalidate tasks already filed.
 * Counting them is what lets that edit be refused with a number the user can act
 * on rather than silently breaking the rule.
 */
function countTasksAfter(client, { projectId, date }) {
  return client.projectTask.count({
    where: { projectId, deletedAt: null, deadlineDate: { gt: date } },
  });
}

/* -------------------------------------------------------------------------- */
/* writes                                                                     */
/* -------------------------------------------------------------------------- */

function createTask(client, data) {
  return client.projectTask.create({ data, select: TASK_SELECT });
}

function updateTask(client, taskId, data) {
  return client.projectTask.update({ where: { id: taskId }, data, select: TASK_SELECT });
}

/**
 * Point a project's OPEN tasks at a specialist — the carry-over that keeps a
 * task's owner equal to its project's.
 *
 * WHY THIS HAS TO EXIST. The database was going to hold that equality itself,
 * through a composite foreign key onto projects(id, assigned_specialist_user_id)
 * with ON UPDATE CASCADE. That constraint was dropped, and with it the cascade —
 * so re-staffing a project now moves the project alone and leaves its tasks
 * pointing at whoever held it before. This is the replacement, and it must be
 * called from every path that writes projects.assigned_specialist_user_id.
 *
 * COMPLETED TASKS ARE DELIBERATELY LEFT ALONE. Naming a new specialist on work
 * that was already finished would rewrite history in exactly the way the stored
 * (rather than derived) column exists to prevent — the same reason the project
 * sweep skips COMPLETED projects. The consequence is that a finished task keeps
 * the specialist who finished it, so "my tasks" stays true for both people.
 *
 * `updateMany` rather than a read-then-write loop: this runs once per project in
 * a sweep that can touch a whole company, and the rows are identified by a
 * predicate rather than by ids nobody needs to see.
 *
 * @returns {Promise<{ count: number }>} how many tasks moved
 */
function reassignOpenTaskSpecialist(client, { projectId, specialistUserId }) {
  return client.projectTask.updateMany({
    where: {
      projectId,
      deletedAt: null,
      status: { in: ['TODO', 'ACTIVE'] },
      /*
       * "Everything not already pointing at this person", spelled out in two
       * branches rather than as a single negation.
       *
       * The unstaffed rows are the whole point of the sweep — an accounting
       * manager may file tasks on a project before anyone is on it, and those
       * carry a NULL specialist. A bare `NOT: { specialistUserId }` invites the
       * classic SQL null trap, where `specialist_user_id <> 77` is UNKNOWN for a
       * NULL row and the row is skipped: the sweep would then quietly leave
       * behind exactly the tasks it exists to fill in.
       *
       * The second branch is only an optimisation — it keeps the returned count
       * honest by not rewriting rows that already hold the right answer.
       */
      OR: [{ specialistUserId: null }, { specialistUserId: { not: specialistUserId } }],
    },
    data: { specialistUserId },
  });
}

module.exports = {
  TASK_SELECT,
  TASK_ACCESS_SELECT,
  listProjectTasks,
  countProjectTasks,
  listCompanyTasks,
  countCompanyTasks,
  summarizeProjectTasks,
  summarizeCompanyTasks,
  findTaskDetail,
  findTaskForAccess,
  countTasksAfter,
  createTask,
  updateTask,
  reassignOpenTaskSpecialist,
};
