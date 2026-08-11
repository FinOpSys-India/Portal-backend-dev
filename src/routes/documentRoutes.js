'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listCompanyDocuments } = require('../controllers/projectDocumentController');

/*
 * The company-wide document list.
 *
 *   GET /documents?companyId=&projectId=&search=&limit=&offset=&sort=&order=
 *
 * A top-level route taking the global `companyId` filter, exactly like
 * GET /teammates, GET /specialists and GET /customers — the frontend carries one
 * selected company across every screen, and a path parameter would make this the
 * one place that reads it from somewhere else.
 *
 * WHY IT EXISTS. Documents were reachable only through the project that owns
 * them, so "everything this client has sent us" took one request per project:
 * forty projects, forty-one calls, to render a single screen. This answers it in
 * two queries regardless of size.
 *
 * WRITES DELIBERATELY DO NOT LIVE HERE. Uploading, downloading and deleting all
 * stay on /projects/:projectId/documents, because a file belongs to a piece of
 * work and there is no such thing as a document attached to a company at large.
 * This route only reads across them.
 *
 * `companyId` is REQUIRED, with no admin exemption: a merged list would put two
 * clients' files on one screen. Scope, not a role gate — any authenticated
 * caller may ask, and the service decides against the database whether they may
 * read THAT company (its owner, an ADMIN, its accounting manager, or a
 * specialist assigned to it), which is the same rule the project routes apply.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listCompanyDocuments);

module.exports = router;
