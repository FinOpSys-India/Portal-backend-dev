'use strict';

const common = require('./common');
const ApiError = require('../utils/ApiError');

/**
 * Input validation for the project-document endpoints.
 *
 * What is NOT accepted is again the point:
 *
 *   uploadedByUserId    identity comes from the verified access token.
 *   fileKey             generated when the upload ticket is issued. A key IS
 *                       accepted back on confirm — it has to be, since the client
 *                       is the only party that knows which of its uploads
 *                       succeeded — but only after the service has checked it has
 *                       the exact shape this API issues for that project. An
 *                       unchecked storage path is a traversal primitive and a way
 *                       to register a row pointing at somebody else's file.
 *   mimeType, sizeBytes NOT accepted on confirm. Both are read back from the
 *                       stored object, because trusting a client's claim would let
 *                       a 40 MB file register itself as 1 KB and would defeat the
 *                       type allowlist. They ARE accepted when asking for a
 *                       ticket, where they only decide whether to refuse early.
 *
 * `companyId` IS accepted, and the reason is worth stating because it looks
 * redundant: the project already knows its company. It is required precisely so
 * the two can be COMPARED. The client's request says "file this against company
 * 7, project 42"; if project 42 belongs to company 9, that request expresses a
 * belief about the world that is false, and the honest answer is a 400 rather
 * than quietly filing the document wherever the project happens to live. It is a
 * consistency check, never the thing that grants access — see
 * projectDocumentService.
 */

const LIMITS = { search: 120 };

/** Columns a caller may sort the documents list by. Never the raw query value. */
const SORTABLE = ['createdAt', 'originalName', 'sizeBytes'];

/** GET /projects/:projectId/documents?search=&limit=&offset=&sort=&order= */
function validateDocumentListQuery(query = {}) {
  common.rejectUnknown(query, ['search', 'limit', 'offset', 'sort', 'order'], 'query string');

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: SORTABLE,
    defaultSort: 'createdAt',
  });

  return {
    search: query.search ? common.str(query.search, 'search', { max: LIMITS.search }) : null,
    ...page,
    // Newest first. common.pagination already defaults `order` to desc, which is
    // the right way round for an upload date — stated here so the intent is not
    // an accident of the shared default.
    order: query.order ? page.order : 'desc',
  };
}

/**
 * GET /documents?companyId=&projectId=&search=&limit=&offset=&sort=&order=
 *
 * The company-wide list. `companyId` is REQUIRED and has no admin exemption, for
 * the same reason it is required on the teammate roster: a document list belongs
 * to one company, and a merged one would put two clients' files on one screen.
 *
 * `projectId` is optional and narrows to a single project, so the company screen
 * can filter without switching to a different endpoint.
 */
function validateCompanyDocumentListQuery(query = {}) {
  common.rejectUnknown(
    query,
    ['companyId', 'projectId', 'search', 'limit', 'offset', 'sort', 'order'],
    'query string'
  );
  common.requireFields(query, ['companyId']);

  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    sortable: SORTABLE,
    defaultSort: 'createdAt',
  });

  return {
    companyId: common.parseId(query.companyId, 'companyId'),
    projectId:
      query.projectId === undefined || query.projectId === null || query.projectId === ''
        ? null
        : common.parseId(query.projectId, 'projectId'),
    search: query.search ? common.str(query.search, 'search', { max: LIMITS.search }) : null,
    ...page,
    // Newest upload first, as on the per-project panel.
    order: query.order ? page.order : 'desc',
  };
}

/**
 * POST /projects/:projectId/documents/links — the bulk download.
 *
 *   { }                        every document on the project ("Download all")
 *   { documentIds: [5, 6] }    just those
 *
 * OMITTING THE FIELD IS A REAL REQUEST, not a missing one, and that is why it is
 * distinguished from an empty array. `{}` means "all of them"; `[]` means "these
 * none", which is a client that has lost track of its own selection and would
 * otherwise be handed an empty response that looks like a successful download.
 *
 * A POST for something that reads nothing, because the id list belongs in a body:
 * fifty ids in a query string is a URL long enough to be truncated by a proxy,
 * and a truncated list here would silently download the wrong subset.
 *
 * The cap is enforced HERE as well as in the service so an absurd list is
 * refused before a single row is read. The service checks it again against what
 * actually resolves, which is the number that matters.
 */
