'use strict';

const common = require('./common');
const { validateDeadline } = require('./projectValidator');
const ApiError = require('../utils/ApiError');

/**
 * Input validation for the task endpoints.
 *
 * What is deliberately NOT accepted is again the point of the file:
 *
 *   createdByUserId     identity comes from the verified access token.
 *   specialistUserId    copied by the server from the project's assigned
 *                       specialist. One project has one specialist, so there is
 *                       nothing here for a caller to choose — and accepting it
 *                       would let work be filed against someone who is not on
 *                       the account.
 *
 * `projectId` and `companyId` ARE accepted, because they are lookup keys rather
 * than claims: the service checks both against the caller's access, and
 * `companyId` is checked against the project's own before anything is written.
 *
 * THE DEADLINE RULE IS NOT HERE, and cannot be. A task's deadline must fall
 * after its PROJECT's deadline, which means the check needs a row this file has
 * no way to read. It lives in projectTaskService, which already loads the
 * project to authorize the caller.
 */

const TASK_STATUSES = ['TODO', 'ACTIVE', 'COMPLETED'];

const CREATE_FIELDS = ['projectId', 'companyId', 'taskName', 'description', 'deadlineDate', 'status'];
const STATUS_FIELDS = ['status'];

const LIMITS = {
  taskName: 255,
  description: 5000,
  search: 120,
};

/** Columns a caller may sort a task table by. Never the raw query value. */
const SORTABLE = ['deadlineDate', 'taskName', 'status', 'createdAt', 'updatedAt'];

/* -------------------------------------------------------------------------- */
/* the description                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The task's description — REQUIRED, matching the NOT NULL column.
 *
 * A task states what it is; "do the thing" with an empty body is a row nobody
 * downstream can act on. This is the one place tasks are stricter than projects,
 * whose description is nullable, and it follows from the column rather than
 * being invented here.
 *
 * The control-character guard is relaxed to allow tab, newline and carriage
 * return, exactly as projectValidator.validateDescription does: a note about a
 * piece of work legitimately spans lines, and rejecting them would make the
 * field unusable for the thing it is for. Length is still capped, and the value
 * is stored and returned as text — never interpolated into anything.
 */
function validateTaskDescription(value, field = 'description') {
  if (typeof value !== 'string') {
    throw common.fieldError(field, `${field} must be text.`, 'Enter a description.');
  }

  const text = value.trim();
  if (!text) {
    throw common.fieldError(field, `${field} is required.`, 'Describe what this task is.');
  }
  if (text.length > LIMITS.description) {
    throw common.fieldError(
      field,
      `${field} cannot exceed ${LIMITS.description} characters.`,
      `Must be at most ${LIMITS.description} characters.`
    );
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw common.fieldError(
        field,
        `${field} contains invalid characters.`,
        'Remove any special control characters.'
      );
    }
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* the endpoints                                                              */
/* -------------------------------------------------------------------------- */

/**
 * POST /tasks
 *
 *   { projectId, taskName, description, deadlineDate, companyId?, status? }
 *
 * `companyId` is OPTIONAL and is a consistency check, not a destination. The
 * task's company is its project's, always — sending one that disagrees with the
 * project is a 400 rather than a silent write to whichever the code read first.
 * The upload endpoint treats it the same way, for the same reason.
 *
 * `deadlineDate` is NOT required to be in the future here, unlike a project's.
 * The binding rule is that it falls after the PROJECT's deadline, checked in the
 * service — and applying a second, weaker rule on top would refuse a perfectly
 * ordinary task filed against a project that is already overdue.
 */
function validateTaskCreate(body = {}) {
  common.rejectUnknown(body, CREATE_FIELDS);
  common.requireFields(body, ['projectId', 'taskName', 'description', 'deadlineDate']);

  return {
    projectId: common.parseId(body.projectId, 'projectId'),
    companyId:
      body.companyId === undefined || body.companyId === null || body.companyId === ''
        ? null
        : common.parseId(body.companyId, 'companyId'),
    taskName: common.str(body.taskName, 'taskName', { max: LIMITS.taskName }),
    description: validateTaskDescription(body.description),
    deadlineDate: validateDeadline(body.deadlineDate, 'deadlineDate'),
    // A task may be opened straight into ACTIVE by someone who is starting it
    // now. Absent means TODO, which is the column's own default.
    status: body.status === undefined ? null : common.enumValue(body.status, 'status', TASK_STATUSES),
  };
}

/**
 * PATCH /tasks/:taskId/status  { status }
 *
 * Its own endpoint rather than a general update, because moving a task through
 * its states is the action the board performs and the only one the specialist
 * doing the work needs. `rejectUnknown` is what makes that explicit: a client
 * that sends `taskName` here is told so, instead of having it quietly dropped.
 */
function validateTaskStatusUpdate(body = {}) {
  common.rejectUnknown(body, STATUS_FIELDS);
  common.requireFields(body, ['status']);

  return { status: common.enumValue(body.status, 'status', TASK_STATUSES) };
}

/**
 * The filters both list endpoints share.
 *
 * `specialistUserId` is the "and if that specialist is associated with it"
 * half of the company view — the same shape as `assignedSpecialistUserId` on
 * the projects list, so a client that already narrows one screen to a person
 * narrows this one the same way.
 */
function taskFilters(query) {
  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: SORTABLE,
    defaultSort: 'deadlineDate',
  });

  return {
    status: query.status ? common.enumValue(query.status, 'status', TASK_STATUSES) : null,
    specialistUserId: query.specialistUserId
      ? common.parseId(query.specialistUserId, 'specialistUserId')
      : null,
    search: query.search ? common.str(query.search, 'search', { max: LIMITS.search }) : null,
    ...page,
    // Soonest deadline first unless the caller says otherwise;
    // common.pagination defaults `order` to desc, which is the wrong way round
    // for a due date.
    order: query.order ? page.order : 'asc',
  };
}

/**
 * GET /tasks?companyId=…
 *
 * `companyId` is REQUIRED, with no admin exemption, for the same reason the
 * company-wide document list requires it: an unfiltered read would put two
 * clients' work on one screen.
 */
function validateCompanyTaskListQuery(query = {}) {
  const allowed = [
    'companyId',
    'projectId',
    'status',
    'specialistUserId',
    'search',
    'limit',
    'offset',
    'sort',
    'order',
  ];
  common.rejectUnknown(query, allowed, 'query string');

  if (query.companyId === undefined || query.companyId === null || query.companyId === '') {
    throw new ApiError(400, 'companyId is required.', {
      code: 'VALIDATION_ERROR',
      fields: { companyId: 'Select a company.' },
    });
  }

  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    projectId: query.projectId ? common.parseId(query.projectId, 'projectId') : null,
    ...taskFilters(query),
  };
}

/** GET /projects/:projectId/tasks — the project id comes from the path. */
function validateProjectTaskListQuery(query = {}) {
  const allowed = ['status', 'specialistUserId', 'search', 'limit', 'offset', 'sort', 'order'];
  common.rejectUnknown(query, allowed, 'query string');

  return taskFilters(query);
}

module.exports = {
  TASK_STATUSES,
  SORTABLE,
  LIMITS,
  validateTaskDescription,
  validateTaskCreate,
  validateTaskStatusUpdate,
  validateCompanyTaskListQuery,
  validateProjectTaskListQuery,
};
