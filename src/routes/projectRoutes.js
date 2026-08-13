'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { projectLimiter, documentLimiter } = require('../middlewares/rateLimiter');
const {
  listServices,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  syncSpecialists,
} = require('../controllers/projectController');
const {
  requestUploadUrls,
  confirmUploads,
  listDocuments,
  downloadDocument,
  requestDownloadLinks,
  deleteDocument,
} = require('../controllers/projectDocumentController');
const { listProjectTasks } = require('../controllers/projectTaskController');

/*
 * Projects: a unit of work opened against one company, for one service it pays
 * for, with a deadline and an auto-assigned specialist.
 *
 *   GET    /projects/services?companyId=42   -> the form's service dropdown
 *   GET    /projects?companyId=42            -> the table + that same service list
 *   POST   /projects                         -> open one (manager or customer)
 *   POST   /projects/sync-specialists        -> re-run the auto-assignment
 *   GET    /projects/:projectId              -> one project
 *   PATCH  /projects/:projectId              -> name / deadline / note / status
 *   DELETE /projects/:projectId              -> soft delete
 *
 * WHO MAY DO WHAT — three different answers, and the service decides all three
 * against the company, because every one of them is per-record:
 *
 *   read     the owner, a teammate, the company's accounting manager, or a
 *            specialist working the account.
 *   create   the company's OWN accounting manager, or a customer on the account.
 *   write    the company's manager, the creator, or the assigned specialist
 *            (who must be able to move the status of their own work).
 *
 * AN ADMIN IS ON NONE OF THOSE LISTS. Projects and their documents are the
 * client's own working material, and access follows from being on the company,
 * not from rank — so an admin gets a 403 on every route below except
 * /sync-specialists, which is a staffing action and reports counts, not content.
 *
 * The gate below is only the coarse claim filter — it can tell that a caller
 * holds ACCOUNTING_MANAGER at all, never that they hold it for THIS company.
 * That second half is the one that decides, and it is in the service.
 *
 * READ routes carry no gate at all, for the same reason companiesRoutes leaves
 * its reads open: the service grants read access far more broadly than any role
 * claim describes, so a gate here could only get it wrong.
 */
const router = express.Router();

router.use(requireAuth);

// A customer is either the account's OWNER or a teammate on it; both carry the
// CUSTOMER role, and which of the two they are is settled in the service.
const createRoles = requireRole('ACCOUNTING_MANAGER', 'CUSTOMER');
// Re-running the assignment is a staffing action, so it is the manager's (with
// an admin able to oversee it) — never the customer's.
const staffingRoles = requireRole('ACCOUNTING_MANAGER', 'ADMIN');

/*
 * Both literal paths MUST stay above '/:projectId'. Express matches in
 * declaration order, so a parameterised route declared first would swallow
 * "services" and try to parse it as an id — a 400 on a perfectly valid URL.
 */
router.get('/services', listServices);
router.get('/', listProjects);

router.post('/', projectLimiter, createRoles, createProject);
router.post('/sync-specialists', projectLimiter, staffingRoles, syncSpecialists);

router.get('/:projectId', getProject);
router.patch('/:projectId', projectLimiter, updateProject);
router.delete('/:projectId', projectLimiter, deleteProject);

/*
 * Documents attached to a project.
 *
 *   GET    /projects/42/documents                 -> the attachments panel
 *   POST   /projects/42/documents/upload-url      -> where to send the files
 *   POST   /projects/42/documents/confirm         -> record what was sent
 *   GET    /projects/42/documents/7/download      -> one file
 *   POST   /projects/42/documents/links           -> several, as direct links
 *   DELETE /projects/42/documents/7               -> soft delete
 *
 * NO FILE PASSES THROUGH THIS API, in either direction, and that is the single
 * fact the whole shape follows from. A serverless host buffers every request and
 * response whole and refuses anything past a few megabytes, so a route that
 * carries bytes has a ceiling nothing in this application can raise. These
 * routes carry only JSON: permission out, and a note of what happened back.
 *
 * Uploading is therefore two calls rather than one — ask, PUT to the bucket,
 * confirm — because the API never sees the file and has to be told it arrived.
 * Downloading is one, because the object already exists and a link to it is all
 * the browser needs. Neither is bounded by size.
 *
 * NO ROLE GATE, for the same reason the read routes above carry none: who may
 * touch a project's files is decided per-record against the company, and a role
 * claim can only say what KIND of actor the caller is. A customer, a specialist,
 * an accounting manager and an admin can all legitimately be on this route; what
 * separates them from everyone else is being on the company, which only the
 * service can see. See projectDocumentService for the three-layer rule.
 *
 * These sit below '/:projectId' only for readability — they cannot collide with
 * it, since Express matches the whole path and these carry extra segments.
 */
router.get('/:projectId/documents', listDocuments);
/*
 * The upload pair, both rate-limited as uploads because that is what they are —
 * the fact that the bytes go elsewhere does not make issuing write capabilities
 * a read.
 *
 * Both sit ABOVE '/:projectId/documents/:documentId', so "upload-url" and
 * "confirm" can never be parsed as a document id.
 */
router.post('/:projectId/documents/upload-url', documentLimiter, requestUploadUrls);
router.post('/:projectId/documents/confirm', documentLimiter, confirmUploads);
router.get('/:projectId/documents/:documentId/download', downloadDocument);
/*
 * The bulk download is a POST because its id list belongs in a body — fifty ids
 * in a query string is a URL long enough for a proxy to truncate, and a
 * truncated list would silently download the wrong subset.
 *
 * It returns LINKS rather than an archive, and that is the whole design. Building
 * a zip means this function fetching every file and holding the result in memory,
 * which puts the entire selection inside the host's response ceiling — a few
 * megabytes, for a feature whose purpose is "give me everything". Signed links
 * point the browser at the bucket instead, so the selection can be any size, and
 * a client that wants a single archive builds it where the bytes already are.
 *
 * Rate-limited like an upload rather than like a read: it reads no bytes, but it
 * mints one capability per document, which is not something to leave unthrottled.
 *
 * It sits ABOVE '/:projectId/documents/:documentId' so "links" is never parsed as
 * a document id.
 */
router.post('/:projectId/documents/links', documentLimiter, requestDownloadLinks);
router.delete('/:projectId/documents/:documentId', projectLimiter, deleteDocument);

/*
 * One project's tasks.
 *
 *   GET /projects/42/tasks?status=&specialistUserId=&search=&limit=&offset=
 *
 * The read half of the tasks feature that is scoped to a single project; the
 * company-wide list and every write live on /tasks (see routes/taskRoutes).
 * Split the same way the documents feature is, and for the same reason: a read
 * that spans a company is top-level and takes the global ?companyId= filter,
 * a read scoped to one piece of work hangs off it.
 *
 * No role gate, matching every other read here — the service applies the project
 * read rule, which is wider than any role claim can describe.
 */
router.get('/:projectId/tasks', listProjectTasks);

module.exports = router;
