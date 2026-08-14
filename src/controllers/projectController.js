'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const common = require('../validators/common');
const {
  validateProjectCreate,
  validateProjectUpdate,
  validateProjectListQuery,
  validateProjectOptionsQuery,
  validateCompanyQuery,
} = require('../validators/projectValidator');
const projectService = require('../services/projectService');

/**
 * HTTP layer for projects. Thin by design, like the other controllers: identity
 * from req.user (never the body), validate, delegate, wrap in the envelope.
 *
 * Note what is NOT here — no access checks, no service resolution, no
 * assignment logic. All of it is per-company and per-record, which means it can
 * only be decided against the database with the record in hand, so it lives in
 * the service where every path reaches it.
 */

/**
 * GET /projects/services?companyId=42
 *
 * The "Service" dropdown for the new-project form: the services this company is
 * actually paying for, one entry per service. The same list is embedded in
 * GET /projects, so a screen that renders the table and the form together needs
 * only that one call.
 */
const listServices = asyncHandler(async (req, res) => {
  const { companyId } = validateCompanyQuery(req.query);

  const data = await projectService.listServices({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: 'Services retrieved.',
    data,
  });
});

/**
 * GET /projects?companyId=42&status=&search=&limit=&offset=&sort=&order=
 *
 * The projects table. `companyId` is required — a project only exists in the
 * context of a company, and an unfiltered list would be a cross-tenant read.
 * The response carries the page, the paging block, and the company's service
 * list.
 */
const listProjects = asyncHandler(async (req, res) => {
  const query = validateProjectListQuery(req.query);

  const data = await projectService.listProjects({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Projects retrieved.',
    data,
  });
});

/**
 * GET /projects/options?companyId=42&status=
 *
 * The project dropdown: id and name only, unpaged, ordered by name. Same scope
 * rule as the table — whoever is on the company sees every project, a specialist
 * sees the ones they are assigned to.
 */
const listProjectOptions = asyncHandler(async (req, res) => {
  const query = validateProjectOptionsQuery(req.query);

  const data = await projectService.listProjectOptions({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Projects retrieved.',
    data,
  });
});

/** GET /projects/:projectId — one project in full. */
const getProject = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');

  const data = await projectService.getProject({
    userId: req.user.id,
    requestId: req.id,
    projectId,
  });

  return res.status(200).json({
    success: true,
    message: 'Project retrieved.',
    data,
  });
});

/**
 * POST /projects
 *
 *   { companyId, projectName, deadlineDate, specializationId }
 *
 * The service may equally be named by `servicePlanId` (the tier) or
 * `serviceCode` ("BOOKKEEPING"); exactly one of the three, and all three resolve
 * to the same plan. Neither the creator nor the assigned specialist is accepted
 * from the body: the first is the token's subject, and the second is resolved
 * from the company's staffing.
 */
const createProject = asyncHandler(async (req, res) => {
  const input = validateProjectCreate(req.body);

  const data = await projectService.createProject({
    userId: req.user.id,
    requestId: req.id,
    input,
  });

  // 201 with a Location header: the client can follow it, and a create that
  // returns the created record saves the round trip entirely.
  res.setHeader('Location', `${req.baseUrl}/${data.id}`);
  return res.status(201).json({
    success: true,
    message: 'Project created.',
    data,
  });
});

/**
 * PATCH /projects/:projectId
 *
 * Partial: send only what changed. Moving `status` is what moves the progress
 * bar — the percentage is derived from it (see dto/projectDto.progressFor).
 */
const updateProject = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const input = validateProjectUpdate(req.body);

  const data = await projectService.updateProject({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    input,
  });

  return res.status(200).json({
    success: true,
    message: 'Project updated.',
    data,
  });
});

/** DELETE /projects/:projectId — soft delete; the row survives for history. */
const deleteProject = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');

  const data = await projectService.deleteProject({
    userId: req.user.id,
    requestId: req.id,
    projectId,
  });

  return res.status(200).json({
    success: true,
    message: 'Project deleted.',
    data,
  });
});

/**
 * POST /projects/sync-specialists  { companyId }
 *
 * Re-run the auto-assignment over the company's unassigned projects. This
 * normally happens by itself whenever the company's specialists change; the
 * endpoint exists so it can be triggered deliberately — after a data fix, or by
 * a manager who wants to see it happen rather than trust that it did.
 */
const syncSpecialists = asyncHandler(async (req, res) => {
  const companyId = common.parseId(req.body?.companyId, 'companyId');

  const data = await projectService.syncSpecialists({
    userId: req.user.id,
    requestId: req.id,
    companyId,
  });

  return res.status(200).json({
    success: true,
    message: 'Specialists synced.',
    data,
  });
});

module.exports = {
  listServices,
  listProjects,
  listProjectOptions,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  syncSpecialists,
};
