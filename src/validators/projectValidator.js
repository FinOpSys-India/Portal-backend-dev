'use strict';

const common = require('./common');
const ApiError = require('../utils/ApiError');

/**
 * Input validation for the project endpoints.
 *
 * What is deliberately NOT accepted is the point of the file:
 *
 *   createdByUserId            identity comes from the verified access token.
 *   assignedSpecialistUserId   decided by the server from the company's
 *                              staffing (see projectService.resolveSpecialist).
 *                              Accepting it would let a customer put whoever
 *                              they liked on their own account's work.
 *
 * `companyId` IS accepted, because it is a lookup key rather than a claim — the
 * service checks it against the caller's access before anything is written.
 */

const PROJECT_STATUSES = ['TODO', 'ACTIVE', 'COMPLETED'];

const CREATE_FIELDS = [
  'companyId',
  'projectName',
  'deadlineDate',
  'servicePlanId',
  'specializationId',
  'serviceCode',
  'description',
];
const UPDATE_FIELDS = ['projectName', 'deadlineDate', 'description', 'status', 'progressBar'];

const LIMITS = {
  projectName: 255,
  description: 5000,
  serviceCode: 50,
};

/** Columns a caller may sort the table by. Never the raw query value. */
const SORTABLE = ['deadlineDate', 'projectName', 'status', 'createdAt', 'updatedAt'];

/* -------------------------------------------------------------------------- */
/* the deadline                                                               */
/* -------------------------------------------------------------------------- */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Bounds, not a business rule. A deadline before 2000 or a century out is a
// typo or a probe; anything in between is somebody's real filing date.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * A calendar day, as "YYYY-MM-DD", returned as a Date pinned to midnight UTC.
 *
 * Two things this does that `new Date(value)` does not:
 *
 *   - It refuses anything that is not exactly a date. `new Date("2026-13-45")`
 *     and `new Date("next tuesday")` both produce a value (one rolls over into
 *     2027, the other is Invalid Date), and neither is a date the user typed.
 *     The round-trip comparison below is what catches 31 February, which the
 *     regex cannot.
 *   - It builds the Date in UTC. `new Date("2026-12-31")` is already parsed as
 *     UTC by the spec, but `new Date(2026, 11, 31)` is not, and mixing the two
 *     is how a deadline ends up stored as the day before.
 *
 * `mustBeFuture` adds the one business rule this function knows about: the
 * deadline must fall strictly after today. It is applied when a project is
 * CREATED, where a due date of today or earlier is a typo rather than a plan —
 * nobody opens a piece of work that was already due.
 *
 * It is deliberately NOT applied on update. An existing project's deadline slides
 * into the past simply by time passing, and any later edit — renaming it, moving
 * it to IN_PROGRESS — would then be refused over a date the user never touched.
 * Correcting an overdue project is exactly when the record most needs to be
 * editable.
 *
 * "Today" is midnight UTC, matching how the value itself is pinned. For a caller
 * far enough east that their local tomorrow is still UTC today, that rejects a
 * date they would call valid; the alternative is trusting a client-sent timezone
 * to relax a validation rule, which is worse.
 */
