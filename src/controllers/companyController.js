'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validateCompanyOnboarding,
  validateCompanyUpdate,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
  validateSpecialistAssignments,
  validateCompanyListQuery,
  validateUserListQuery,
  validateAccountingManagerListQuery,
  validateScopedDirectoryQuery,
  validateSpecialistDetailQuery,
  validateCustomerDetailQuery,
  validateTeammateListQuery,
  validateSpecialistListQuery,
  parseId,
} = require('../validators/companyValidator');
const { rejectUnknown } = require('../validators/common');
const companyService = require('../services/companyService');

/**
 * HTTP layer for the company flows. Controllers are deliberately thin: they read
 * the caller identity from req.user (set by requireAuth — never from the body),
 * validate/sanitize input, delegate to the service, and shape the HTTP response.
 * All error translation happens in the central error handler.
 */

/**
 * POST /onboarding/company
 *
 * Onboard a new company owned by the authenticated user. Supports an optional
 * `Idempotency-Key` header: retrying the same request replays the original
 * response instead of creating a duplicate.
 */
const onboardCompany = asyncHandler(async (req, res) => {
  const input = validateCompanyOnboarding(req.body);
  const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);

  const { statusCode, body, idempotent } = await companyService.onboardCompany({
    userId: req.user.id,
    requestId: req.id,
    idempotencyKey,
    input,
  });

  if (idempotent) res.setHeader('Idempotent-Replay', 'true');
  return res.status(statusCode).json(body);
});

/**
 * GET /companies
 *
 * Every live company the caller can reach — owned, managed, or served as a
 * specialist. This is how the frontend rediscovers a `companyId` after a
 * refresh; nothing else returns one except the call that created it.
 */
const listCompanies = asyncHandler(async (req, res) => {
  const query = validateCompanyListQuery(req.query);

  const { companies, total } = await companyService.listCompanies({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Companies retrieved.',
    data: {
      companies,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + companies.length < total,
        sort: query.sort,
        order: query.order,
      },
    },
  });
});

/** GET /companies/:companyId */
const getCompany = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const company = await companyService.getCompany({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: 'Company retrieved.',
    data: { company },
  });
});

/** PATCH /companies/:companyId */
const updateCompany = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const input = validateCompanyUpdate(req.body);

  const company = await companyService.updateCompany({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    input,
  });

  return res.status(200).json({
    success: true,
    message: 'Company updated.',
    data: { company },
  });
});

/** DELETE /companies/:companyId — soft delete (archive). */
const deleteCompany = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');

  const { company } = await companyService.deleteCompany({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: 'Company archived.',
    data: { company },
  });
});

/**
 * GET /users
 *
 * The directory behind the assignment pickers. Assigning an accounting manager
 * or a specialist requires a userId, and nothing else exposes one.
 */
const listUsers = asyncHandler(async (req, res) => {
  const query = validateUserListQuery(req.query);

  const { users, total } = await companyService.listUsers({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Users retrieved.',
    data: {
      users,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + users.length < total,
        sort: query.sort,
        order: query.order,
      },
    },
  });
});

/**
 * PUT /companies/:companyId/accounting-manager
 *
 * Assign or replace the company's single accounting manager.
 */
const assignAccountingManager = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const { accountingManagerUserId } = validateAccountingManagerAssignment(req.body);

  const { company } = await companyService.assignAccountingManager({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    managerUserId: accountingManagerUserId,
  });

  return res.status(200).json({
    success: true,
    message: 'Accounting manager assigned.',
    data: { company },
  });
});

/**
 * DELETE /companies/:companyId/accounting-manager
 *
 * Leave the company with no accounting manager. Idempotent.
 */
const removeAccountingManager = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');

  const { company, alreadyRemoved } = await companyService.removeAccountingManager({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: alreadyRemoved
      ? 'This company had no accounting manager.'
      : 'Accounting manager removed.',
    data: { company },
  });
});

/**
 * GET /admin/company-accounts
 *
 * The admin company-account management screen in one call: the companies, each
 * with its current accounting manager, plus the eligible managers ONCE rather
 * than repeated on every row.
 */
const listCompanyAccounts = asyncHandler(async (req, res) => {
  const query = validateCompanyListQuery(req.query);

  const { companies, accountingManagers, total } = await companyService.listCompanyAccounts({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Company accounts retrieved.',
    data: {
      companies,
      accountingManagers,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + companies.length < total,
        sort: query.sort,
        order: query.order,
      },
    },
  });
});

