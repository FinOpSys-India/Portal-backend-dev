'use strict';

const { toDateOnly, toPercent } = require('./projectDto');

/**
 * The two CSV shapes: a company's project list, and one project with its tasks.
 *
 * SEPARATE FROM projectDto ON PURPOSE. The JSON shapes there are nested — a
 * project carries a `service` object and a `specialist` object, a task carries
 * its project — because a client renders from a tree. A CSV is a grid: every
 * column is a scalar, the nesting has to be flattened into named columns, and a
 * change to how a screen renders a specialist has no business changing the
 * column layout of a file somebody has already built a pivot table on.
 *
 * THE COLUMN ORDER IS THE CONTRACT. Someone will import these into a spreadsheet
 * with formulas that reference C7, so columns are appended at the end and never
 * inserted, renamed, or reordered.
 *
 * Dates leave as "YYYY-MM-DD" for the same reason they do in projectDto: a
 * deadline is a calendar day somebody picked, and an ISO timestamp in a cell
 * renders as the day before to every reader west of UTC.
 */

/** A timestamp column as the calendar day it fell on. */
function toDayStamp(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * A person as one cell.
 *
 * The name alone, not "Name <email>": a spreadsheet column that has to be split
 * before it can be used is a column that was exported wrong. The email is worth
 * its own column where it matters, and on these two files it does not — nobody
 * mails a specialist out of a project list.
 */
function personName(person) {
  if (!person) return null;
  return `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() || null;
}

/** The service a project is against — the specialization, which is the name a human uses. */
function serviceName(project) {
  return project.servicePlan?.specialization?.specializationName ?? null;
}

/* -------------------------------------------------------------------------- */
/* the company project list                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Nine columns, and the two omissions are the design.
 *
 * `description` is not here. It is the one field on a project that runs to five
 * thousand characters of free text with newlines in it, and a single such cell
 * makes the whole file unreadable in a spreadsheet — the row grows to the height
 * of the note and the columns beside it are pushed off the screen. This export
 * is the overview of an account's work; the note lives on the project, one
 * request away.
 *
 * The project's database id is not here either. `#` is a SERIAL NUMBER — the
 * row's position in this file, counted from one — which is what a reader wants
 * when they say "line 4": something to point at in a meeting, not a key. It is
 * deliberately not stable across two downloads, because it describes the file
 * rather than the record.
 *
 * The consequence is worth stating plainly: THIS FILE CANNOT BE JOINED BACK to
 * the API by id. That is the trade the serial number makes, and it is the right
 * one for a summary somebody reads — the per-project export keeps its ids, and
 * is where a script should look.
 */
const PROJECT_LIST_HEADERS = [
  '#',
  'Company',
  'Project',
  'Service',
  'Deadline',
  'Status',
  'Progress (%)',
  'Specialist',
  'Created',
];

/**
 * @param {object} project a row as projectRepository's PROJECT_SELECT returns it
 * @param {number} index   the project's 0-based position in the page being
 *                         written; becomes the `#` column, counted from one
 *
 * The signature matches Array.prototype.map's, so the caller passes it directly.
 * The index is a parameter rather than a counter held in this module because a
 * module-level counter would carry across requests — every export after the
 * first would start numbering wherever the last one stopped.
 */
function toProjectListRow(project, index = 0) {
  return [
    index + 1,
    project.company?.companyName ?? null,
    project.projectName,
    serviceName(project),
    toDateOnly(project.deadlineDate),
    project.status,
    toPercent(project.progressBar),
    personName(project.assignedSpecialist),
    toDayStamp(project.createdAt),
  ];
}

/* -------------------------------------------------------------------------- */
/* one project and its tasks                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE ROW PER TASK, with the project repeated down the left.
 *
 * The alternative — a project block, a blank line, then a task table — reads
 * better on screen and is worse at everything a CSV is for: it is two tables in
 * one file, so nothing can sort it, filter it, pivot it, or concatenate it with
 * the export of the next project. Repeating six project columns is the cost of
 * a file that behaves like data, and it is what every reporting tool expects.
 *
 * A project with NO tasks still produces one row, with the task columns empty.
 * An export that returns a header and nothing else looks like a failure from the
 * other side of the screen, and "this project has no tasks yet" is an answer
 * worth being able to see.
 */
const PROJECT_TASK_HEADERS = [
  '#',
  'Company',
  'Project',
  'Service',
  'Project Deadline',
  'Project Status',
  'Project Specialist',
  'Task',
  'Task Status',
  'Task Deadline',
  'Task Specialist',
  'Task Created',
];

/**
 * The six project cells repeated down the left of every task row.
 *
 * Built once per export rather than per row: they are identical on every line by
 * definition — the file is one project — so rebuilding them per task would be
 * the same six lookups done as many times as there are tasks.
 */
function projectColumns(project) {
  return [
    project.company?.companyName ?? null,
    project.projectName,
    serviceName(project),
    toDateOnly(project.deadlineDate),
    project.status,
    personName(project.assignedSpecialist),
  ];
}

function toProjectTaskRows(project, tasks) {
  const lead = projectColumns(project);

  // The `#` counts TASKS, so the empty-project row is still line 1 — the file
  // has one row, and numbering it 1 is what makes it read as a row rather than
  // as a fragment.
  if (!tasks?.length) {
    return [[1, ...lead, null, null, null, null, null]];
  }

  return tasks.map((task, index) => [
    index + 1,
    ...lead,
    task.taskName,
    task.status,
    toDateOnly(task.deadlineDate),
    personName(task.specialist),
    toDayStamp(task.createdAt),
  ]);
}

module.exports = {
  PROJECT_LIST_HEADERS,
  PROJECT_TASK_HEADERS,
  toProjectListRow,
  toProjectTaskRows,
};