function validateDeadline(value, field = 'deadlineDate', { mustBeFuture = false } = {}) {
  const invalid = (detail) =>
    new ApiError(400, `${field} must be a calendar date in YYYY-MM-DD form.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: detail },
    });

  if (typeof value !== 'string' || !DATE_PATTERN.test(value.trim())) {
    throw invalid('Enter a date as YYYY-MM-DD.');
  }

  const raw = value.trim();
  const [year, month, day] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Date.UTC rolls 2026-02-31 forward into March rather than failing, so the
  // only reliable check is whether the parts survived the trip unchanged.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw invalid('That date does not exist.');
  }

  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw invalid(`Enter a year between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }

  if (mustBeFuture && parsed.getTime() <= todayUtcMidnight()) {
    throw new ApiError(400, `${field} must be a date after today.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: 'Choose a date after today.' },
    });
  }

  return parsed;
}

/**
 * Today at midnight UTC, as milliseconds.
 *
 * Truncating to the day is what makes the comparison a CALENDAR one: comparing
 * against `Date.now()` would accept today's date whenever the request arrived
 * after 00:00, so "no deadline of today" would hold only for the first instant
 * of each day.
 */
function todayUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/* -------------------------------------------------------------------------- */
/* which service                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A project names its service in ONE of three ways, and exactly one must be
 * sent. All three are equivalent — they name the same thing at different levels
 * of the same chain, and the service resolves whichever arrives to the same
 * plan:
 *
 *   specializationId  the SERVICE: 1 Bookkeeping, 2 Payroll, 3 Tax. This is what
 *                     the form's dropdown really is, since a company picks a
 *                     service and not a pricing tier — the tier is already
 *                     settled by what they subscribed to.
 *   servicePlanId     the plan (tier) inside that service. The most specific,
 *                     and what GET /projects/services returns as each option's
 *                     value.
 *   serviceCode       the specialization CODE — 'BOOKKEEPING', 'PAYROLL', 'TAX'.
 *                     For a script or an integration that would rather send a
 *                     name than look up an id.
 *
 *      serviceCode  <->  specializationId  ->  servicePlanId
 *      (a name)          (the service)        (the tier they bought)
 *
 * Whichever is sent, it is resolved against the company's OWN active
 * subscription, so none of them can name a service the company is not paying
 * for. Requiring exactly one rather than ranking them means a request that sends
 * a mismatched pair — a bookkeeping plan id with a payroll specialization — is a
 * 400 instead of quietly using whichever the code happened to read first.
 */
function validateServiceSelector(body) {
  const sent = (field) => body[field] !== undefined && body[field] !== null && body[field] !== '';

  const selectors = ['servicePlanId', 'specializationId', 'serviceCode'].filter(sent);

  if (selectors.length > 1) {
    throw new ApiError(400, `Name the service once — received: ${selectors.join(', ')}.`, {
      code: 'VALIDATION_ERROR',
      fields: { specializationId: 'Choose one way to name the service.' },
      details: { received: selectors },
    });
  }
  if (!selectors.length) {
    throw new ApiError(400, 'A service is required.', {
      code: 'VALIDATION_ERROR',
      fields: { specializationId: 'Select a service.' },
      details: { accepts: ['specializationId', 'servicePlanId', 'serviceCode'] },
    });
  }

  const selector = { servicePlanId: null, specializationId: null, serviceCode: null };

  if (sent('servicePlanId')) {
    selector.servicePlanId = common.parseId(body.servicePlanId, 'servicePlanId');
  } else if (sent('specializationId')) {
    selector.specializationId = common.parseId(body.specializationId, 'specializationId');
  } else {
    // Upper-cased, because that is how specialization_code is stored and the
    // catalog in config/serviceCatalog keys off the same spelling.
    selector.serviceCode = String(body.serviceCode).trim().toUpperCase().slice(0, LIMITS.serviceCode);
  }

  return selector;
}

/* -------------------------------------------------------------------------- */
/* the endpoints                                                              */
/* -------------------------------------------------------------------------- */

/** POST /projects */
function validateProjectCreate(body = {}) {
  common.rejectUnknown(body, CREATE_FIELDS);
  common.requireFields(body, ['companyId', 'projectName', 'deadlineDate']);

  const { servicePlanId, specializationId, serviceCode } = validateServiceSelector(body);

  return {
    companyId: common.parseId(body.companyId, 'companyId'),
    projectName: common.str(body.projectName, 'projectName', { max: LIMITS.projectName }),
    // Creation only: a new project due today or earlier is a typo, not a plan.
    deadlineDate: validateDeadline(body.deadlineDate, 'deadlineDate', { mustBeFuture: true }),
    servicePlanId,
    specializationId,
    serviceCode,
    /*
     * The description is the one free-text field here, and it is the one place
     * common.str's control-character guard is relaxed: a note about a project
     * legitimately contains newlines, and rejecting them would make the field
     * unusable for the thing it is for. Length is still capped, and it is
     * stored and returned as text — never interpolated into anything.
     */
    description: validateDescription(body.description),
  };
}

/** PATCH /projects/:projectId — partial; send only what changed. */
function validateProjectUpdate(body = {}) {
  common.rejectUnknown(body, UPDATE_FIELDS);

  const present = UPDATE_FIELDS.filter((f) => body[f] !== undefined);
  if (!present.length) {
    throw new ApiError(400, 'Provide at least one field to update.', {
      code: 'VALIDATION_ERROR',
      details: { updatable: UPDATE_FIELDS },
    });
  }

  const out = {};

  if (body.projectName !== undefined) {
    out.projectName = common.str(body.projectName, 'projectName', { max: LIMITS.projectName });
  }
  if (body.deadlineDate !== undefined) {
    out.deadlineDate = validateDeadline(body.deadlineDate);
  }
  if (body.description !== undefined) {
    // null clears the note; the column is nullable and "I no longer want a
    // description" needs a way to be said that is not an empty string.
    out.description = body.description === null ? null : validateDescription(body.description);
  }
  if (body.status !== undefined) {
    out.status = common.enumValue(body.status, 'status', PROJECT_STATUSES);
  }
  if (body.progressBar !== undefined) {
    out.progressBar = validateProgress(body.progressBar);
  }

  /*
   * The SERVICE is absent from this list on purpose. Changing it would change
   * which specialist the project belongs to, silently reassigning work that is
   * already under way — and the assignment is stored precisely so it does not
   * move under people. A project against the wrong service is closed and
   * reopened, not edited.
   */
  return out;
}

/** GET /projects?companyId=…  and  GET /projects/services?companyId=… */
/**
 * `?companyId=&status=&assignedSpecialistUserId=` for GET /projects/options.
 *
 * No paging, no search, no sort — a dropdown that pages is a dropdown missing
 * options, and a parameter the endpoint would ignore is worse than one it
 * rejects, because the client that sent it believes it did something.
 */
function validateProjectOptionsQuery(query = {}) {
  common.rejectUnknown(query, ['companyId', 'status', 'assignedSpecialistUserId'], 'query string');

  if (query.companyId === undefined || query.companyId === null || query.companyId === '') {
    throw new ApiError(400, 'companyId is required.', {
      code: 'VALIDATION_ERROR',
      fields: { companyId: 'Select a company.' },
    });
  }

  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    status: query.status ? common.enumValue(query.status, 'status', PROJECT_STATUSES) : null,
    assignedSpecialistUserId: query.assignedSpecialistUserId
      ? common.parseId(query.assignedSpecialistUserId, 'assignedSpecialistUserId')
      : null,
  };
}

function validateProjectListQuery(query = {}) {
  const allowed = ['companyId', 'status', 'search', 'assignedSpecialistUserId', 'limit', 'offset', 'sort', 'order'];
  common.rejectUnknown(query, allowed, 'query string');

  if (query.companyId === undefined || query.companyId === null || query.companyId === '') {
    throw new ApiError(400, 'companyId is required.', {
      code: 'VALIDATION_ERROR',
      fields: { companyId: 'Select a company.' },
    });
  }

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: SORTABLE,
    defaultSort: 'deadlineDate',
  });

  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    status: query.status ? common.enumValue(query.status, 'status', PROJECT_STATUSES) : null,
    assignedSpecialistUserId: query.assignedSpecialistUserId
      ? common.parseId(query.assignedSpecialistUserId, 'assignedSpecialistUserId')
      : null,
    search: query.search ? common.str(query.search, 'search', { max: 120 }) : null,
    ...page,
    // The list is ordered soonest-deadline-first unless the caller says
    // otherwise; common.pagination defaults `order` to desc, which is the wrong
    // way round for a due date.
    order: query.order ? page.order : 'asc',
  };
}

/**
 * `?companyId=&status=&search=&assignedSpecialistUserId=&sort=&order=` for
 * GET /projects/export.
 *
 * The table's query minus `limit` and `offset`, and their absence is the point:
 * an export is the whole result set by definition, so a page window is a
 * parameter the endpoint would have to ignore — and a parameter that is ignored
 * is worse than one that is refused, because the client that sent it believes it
 * did something. The row cap that does apply lives in the service, where it can
 * refuse an oversized export by name instead of quietly trimming it.
 *
 * The filters ARE kept. The export a user wants is almost always the table they
 * are looking at, and a download that ignores the filters above it hands them
 * the wrong file.
 */
function validateProjectExportQuery(query = {}) {
  const allowed = ['companyId', 'status', 'search', 'assignedSpecialistUserId', 'sort', 'order'];
  common.rejectUnknown(query, allowed, 'query string');

  if (query.companyId === undefined || query.companyId === null || query.companyId === '') {
    throw new ApiError(400, 'companyId is required.', {
      code: 'VALIDATION_ERROR',
      fields: { companyId: 'Select a company.' },
    });
  }

  // Borrowed for its `sort`/`order` allowlist checking alone; the limit and
  // offset it also returns are discarded below.
  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: SORTABLE,
    defaultSort: 'deadlineDate',
  });

  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    status: query.status ? common.enumValue(query.status, 'status', PROJECT_STATUSES) : null,
    assignedSpecialistUserId: query.assignedSpecialistUserId
      ? common.parseId(query.assignedSpecialistUserId, 'assignedSpecialistUserId')
      : null,
    search: query.search ? common.str(query.search, 'search', { max: 120 }) : null,
    sort: page.sort,
    // Soonest deadline first unless the caller says otherwise — common.pagination
    // defaults `order` to desc, which is the wrong way round for a due date.
    order: query.order ? page.order : 'asc',
  };
}

/** Just the company id — for the form's service dropdown. */
function validateCompanyQuery(query = {}) {
  common.rejectUnknown(query, ['companyId'], 'query string');
  if (query.companyId === undefined || query.companyId === null || query.companyId === '') {
    throw new ApiError(400, 'companyId is required.', {
      code: 'VALIDATION_ERROR',
      fields: { companyId: 'Select a company.' },
    });
  }
  return { companyId: common.parseId(query.companyId, 'companyId') };
}

/**
 * A percentage for `projects.progress_bar`: 0 to 100, at most two decimals.
 *
 * Returned as a STRING, not a number, so it reaches Prisma's Decimal without
 * ever passing through a binary float — the same rule common.decimalAmount
 * follows for money. It matters less at this magnitude than it does for an
 * invoice, but "convert to double on the way to a NUMERIC column" is not a habit
 * worth having in two flavours.
 *
 * The bounds mirror the CHECK constraint in the database exactly. Enforcing them
 * here as well is not redundant: the database's answer to 150 is a raw
 * constraint-violation error the client cannot act on, and this one names the
 * field and says what is allowed.
 */
function validateProgress(value, field = 'progressBar') {
  const invalid = (detail) =>
    new ApiError(400, `${field} must be a number between 0 and 100.`, {
      code: 'VALIDATION_ERROR',
      fields: { [field]: detail },
    });

  if (typeof value !== 'number' && typeof value !== 'string') throw invalid('Enter a percentage from 0 to 100.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('Enter a percentage from 0 to 100.');

  const raw = String(value).trim();
  // Shape-checked before conversion: `Number('')` is 0 and `Number(' 40 ')` is
  // 40, so a bare Number() would accept an empty string as "nought percent".
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
    throw invalid(
      raw.includes('-') ? 'Progress cannot be negative.' : 'Use a number from 0 to 100, with at most 2 decimals.'
    );
  }

  if (Number(raw) > 100) throw invalid('Progress cannot exceed 100.');

  return raw;
}

/**
 * Free text with a length cap and the control-character guard narrowed to the
 * characters that are genuinely not text — tab, newline, and carriage return
 * are what a multi-line note is made of.
 */
function validateDescription(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw common.fieldError('description', 'description must be text.', 'Enter a valid description.');
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > LIMITS.description) {
    throw common.fieldError(
      'description',
      `description cannot exceed ${LIMITS.description} characters.`,
      `Must be at most ${LIMITS.description} characters.`
    );
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw common.fieldError(
        'description',
        'description contains invalid characters.',
        'Remove any special control characters.'
      );
    }
  }
  return text;
}

module.exports = {
  PROJECT_STATUSES,
  SORTABLE,
  LIMITS,
  validateDeadline,
  validateProgress,
  validateProjectCreate,
  validateProjectUpdate,
  validateProjectListQuery,
  validateProjectOptionsQuery,
  validateProjectExportQuery,
  validateCompanyQuery,
};