/**
 * GET /admin/accounting-managers
 *
 * The staffing report: every accounting manager with their name, email, and the
 * companies on their book. One row per manager, the companies nested inside it.
 */
const listAccountingManagers = asyncHandler(async (req, res) => {
  const query = validateAccountingManagerListQuery(req.query);

  const { accountingManagers, total } = await companyService.listAccountingManagers({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Accounting managers retrieved.',
    data: {
      accountingManagers,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        // `total` counts MANAGERS, and so does the page — the companies nested
        // inside each row are not paginated (a manager holds a handful, and
        // splitting one manager's book across pages would be meaningless).
        hasMore: query.offset + accountingManagers.length < total,
        sort: query.sort,
        order: query.order,
      },
    },
  });
});

/**
 * GET /specialists
 *
 * The specialist directory: name, service speciality, email — every specialist
 * for an admin, and for everyone else only those working on companies the caller
 * can reach. `?companyId=` applies the global company filter.
 */
const listSpecialistDirectory = asyncHandler(async (req, res) => {
  const query = validateScopedDirectoryQuery(req.query);

  const { specialists, total } = await companyService.listSpecialistDirectory({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialists retrieved.',
    data: {
      specialists,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + specialists.length < total,
        sort: query.sort,
        order: query.order,
      },
      // Echo the applied filter so a client can tell a deliberately narrowed
      // view from an empty one.
      filters: { companyId: query.companyId, search: query.search, includeInactive: query.includeInactive },
    },
  });
});

/**
 * GET /specialists/:userId
 *
 * The profile behind a clicked directory row: the person, their contact detail
 * and address, the companies and specialities they hold, and the per-status
 * counters for their tasks on the named company. The task TABLE stays at
 * GET /tasks?companyId=&specialistUserId=, which pages and filters.
 */
const getSpecialistDetail = asyncHandler(async (req, res) => {
  const specialistUserId = parseId(req.params.userId, 'userId');
  const query = validateSpecialistDetailQuery(req.query);

  const specialist = await companyService.getSpecialistDetail({
    userId: req.user.id,
    requestId: req.id,
    specialistUserId,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialist retrieved.',
    data: {
      specialist,
      // Echo the scope, so a client can tell an admin's unscoped profile from a
      // manager's view of the same person on one account.
      filters: { companyId: query.companyId },
    },
  });
});

/**
 * GET /companies/owned
 *
 * The live companies the caller owns — the company picker on the teammate form.
 * Unpaginated on purpose; see the service.
 */
const listOwnedCompanies = asyncHandler(async (req, res) => {
  // No query string is accepted, so an unexpected one is rejected rather than
  // silently ignored — a client filtering against this endpoint should find out
  // that it does not filter.
  rejectUnknown(req.query, [], 'query string');

  const { companies, total } = await companyService.listOwnedCompanies({
    userId: req.user.id,
    requestId: req.id,
  });

  return res.status(200).json({
    success: true,
    message: 'Owned companies retrieved.',
    data: { companies, total },
  });
});

/**
 * GET /teammates?companyId=
 *
 * The customer-side people on one company: name, email, job title, specific role
 * and when they joined this company. `companyId` is the global company filter and
 * is required — see the validator.
 */
const listTeammates = asyncHandler(async (req, res) => {
  const query = validateTeammateListQuery(req.query);

  const { teammates, total, companyId } = await companyService.listTeammates({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Teammates retrieved.',
    data: {
      companyId,
      teammates,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + teammates.length < total,
        sort: query.sort,
        order: query.order,
      },
      // Echoed so a client can tell a deliberately narrowed view from an empty
      // one — the same reason the other directory endpoints do it.
      filters: {
        companyId,
        search: query.search,
        specificRole: query.specificRole,
        includeInactive: query.includeInactive,
      },
    },
  });
});

/**
 * GET /customers
 *
 * The customer directory: name, email, specific role (Owner / Team), and the
 * companies they are attached to. Every customer user for an admin; for everyone
 * else the customer users of one company, named with `?companyId=`.
 */
const listCustomerDirectory = asyncHandler(async (req, res) => {
  const query = validateScopedDirectoryQuery(req.query);

  const { customers, total } = await companyService.listCustomerDirectory({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Customers retrieved.',
    data: {
      customers,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + customers.length < total,
        sort: query.sort,
        order: query.order,
      },
      filters: { companyId: query.companyId, search: query.search, includeInactive: query.includeInactive },
    },
  });
});