function validateDocumentArchiveRequest(body = {}, { maxDocuments }) {
  common.rejectUnknown(body, ['documentIds']);

  if (body.documentIds === undefined || body.documentIds === null) return { documentIds: null };

  if (!Array.isArray(body.documentIds)) {
    throw new ApiError(400, 'documentIds must be an array of document ids.', {
      code: 'VALIDATION_ERROR',
      fields: { documentIds: 'Send a list of document ids, or omit it to download everything.' },
    });
  }

  if (!body.documentIds.length) {
    throw new ApiError(400, 'Select at least one document.', {
      code: 'VALIDATION_ERROR',
      fields: { documentIds: 'Select at least one document, or omit the field to download everything.' },
    });
  }

  if (body.documentIds.length > maxDocuments) {
    throw new ApiError(413, `Download at most ${maxDocuments} documents at a time.`, {
      code: 'ARCHIVE_TOO_LARGE',
      fields: { documentIds: `Select no more than ${maxDocuments} documents.` },
      details: { requested: body.documentIds.length, maxDocuments },
    });
  }

  // Deduplicated, because the same id twice is a client bug that would otherwise
  // return the same file twice and have the browser download it twice.
  const ids = [...new Set(body.documentIds.map((id, i) => common.parseId(id, `documentIds[${i}]`)))];

  return { documentIds: ids };
}

/* -------------------------------------------------------------------------- */
/* direct-to-bucket upload                                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /projects/:projectId/documents/upload-url — ask for somewhere to put them.
 *
 *   { companyId, files: [{ fileName, mimeType, sizeBytes }] }
 *
 * WHY THIS ENDPOINT TAKES CLAIMS AT ALL, having said above that a client's
 * account of its own file is not to be trusted. It is not being trusted here
 * either — it is being used to REFUSE EARLY. A person who picks a 90 MB video has
 * to be told before they spend four minutes uploading it, and the only thing that
 * knows the size at that moment is the browser. So the claim is checked against
 * the same caps the real bytes will be checked against, and a request that fails
 * here never gets a ticket.
 *
 * A LYING CLIENT GAINS NOTHING, which is what makes that safe: the confirm step
 * measures the object in the bucket and applies the identical limits to what is
 * really there (see projectDocumentService.confirmUploads). Understating a size
 * buys a ticket and then a rejected confirm, with the object deleted again.
 *
 * `mimeType` is different — it is not merely an early warning. The extension the
 * object is stored under is derived from it, and the allowlist is enforced here
 * because a type outside it must never receive a ticket at all.
 */
function validateUploadTicketRequest(body = {}, { maxFiles, maxBytes, isAllowedMimeType, acceptedLabel }) {
  common.rejectUnknown(body, ['companyId', 'files']);
  common.requireFields(body, ['companyId', 'files']);

  if (!Array.isArray(body.files) || !body.files.length) {
    throw new ApiError(400, 'Send the files you intend to upload.', {
      code: 'VALIDATION_ERROR',
      fields: { files: 'Send a list of { fileName, mimeType, sizeBytes }.' },
    });
  }

  if (body.files.length > maxFiles) {
    throw new ApiError(400, `Upload at most ${maxFiles} files at a time.`, {
      code: 'VALIDATION_ERROR',
      fields: { files: `Send no more than ${maxFiles} files.` },
      details: { requested: body.files.length, maxFiles },
    });
  }

  const files = body.files.map((file, i) => {
    const at = `files[${i}]`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApiError(400, `${at} must be an object.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Each entry needs fileName, mimeType and sizeBytes.' },
      });
    }
    common.rejectUnknown(file, ['fileName', 'mimeType', 'sizeBytes'], at);

    const mimeType = common.str(file.mimeType, `${at}.mimeType`, { max: 255 });
    if (!isAllowedMimeType(mimeType)) {
      throw new ApiError(415, `Only ${acceptedLabel} files are accepted.`, {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        fields: { files: `Upload a ${acceptedLabel} file.` },
        // Which file was wrong, because a selection of twelve that fails needs to
        // name the offender.
        details: { fileName: file.fileName, mimeType },
      });
    }

    const sizeBytes = Number(file.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ApiError(400, `${at}.sizeBytes must be a positive whole number of bytes.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Send each file size in bytes.' },
      });
    }
    if (sizeBytes > maxBytes) {
      const mb = Math.round(maxBytes / (1024 * 1024));
      throw new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
        code: 'FILE_TOO_LARGE',
        fields: { files: `Each file must be under ${mb} MB.` },
        details: { fileName: file.fileName, sizeBytes, maxBytes },
      });
    }

    return {
      fileName: common.str(file.fileName, `${at}.fileName`, { max: 255 }),
      mimeType,
      sizeBytes,
    };
  });

  return { companyId: common.parseId(body.companyId, 'companyId'), files };
}

