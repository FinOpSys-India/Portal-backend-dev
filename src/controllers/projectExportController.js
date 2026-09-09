'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const common = require('../validators/common');
const { validateProjectExportQuery } = require('../validators/projectValidator');
const projectExportService = require('../services/projectExportService');
const csv = require('../utils/csv');

/**
 * HTTP layer for the two CSV exports. Thin like every other controller here —
 * identity from req.user, validate, delegate — with one difference that is worth
 * naming because it is the only place in the API where it happens:
 *
 * THESE TWO ROUTES DO NOT RETURN THE ENVELOPE. Every other endpoint answers with
 * `{ success, message, data }`; a CSV cannot, because the response body IS the
 * file the browser saves. Wrapping it would produce a download containing JSON
 * containing a string containing the spreadsheet.
 *
 * The envelope still applies to FAILURES. A 400 or a 404 here goes through the
 * shared error handler and comes back as JSON exactly as it does everywhere
 * else, which is what a client needs — an error is something to display, not
 * something to save to disk. The Content-Type only becomes text/csv on the path
 * that actually succeeded, since csv.sendCsv sets the headers and the body
 * together at the end.
 */

/**
 * GET /projects/export?companyId=42&status=&search=&assignedSpecialistUserId=&sort=&order=
 *
 * The projects table as a file: one row per project, no pagination, the same
 * filters and the same access scope the table itself applies.
 */
const exportProjects = asyncHandler(async (req, res) => {
  const query = validateProjectExportQuery(req.query);

  const file = await projectExportService.exportProjects({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return csv.sendCsv(res, file);
});

/**
 * GET /projects/:projectId/export
 *
 * One project with its task list: one row per task, the project's own columns
 * repeated down the left so the file sorts, filters and concatenates like data
 * rather than like a report.
 */
const exportProject = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');

  const file = await projectExportService.exportProject({
    userId: req.user.id,
    requestId: req.id,
    projectId,
  });

  return csv.sendCsv(res, file);
});

module.exports = {
  exportProjects,
  exportProject,
};
