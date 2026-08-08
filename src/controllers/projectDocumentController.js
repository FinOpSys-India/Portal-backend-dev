'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const common = require('../validators/common');
const {
  validateDocumentUpload,
  validateDocumentListQuery,
} = require('../validators/projectDocumentValidator');
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
 * POST /projects/:projectId/documents
 *
 * multipart/form-data:
 *   companyId   the company the project belongs to — checked against it
 *   documents   one or more files (field name repeated per file)
 *
 * The uploader is the token's subject, and each file's name, type, and size are
 * measured from the upload itself. Neither is accepted from the body.
 */
const uploadDocuments = asyncHandler(async (req, res) => {
  /*
   * The files are already on disk — parseDocumentUpload wrote them, because a
   * multipart body has to be read before anything about it can be judged. So
   * this handler owns their removal on every path that does not end in a 201:
   * a malformed companyId (raised by the validator, before the service is even
   * called), a caller who turns out not to be on the company, a project that
   * does not exist, a failed transaction. Without this, refused requests
   * accumulate on the volume.
   */
  try {
    const projectId = common.parseId(req.params.projectId, 'projectId');
    const { companyId } = validateDocumentUpload(req.body);

    const data = await documentService.uploadDocuments({
      userId: req.user.id,
      requestId: req.id,
      projectId,
      companyId,
      files: req.files,
    });

    return res.status(201).json({
      success: true,
      message: data.uploaded === 1 ? 'Document uploaded.' : `${data.uploaded} documents uploaded.`,
      data,
    });
  } catch (err) {
    // Never throws, so the original error is what reaches the client.
    await documentService.discardUploadedFiles(req.files, req.id);
    throw err;
  }
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

  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(file.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  return res.sendFile(file.absolutePath);
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

module.exports = { uploadDocuments, listDocuments, downloadDocument, deleteDocument };
