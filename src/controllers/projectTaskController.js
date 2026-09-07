'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const common = require('../validators/common');
const {
  validateTaskCreate,
  validateTaskStatusUpdate,
  validateCompanyTaskListQuery,
  validateProjectTaskListQuery,
} = require('../validators/projectTaskValidator');
const taskService = require('../services/projectTaskService');

/**
 * HTTP layer for project tasks. Thin, like the other controllers: identity from
 * req.user (never the body), validate, delegate, wrap in the envelope.
 *
 * No access checks here. Who may file a task — the project's assigned
 * specialist, and only them — can only be decided with the project row in hand,
 * so it lives in the service where every path reaches it.
 */

/**
 * GET /tasks?companyId=42&projectId=&status=&specialistUserId=&search=&limit=&offset=&sort=&order=
 *
 * Every task on a company, across its projects. `companyId` is required — a
 * merged list would put two clients' work on one screen.
 */
const listCompanyTasks = asyncHandler(async (req, res) => {
  const query = validateCompanyTaskListQuery(req.query);

  const data = await taskService.listCompanyTasks({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Tasks retrieved.',
    data,
  });
});

/**
 * GET /projects/:projectId/tasks?status=&specialistUserId=&search=&limit=&offset=&sort=&order=
 *
 * One project's tasks. The project id comes from the path, so it is not a
 * filter the caller can drop.
 */
const listProjectTasks = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const query = validateProjectTaskListQuery(req.query);

  const data = await taskService.listProjectTasks({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Tasks retrieved.',
    data,
  });
});

/** GET /tasks/:taskId — one task in full. */
const getTask = asyncHandler(async (req, res) => {
  const taskId = common.parseId(req.params.taskId, 'taskId');

  const data = await taskService.getTask({
    userId: req.user.id,
    requestId: req.id,
    taskId,
  });

  return res.status(200).json({
    success: true,
    message: 'Task retrieved.',
    data,
  });
});

/**
 * POST /tasks
 *
 *   { projectId, taskName, description, deadlineDate, companyId?, status? }
 *
 * `companyId` is optional and is checked against the project rather than used —
 * a task's company is its project's. Neither the creator nor the specialist is
 * accepted: the first is the token's subject, the second is copied from the
 * project's assignment.
 */
const createTask = asyncHandler(async (req, res) => {
  const input = validateTaskCreate(req.body);

  const data = await taskService.createTask({
    userId: req.user.id,
    requestId: req.id,
    input,
  });

  // 201 with a Location header, matching POST /projects: the client can follow
  // it, and returning the created record saves the round trip entirely.
  res.setHeader('Location', `${req.baseUrl}/${data.id}`);
  return res.status(201).json({
    success: true,
    message: 'Task created.',
    data,
  });
});

/** PATCH /tasks/:taskId/status  { status } — move a task through its states. */
const updateTaskStatus = asyncHandler(async (req, res) => {
  const taskId = common.parseId(req.params.taskId, 'taskId');
  const input = validateTaskStatusUpdate(req.body);

  const data = await taskService.updateTaskStatus({
    userId: req.user.id,
    requestId: req.id,
    taskId,
    input,
  });

  return res.status(200).json({
    success: true,
    message: 'Task status updated.',
    data,
  });
});

/** DELETE /tasks/:taskId — withdraw a task from the plan. Soft; see the service. */
const deleteTask = asyncHandler(async (req, res) => {
  const taskId = common.parseId(req.params.taskId, 'taskId');

  const data = await taskService.deleteTask({
    userId: req.user.id,
    requestId: req.id,
    taskId,
  });

  return res.status(200).json({
    success: true,
    message: 'Task deleted.',
    data,
  });
});

module.exports = {
  listCompanyTasks,
  listProjectTasks,
  getTask,
  createTask,
  updateTaskStatus,
  deleteTask,
};