/**
 * POST /projects/:projectId/documents/confirm — record what was uploaded.
 *
 *   { companyId, files: [{ key, fileName }] }
 *
 * `key` is the ONLY caller-supplied storage path this API accepts anywhere, and
 * the exception is narrow on purpose: it is a key this API generated and signed a
 * ticket for one call earlier, and the service re-checks its shape against the
 * project in the URL before it is used for anything (see
 * projectDocumentService.confirmUploads). Validating it here as a plain string is
 * therefore not the safeguard — the shape check and the bucket lookup are.
 *
 * NOTHING ELSE ABOUT THE FILE IS ACCEPTED. No size, no type: those are read back
 * from the object itself, because they are the two fields a client would have to
 * lie about for the caps to mean nothing. `fileName` is accepted because it is
 * the one property the bucket genuinely does not know — the object is stored
 * under a generated name, and the label the person chose exists only in the
 * browser that picked it.
 */
function validateUploadConfirmRequest(body = {}, { maxFiles }) {
  common.rejectUnknown(body, ['companyId', 'files']);
  common.requireFields(body, ['companyId', 'files']);

  if (!Array.isArray(body.files) || !body.files.length) {
    throw new ApiError(400, 'Send the files that were uploaded.', {
      code: 'VALIDATION_ERROR',
      fields: { files: 'Send a list of { key, fileName }.' },
    });
  }

  if (body.files.length > maxFiles) {
    throw new ApiError(400, `Confirm at most ${maxFiles} files at a time.`, {
      code: 'VALIDATION_ERROR',
      fields: { files: `Send no more than ${maxFiles} files.` },
      details: { requested: body.files.length, maxFiles },
    });
  }

  const files = body.files.map((file, i) => {
    const at = `files[${i}]`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApiError(400, `${at} must be an object.`, {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Each entry needs key and fileName.' },
      });
    }
    common.rejectUnknown(file, ['key', 'fileName'], at);

    return {
      key: common.str(file.key, `${at}.key`, { max: 512 }),
      fileName: common.str(file.fileName, `${at}.fileName`, { max: 255 }),
    };
  });

  // The same key twice would insert the same object as two documents. A client
  // bug, but one that produces a duplicate the user then has to clean up.
  const keys = new Set();
  files.forEach((file) => {
    if (keys.has(file.key)) {
      throw new ApiError(400, 'The same uploaded file was sent twice.', {
        code: 'VALIDATION_ERROR',
        fields: { files: 'Send each uploaded file once.' },
        details: { key: file.key },
      });
    }
    keys.add(file.key);
  });

  return { companyId: common.parseId(body.companyId, 'companyId'), files };
}

module.exports = {
  SORTABLE,
  LIMITS,
  validateDocumentListQuery,
  validateCompanyDocumentListQuery,
  validateDocumentArchiveRequest,
  validateUploadTicketRequest,
  validateUploadConfirmRequest,
};
