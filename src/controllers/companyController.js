'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validateCompanyOnboarding,
  validateAccountingManagerAssignment,
  validateSpecialistAssignment,
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
  return res.status(200).json({ success: true, data: team });
});

/**
 * GET /companies/:companyId/specialists
 */
const listSpecialists = asyncHandler(async (req, res) => {
  const companyId = parseId(req.params.companyId, 'companyId');
  const data = await companyService.listSpecialists({ userId: req.user.id, companyId });
  return res.status(200).json({ success: true, data });
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
  assignAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
};
