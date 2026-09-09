'use strict';

const { prisma } = require('../config/prisma');
const repo = require('../repositories/projectRepository');
const taskRepo = require('../repositories/projectTaskRepository');
const projectService = require('./projectService');
const dto = require('../dto/projectExportDto');
const csv = require('../utils/csv');
const ApiError = require('../utils/ApiError');
const { logEvent } = require('../utils/auditLog');

/**
 * CSV exports of the projects screens.
 *
 *   GET /projects/export?companyId=42   the company's project list, one row each
 *   GET /projects/42/export             one project, one row per task
 *
 * A SEPARATE SERVICE rather than two more functions on projectService, for the
 * reason the file it would have joined is already 950 lines: these two share
 * nothing with the JSON endpoints except the access rules, and those are
 * imported rather than restated. Everything else here — the row cap, the
 * filename, the flattening — exists only because the answer is a file.
 *
 * NO NEW ACCESS RULES ARE DEFINED IN THIS FILE, and that is the load-bearing
 * part. An export is the highest-consequence read in the API: it hands over an
 * entire client's book of work in one response, so a rule that was subtly looser
 * here than on the screen it mirrors would leak everything at once rather than a
 * row at a time. Both functions below go through the same loaders the JSON
 * endpoints use — projectService.loadCompanyForRead, and the specialist
 * narrowing from listProjects and getProject — so the file can never show what
 * the screen would not.
 */

/*
 * The row cap.
 *
 * A serverless function buffers its whole response in memory before sending a
 * byte and is killed at 30 seconds (see vercel.json), so an unbounded export is
 * not a slow export — it is a 502 with nothing to show for it. Five thousand
 * rows is roughly a megabyte of CSV, far inside both limits and far beyond any
 * real company's book of work: a project is a piece of commissioned work, not a
 * log line.
 *
 * Over the cap the request is REFUSED rather than truncated. A CSV that silently
 * stops at row 5000 is the worst possible outcome — it looks complete, it
 * reconciles to the wrong total, and nothing on the file says so. A 400 naming
 * the filters is something the caller can act on.
 */
const MAX_ROWS = 5000;

/*
 * Read one row past the cap instead of counting first.
 *
 * count() then findMany() is two queries to learn something one query already
 * knows: asking for MAX_ROWS + 1 and getting them all back IS the overflow
 * signal. The extra row is never returned — it exists to be counted.
 */
const FETCH_LIMIT = MAX_ROWS + 1;

function tooManyRows(exporting, filterBy) {
  return new ApiError(400, 'That export is too large — narrow it down and try again.', {
    code: 'EXPORT_TOO_LARGE',
    details: { limit: MAX_ROWS, exporting, filterBy },
  });
}

function projectNotFound() {
  return new ApiError(404, 'Project not found.', { code: 'PROJECT_NOT_FOUND' });
}

/* -------------------------------------------------------------------------- */
/* the company's project list                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /projects/export?companyId=… — every project on the account as a CSV.
 *
 * The same rows GET /projects serves, with the paging removed and the columns
 * flattened. The filters are kept — status, search, specialist — because the
 * export a user wants is almost always the table they are looking at, and a
 * download button that ignores the filters above it exports the wrong file.
 *
 * scopeToOwnWork is what keeps a specialist's export to a specialist's own
 * projects. It is imported from projectService rather than written again here
 * for exactly the reason stated where it is defined: the day the table enforces
 * this and the export does not is the day the export leaks every project the
 * table refuses to show — and it leaks all of them in one file.
 */
async function exportProjects({ userId, requestId, query }) {
  const { companyId, status, search, sort, order } = query;

  const { caller, company } = await projectService.loadCompanyForRead(prisma, { userId, companyId });

  const assignedSpecialistUserId = projectService.scopeToOwnWork(caller, query.assignedSpecialistUserId);

  const projects = await repo.listProjects(prisma, {
    companyId,
    status,
    assignedSpecialistUserId,
    search,
    limit: FETCH_LIMIT,
    offset: 0,
    sort,
    order,
  });

  if (projects.length > MAX_ROWS) {
    throw tooManyRows('projects', ['status', 'search', 'assignedSpecialistUserId']);
  }

  logEvent({
    event: 'project.list.export',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectCount: projects.length,
  });

  return {
    filename: `projects-${csv.slugify(company.companyName, 'company')}-${csv.today()}`,
    headers: dto.PROJECT_LIST_HEADERS,
    // Passed straight to map, whose (element, index) is exactly what the row
    // builder takes — the index becomes the file's `#` column.
    rows: projects.map((project, index) => dto.toProjectListRow(project, index)),
  };
}

/* -------------------------------------------------------------------------- */
/* one project and its tasks                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /projects/:projectId/export — one project, one row per task.
 *
 * The access check is getProject's, in full and in the same order, because this
 * IS getProject with the tasks joined on: the project is loaded, the company
 * read rule is applied to it, and then a specialist is held to their own work
 * with a 404 rather than a 403 — from where they stand a project they are not
 * staffed on and a project that does not exist are the same thing, and a 403
 * would confirm which of the client's projects are real.
 *
 * findProjectDetail is what is loaded rather than the access-shaped row, because
 * the file needs the joins: the service name and the specialist's name are two
 * of its columns. It runs before the access check for the same reason getProject
 * does it in this order — the company cannot be looked up until the project says
 * which one it belongs to.
 *
 * The task read is deliberately NOT narrowed further. Whoever may open the
 * project may see the work on it; that is the rule GET /projects/:id/tasks
 * already applies, and an export showing fewer tasks than the screen would be a
 * quietly wrong file.
 */
async function exportProject({ userId, requestId, projectId }) {
  const project = await repo.findProjectDetail(prisma, projectId);
  if (!project) throw projectNotFound();

  const { caller, company } = await projectService.loadCompanyForRead(prisma, {
    userId,
    companyId: project.companyId,
  });

  if (caller.role?.code === 'SPECIALIST' && project.assignedSpecialistUserId !== caller.id) {
    throw projectNotFound();
  }

  const tasks = await taskRepo.listProjectTasks(prisma, {
    projectId: project.id,
    status: null,
    specialistUserId: null,
    search: null,
    limit: FETCH_LIMIT,
    offset: 0,
    // The board's own order: soonest deadline first. An export arriving in
    // insertion order would have to be re-sorted before it could be read.
    sort: 'deadlineDate',
    order: 'asc',
  });

  if (tasks.length > MAX_ROWS) throw tooManyRows('tasks', ['status', 'specialistUserId']);

  logEvent({
    event: 'project.export',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    taskCount: tasks.length,
  });

  return {
    filename: `project-${project.id}-${csv.slugify(project.projectName, 'project')}-${csv.today()}`,
    headers: dto.PROJECT_TASK_HEADERS,
    rows: dto.toProjectTaskRows(project, tasks),
  };
}

module.exports = {
  MAX_ROWS,
  exportProjects,
  exportProject,
};
