'use strict';

const { toDateOnly, toPerson, toSpecialist } = require('./projectDto');

/**
 * Response shapes for project tasks.
 *
 * The date primitives and the two person shapes are imported from projectDto
 * rather than rewritten: a task's deadline is the same kind of value as a
 * project's — a DATE column that must leave as "YYYY-MM-DD" and never as an ISO
 * timestamp, or every consumer runs it through `new Date()` and renders the day
 * before to anyone west of UTC. Two copies of that rule would drift the first
 * time either was touched.
 *
 * `specialist` is null on a task whose project is unstaffed. That is a real
 * state, not missing data, and every consumer has to render "Unassigned".
 */

/**
 * One row of a task table.
 *
 * `project` is nested rather than flattened because the company-wide list spans
 * projects and the project name is a column on that screen. `projectId` is ALSO
 * lifted to the top level — it is the field the create form and every filter
 * speak in, and making callers reach into a nested object for the id they just
 * posted is friction with nothing behind it.
 */
function toTask(task) {
  const project = task.project ?? null;

  return {
    id: task.id,

    projectId: task.projectId,
    project: project
      ? {
          id: project.id,
          projectName: project.projectName,
          status: project.status,
          // The lower bound on this task's own deadline — a task must fall
          // after its project. Sent so a date picker can enforce it without a
          // second request.
          deadlineDate: toDateOnly(project.deadlineDate),
        }
      : null,

    companyId: project?.companyId ?? null,
    companyName: project?.company?.companyName ?? null,

    taskName: task.taskName,
    description: task.description,
    status: task.status,
    deadlineDate: toDateOnly(task.deadlineDate),

    // Who owns the work. Copied from the project's assigned specialist by the
    // server at creation, never taken from the request.
    specialist: toSpecialist(task.specialist),
    createdBy: toPerson(task.createdBy),

    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * The per-status counters above a task table.
 *
 * Every status is present with an explicit zero rather than only the ones that
 * have rows: a counter that vanishes when it reaches nought is a counter that
 * makes the UI shift as work is completed, and "0 ACTIVE" is information.
 */
function toStatusCounts(groups) {
  const counts = { TODO: 0, ACTIVE: 0, COMPLETED: 0 };
  for (const g of groups ?? []) {
    counts[g.status] = g._count?._all ?? 0;
  }
  return counts;
}

/** A page of tasks, with the counters and the paging block. */
function toTaskList({ tasks, statusCounts, total, limit, offset }) {
  return {
    tasks: tasks.map(toTask),
    statusCounts: toStatusCounts(statusCounts),
    pagination: { total, limit, offset, hasMore: offset + tasks.length < total },
  };
}

module.exports = {
  toTask,
  toStatusCounts,
  toTaskList,
};
