'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const config = require('../config');
const common = require('../validators/common');
const {
  validateDocumentListQuery,
  validateCompanyDocumentListQuery,
  validateDocumentArchiveRequest,
  validateUploadTicketRequest,
  validateUploadConfirmRequest,
} = require('../validators/projectDocumentValidator');
const { isAllowedMimeType, ACCEPTED_LABEL } = require('../utils/documentTypes');
const documentService = require('../services/projectDocumentService');

/**
 * HTTP layer for project documents. Thin, like the other controllers: identity
 * from req.user, ids from the URL, validate, delegate, wrap in the envelope.
 *
 * The download handler is the one exception to "wrap in the envelope", and
 * deliberately so — its body is a file. Everything else about it (who may call
 * it, which file it resolves to) is decided in the service exactly like the JSON
 * routes.
 */

/**
 * POST /projects/:projectId/documents/upload-url
 *
 *   { companyId, files: [{ fileName, mimeType, sizeBytes }] }
 *
 * Step one of the direct upload: the browser says what it is about to send, and
 * gets back one signed URL per file to PUT it to. Nothing is recorded — see
 * projectDocumentService.createUploadTickets for what this call does and does
 * not decide.
 *
 * 201 rather than 200: the response is a set of newly minted, one-shot
 * capabilities that did not exist before the request.
 */
const requestUploadUrls = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const { companyId, files } = validateUploadTicketRequest(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
    maxBytes: config.uploads.maxDocumentBytes,
    isAllowedMimeType,
    acceptedLabel: ACCEPTED_LABEL,
  });

  const data = await documentService.createUploadTickets({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    companyId,
    files,
  });

  return res.status(201).json({
    success: true,
    message: data.uploads.length === 1 ? 'Upload ready.' : `${data.uploads.length} uploads ready.`,
    data,
  });
});

/**
 * POST /projects/:projectId/documents/confirm
 *
 *   { companyId, files: [{ key, fileName }] }
 *
 * Step three: the files are in the bucket, so record them. This is the call that
 * makes a document exist — until it returns, the bytes are stored and nothing in
 * the application knows about them.
 */
const confirmUploads = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const { companyId, files } = validateUploadConfirmRequest(req.body, {
    maxFiles: config.uploads.maxDocumentsPerRequest,
  });

  const data = await documentService.confirmUploads({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    companyId,
    files,
  });

  return res.status(201).json({
    success: true,
    message: data.uploaded === 1 ? 'Document uploaded.' : `${data.uploaded} documents uploaded.`,
    data,
  });
});

/**
 * GET /projects/:projectId/documents?search=&limit=&offset=&sort=&order=
 *
 * The attachments panel: the page, the paging block, and the project's totals.
 */
const listDocuments = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const query = validateDocumentListQuery(req.query);

  const data = await documentService.listDocuments({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Documents retrieved.',
    data,
  });
});

/**
 * GET /documents?companyId=&projectId=&search=&limit=&offset=&sort=&order=
 *
 * Every file on a company, across its projects — the same page/totals/paging
 * shape as the per-project panel, with the project named on each row.
 */
const listCompanyDocuments = asyncHandler(async (req, res) => {
  const query = validateCompanyDocumentListQuery(req.query);

  const data = await documentService.listCompanyDocuments({
    userId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Documents retrieved.',
    data,
  });
});

/**
 * GET /projects/:projectId/documents/:documentId/download
 *
 * The bytes. This route is why the files are stored outside the statically
 * served folder: it is the only way to read one, and it authorizes the caller
 * against the project's company first.
 *
 * THE HEADERS ARE THE SECURITY BOUNDARY here, since the content is user-supplied
 * and served from our own origin:
 *
 *   Content-Disposition: attachment   the browser saves it instead of rendering
 *                                     it, so an HTML-ish file cannot execute
 *                                     against this origin.
 *   X-Content-Type-Options: nosniff   the declared type is the type — no sniffing
 *                                     a "text/plain" upload into script.
 *   Cache-Control: private, no-store  a client's bank statement must not sit in
 *                                     a shared proxy or on disk after logout.
 *                                     The opposite of the avatar policy, and for
 *                                     the opposite reason.
 */
