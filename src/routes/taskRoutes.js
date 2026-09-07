'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { projectLimiter } = require('../middlewares/rateLimiter');
const {
  listCompanyTasks,
  getTask,
  createTask,
  updateTaskStatus,
  deleteTask,
} = require('../controllers/projectTaskController');

/*
 * Tasks — the pieces of work filed under a project.
 *
 *   GET    /tasks?companyId=42       -> every task on a company, across projects
 *   GET    /tasks/:taskId            -> one task
 *   POST   /tasks                    -> file one (the project's specialist only)
 *   PATCH  /tasks/:taskId/status     -> move it through TODO/ACTIVE/COMPLETED
 *   DELETE /tasks/:taskId            -> soft delete
 *
 * The per-project list lives on the project instead — GET /projects/:projectId/
 * tasks — exactly as the documents feature splits: reads that span a company are
 * top-level and take the global ?companyId= filter, reads scoped to one piece of
 * work hang off it.
 *
 * WHY CREATE IS HERE AND NOT ON /projects/:projectId/tasks. The project is named
 * in the body, because `projectId` is a field of the form the user fills in
 * rather than a place they navigated to — a task is filed FROM the task board,
 * where the project is a dropdown. `companyId` may be sent alongside it and is
 * checked against the project, never used in its place.
 *
 * WHO MAY DO WHAT — three different answers, and the service decides all three
 * against the database, because every one of them is per-record:
 *
 *   read    anyone on the company: its owner, a teammate, the accounting
 *           manager, or a specialist working the account. Same rule as projects.
 *   write   the company's OWN accounting manager, or the project's ASSIGNED
 *           specialist. Not the customer who opened the project, not a teammate,
 *           not another specialist on the same company.
 *   delete  narrower than write, mirroring projects: the company's OWN
 *           accounting manager, or whoever FILED the task. The assignee moves a
 *           task through its states; withdrawing one from the plan is the
 *           account's decision, not the person doing it.
 *
 * NO ADMIN, on any route here. Tasks are the client's working material and the
 * firm's plan for it; access follows from being on the company rather than from
 * rank, so an admin gets a 403 on every route below — the same answer the
 * project and document routes give them.
 *
 * There is no role gate for the write rule either, and that is deliberate:
 * holding ACCOUNTING_MANAGER says nothing about being the manager of THIS
 * company, and holding SPECIALIST says nothing about being the specialist on
 * THIS project. The only checks that mean anything need the company and project
 * rows, and both are in the service.
 */
const router = express.Router();

router.use(requireAuth);

// Reads carry no gate, for the same reason the project routes leave theirs
// open: the service grants read access far more broadly than any role claim
// describes, so a gate here could only get it wrong.
router.get('/', listCompanyTasks);

// Writes are rate-limited with the projects allowance — they resolve the
// project's staffing and its deadline before writing, the same shape of work.
router.post('/', projectLimiter, createTask);

/*
 * The literal route above MUST stay ahead of '/:taskId'. Express matches in
 * declaration order, and there is no literal path below that could be swallowed
 * — but keeping the parameterised ones last is what stops the next one added
 * from being.
 */
router.get('/:taskId', getTask);
router.patch('/:taskId/status', projectLimiter, updateTaskStatus);
/*
 * Soft, and with no bytes to chase — a task holds nothing but its own row. It
 * exists because a status was the only write a task had, so a mistake could only
 * be "completed", which records work as finished that was never done.
 */
router.delete('/:taskId', projectLimiter, deleteTask);

module.exports = router;