/**
 * GET \customers:userId
 *
 * The profile behind a clicked customer row: the person, their contact detail
 * and their own address. No companies and no nested tables — this screen is the
 * human being, and the account already has its own.
 */
const getCustomerDetail = asyncHandler(async (req, res) => {
  const customerUserId = parseId(req.params.userId, 'userId');
  const query = validateCustomerDetailQuery(req.query);

  const customer = await companyService.getCustomerDetail({
    userId: req.user.id,
    requestId: req.id,
    customerUserId,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Customer retrieved.',
    data: {
      customer,
      // Echoed for the same reason the directories echo it: the company the
      // profile was read through is part of the answer, not just the request.
      filters: { companyId: query.companyId },
    },
  });
});

/**
 * GET /accounting-manager/companies
 *
 * The accounting manager's working view of the accounts they are responsible
 * for: each company with its priced service plans, billing period, and members.
 * Richer than the admin table, which answers a different question.
 */
const listManagedCompanies = asyncHandler(async (req, res) => {
  const query = validateCompanyListQuery(req.query);

  const { companies, total } = await companyService.listManagedCompanies({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Managed companies retrieved.',
    data: {
      companies,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + companies.length < total,
        sort: query.sort,
        order: query.order,
      },
    },
  });
});

/**
 * GET /admin/companies/:companyId/specialist-options
 *
 * Called when an admin opens a company row. Returns one entry per ACTIVE
 * service, each with the specialist role it requires, who is already assigned,
 * and its own list of eligible specialists — so the dropdowns are generated
 * entirely from this response.
 */
const getSpecialistOptions = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');

  const data = await companyService.getSpecialistOptions({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialist options retrieved.',
    data,
  });
});

/**
 * PUT /admin/companies/:companyId/specialists
 *
 * Set the company's specialist team: one specialist per active service, all
 * submitted together and saved in one transaction.
 */
const setCompanySpecialists = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const assignments = validateSpecialistAssignments(req.body);

  const data = await companyService.setCompanySpecialists({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    assignments,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialists assigned.',
    data,
  });
});

/**
 * POST /companies/:companyId/specialists
 *
 * Assign a specialist to the company for one or more specializations.
 */
const assignSpecialists = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const { specialistUserId, specializationCodes } = validateSpecialistAssignment(req.body);

  const { statusCode, created, skipped } = await companyService.assignSpecialists({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    specialistUserId,
    specializationCodes,
  });

  return res.status(statusCode).json({
    success: true,
    message: created.length ? 'Specialist assigned.' : 'No new assignments (all already active).',
    data: { assignments: created, skipped },
  });
});

/**
 * GET /companies/:companyId/team
 */
const getTeam = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const team = await companyService.getTeam({ userId: req.user.id, companyId });
  return res.status(200).json({ success: true, message: 'Team retrieved.', data: team });
});

/**
 * GET /companies/:companyId/specialists
 */
const listSpecialists = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const query = validateSpecialistListQuery(req.query);

  const data = await companyService.listSpecialists({ userId: req.user.id, companyId, query });
  return res.status(200).json({ success: true, message: 'Specialists retrieved.', data });
});

/**
 * DELETE /companies/:companyId/specialists/:assignmentId
 */
const removeSpecialist = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const assignmentId = parseId(req.params.assignmentId, 'assignmentId');

  const { assignment, alreadyRemoved } = await companyService.removeSpecialist({
    userId: req.user.id,
    requestId: req.id,
    companyId,
    assignmentId,
  });

  return res.status(200).json({
    success: true,
    message: alreadyRemoved ? 'Assignment was already removed.' : 'Specialist removed.',
    data: { assignment },
  });
});

/**
 * The Idempotency-Key header may arrive as a string or (for a repeated header) an
 * array. Reduce it to a single trimmed string, or null when absent/blank.
 */
function normalizeIdempotencyKey(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 255);
  return trimmed || null;
}

module.exports = {
  onboardCompany,
  listCompanies,
  getCompany,
  updateCompany,
  deleteCompany,
  listUsers,
  listCompanyAccounts,
  listAccountingManagers,
  listSpecialistDirectory,
  getSpecialistDetail,
  listCustomerDirectory,
  getCustomerDetail,
  listOwnedCompanies,
  listTeammates,
  listManagedCompanies,
  getSpecialistOptions,
  setCompanySpecialists,
  assignAccountingManager,
  removeAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
};