const downloadDocument = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const documentId = common.parseId(req.params.documentId, 'documentId');

  const file = await documentService.getDocumentForDownload({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    documentId,
  });

  /*
   * A REDIRECT rather than the bytes, whenever the service could mint a signed
   * link for the object (i.e. under the supabase driver — see storage.signedUrl).
   *
   * The route's contract is unchanged from the caller's side: the same URL, the
   * same auth, and a browser following the redirect still ends up saving the same
   * file under the same name, because the signed link carries its own
   * `Content-Disposition: attachment; filename=...`. What changes is that the
   * bytes travel from the bucket to the browser instead of through this function,
   * which is the only way a file larger than the host's response ceiling can be
   * downloaded at all.
   *
   * `no-store` on the redirect ITSELF matters as much as it did on the file. The
   * 302 carries a working, if short-lived, capability in its Location header, and
   * a cached redirect would hand that link to whoever opened the page next.
   */
  if (file.url) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(302, file.url);
  }

  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(file.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', file.sizeBytes);

  // The buffer, not a path: the bytes come from the documents bucket, which has
  // no filesystem for `sendFile` to read. `res.send` on a Buffer writes it as-is
  // and does not touch the Content-Type already set above.
  return res.send(file.body);
});

/**
 * POST /projects/:projectId/documents/links
 *
 *   { }                      links for every document on the project
 *   { documentIds: [5, 6] }  links for the ones the user ticked
 *
 * The bulk download, answered as JSON: one short-lived signed URL per document,
 * which the browser fetches directly (and may assemble into a single archive
 * itself). Nothing about this response grows with the size of the files, which is
 * exactly why it replaced the zip this endpoint used to return — an archive built
 * here had to be held in memory and sent back through the host, capping "download
 * everything" at a few megabytes.
 *
 * `no-store`, because the body is a list of working capabilities — the same
 * reason the single download's redirect carries it.
 */
const requestDownloadLinks = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const { documentIds } = validateDocumentArchiveRequest(req.body, {
    maxDocuments: config.uploads.maxArchiveDocuments,
  });

  const data = await documentService.createDownloadLinks({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    documentIds,
  });

  res.setHeader('Cache-Control', 'private, no-store');

  return res.status(200).json({
    success: true,
    message: data.count === 1 ? 'Download link ready.' : `${data.count} download links ready.`,
    data,
  });
});

/**
 * `Content-Disposition` for a filename that may be anything a person typed.
 *
 * Two forms, per RFC 6266: a plain `filename` that only ever contains ASCII
 * letters, digits and a few punctuation marks (older clients read this one), and
 * a percent-encoded `filename*` carrying the real name (everything current reads
 * this one). Sending only the first would turn "Bilan_2024_société.pdf" into
 * something unrecognisable; sending only the second loses the name entirely on
 * anything old.
 *
 * The ASCII form is built by REPLACEMENT rather than by quoting, so no quote or
 * backslash from the name can terminate the header value early.
 */
function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\w.\- ]/g, '_') || 'document';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** DELETE /projects/:projectId/documents/:documentId — soft delete. */
const deleteDocument = asyncHandler(async (req, res) => {
  const projectId = common.parseId(req.params.projectId, 'projectId');
  const documentId = common.parseId(req.params.documentId, 'documentId');

  const data = await documentService.deleteDocument({
    userId: req.user.id,
    requestId: req.id,
    projectId,
    documentId,
  });

  return res.status(200).json({
    success: true,
    message: 'Document deleted.',
    data,
  });
});

module.exports = {
  requestUploadUrls,
  confirmUploads,
  listDocuments,
  listCompanyDocuments,
  downloadDocument,
  requestDownloadLinks,
  deleteDocument,
};
