'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { projectLimiter, documentLimiter } = require('../middlewares/rateLimiter');
const { parseDocumentUpload } = require('../middlewares/uploadDocuments');
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
  uploadDocuments,
  listDocuments,
  downloadDocument,
  deleteDocument,
} = require('../controllers/projectDocumentController');

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
 *   POST   /projects/42/documents                 -> multipart, field "documents"
 *   GET    /projects/42/documents/7/download      -> the bytes
 *   DELETE /projects/42/documents/7               -> soft delete
 *
 * NO ROLE GATE, for the same reason the read routes above carry none: who may
 * touch a project's files is decided per-record against the company, and a role
 * claim can only say what KIND of actor the caller is. A customer, a specialist,
 * an accounting manager and an admin can all legitimately be on this route; what
 * separates them from everyone else is being on the company, which only the
 * service can see. See projectDocumentService for the three-layer rule.
 *
 * ORDER OF THE UPLOAD MIDDLEWARE MATTERS. `documentLimiter` runs first so a
 * throttled client is refused before the parser writes anything; the parser runs
 * second because a multipart body cannot be authorized until it has been read,
 * and the service removes the files again on every failure path.
 *
 * These sit below '/:projectId' only for readability — they cannot collide with
 * it, since Express matches the whole path and these carry extra segments.
 */
router.get('/:projectId/documents', listDocuments);
router.post('/:projectId/documents', documentLimiter, parseDocumentUpload, uploadDocuments);
router.get('/:projectId/documents/:documentId/download', downloadDocument);
router.delete('/:projectId/documents/:documentId', projectLimiter, deleteDocument);

module.exports = router;
