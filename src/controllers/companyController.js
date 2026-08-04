'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validateCompanyOnboarding,
  validateCompanyUpdate,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
  validateCompanyListQuery,
  validateUserListQuery,
  validateSpecialistListQuery,
  parseId,
} = require('../validators/companyValidator');
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
  assignAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
};
