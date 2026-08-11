'use strict';

const path = require('path');

const config = require('../config');
const { prisma } = require('../config/prisma');
const repo = require('../repositories/projectDocumentRepository');
const projectService = require('./projectService');
const dto = require('../dto/projectDocumentDto');
const storage = require('../utils/storage');
const { documentKey, EXTENSION_BY_MIME, ACCEPTED_LABEL } = require('../utils/documentTypes');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');

/**
 * Documents attached to a project: upload them, list them, fetch one back, and
 * remove one.
 *
 * THE RULE THIS FILE EXISTS FOR — a person may only put a document on a project
 * belonging to a company they are associated with. It is enforced in three
 * layers, and each catches something the others cannot:
 *
 *   1. THE PROJECT MUST EXIST AND BE LIVE. A soft-deleted project takes its
 *      upload surface with it.
 *
 *   2. THE CALLER MUST BE ON THAT PROJECT'S COMPANY. Decided by
 *      projectService.loadProjectForRead — the SAME rule that decides whether
 *      they may see the project at all: the owner, a teammate on
 *      `company_members`, the company's accounting manager, or a specialist
 *      actively assigned to the account. An ADMIN is not on that list and gets
 *      the same 403 as a stranger; these are the client's financial records, and
 *      administering the platform is not being party to the work. Nobody outside
 *      the company can name a project id that resolves for them, which is what
 *      makes a guessed id a 403 rather than a disclosure.
 *
 *   3. THE `companyId` IN THE REQUEST MUST MATCH THE PROJECT'S. This grants
 *      nothing — step 2 already settled access — but it catches a client that
 *      has drifted (a stale company selected in one panel, a project chosen in
 *      another) and would otherwise file a document somewhere its user did not
 *      intend. Wrong-but-authorized is exactly the failure a consistency check
 *      is for.
 *
 * NOTHING IS WRITABLE UNTIL ALL THREE HAVE PASSED, which is easier to guarantee
 * here than it once was. Files no longer travel through this API at all: the
 * browser is handed a signed ticket for one generated key and PUTs the bytes to
 * the bucket itself, so a request that ends in a 400 or a 403 never produces a
 * ticket and therefore cannot store anything anywhere. (It used to be the other
 * way round — the whole multipart body was parsed before this service could
 * decide the caller was not on the company, and every failure path had to clean
 * up after itself.)
 *
 * WHAT THAT DESIGN COSTS is an object with no row: a ticket that is used and
 * never confirmed. Bounded — one key, of a size the confirm step re-measures
 * against the cap — and the price of the size limit disappearing, since a file
 * that passes through a serverless function can never exceed a few megabytes.
 * Sweeping unreferenced objects is a periodic job, not something a request can
 * do.
 */

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

function documentNotFound() {
  return new ApiError(404, 'Document not found.', { code: 'DOCUMENT_NOT_FOUND' });
}

function companyMismatch(projectId) {
  return new ApiError(400, 'That project does not belong to the company you selected.', {
    code: 'PROJECT_COMPANY_MISMATCH',
    fields: { companyId: 'Select the company this project belongs to.' },
    details: { projectId },
  });
}

/* -------------------------------------------------------------------------- */
/* the stored objects                                                         */
/* -------------------------------------------------------------------------- */

const BUCKET = config.storage.documentsBucket;

/**
 * Remove objects written for an upload that is not going to be recorded.
 *
 * Never throws — `storage.removeObjects` swallows and logs. A failed cleanup
 * must not replace the real error: the caller is already on their way to a 502
 * or a 500, and telling them "could not delete" instead would hide the reason
 * their upload failed.
 */
function discardStoredObjects(keys, requestId) {
  return storage.removeObjects({ bucket: BUCKET, keys, requestId });
}

/* -------------------------------------------------------------------------- */
/* what the row records about the file                                        */
/* -------------------------------------------------------------------------- */

// `project_documents.original_name` is VARCHAR(255).
const MAX_NAME_LENGTH = 255;

/**
 * The uploader's own name for the file, made safe to store and to echo back.
 *
 * Three things happen to it, and none of them is cosmetic:
 *
 *   - Any directory part is dropped. Some browsers send a full path for a
 *     drag-and-drop, and "C:\Users\me\tax.pdf" is not a filename. `path.basename`
 *     alone would not catch the Windows form on a POSIX host, hence the split.
 *   - Control characters are stripped. This string is echoed into JSON, into a
 *     Content-Disposition header on download, and into the audit log; a raw
 *     newline in a header is response splitting.
 *   - It is capped at the column width, keeping the extension. Truncating from
 *     the front would turn "…statement.pdf" into "…stateme", which is worse than
 *     useless when the whole point of the field is to tell one file from another.
 *
 * A name that survives none of this (an empty string, or only control
 * characters) falls back to "document" rather than failing the upload — the file
 * is real and the label is decoration.
 */
function toDisplayName(originalName) {
  const base = String(originalName ?? '')
    .split(/[\\/]/)
    .pop();

  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return 'document';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  const ext = path.extname(cleaned).slice(0, 20);
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/* -------------------------------------------------------------------------- */
/* the endpoints — upload                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The MIME type a stored key implies, derived from the map that produced it.
 *
 * The extension is the ONE thing about a directly-uploaded object this API can
 * still vouch for: it was chosen from the allowlist at ticket time, by us, and
 * written into a key the client cannot alter without breaking the signature. So
 * the type is read back from the extension rather than from anything the browser
 * reported, and a file uploaded with `Content-Type: application/x-evil` is
 * recorded as the type it was permitted to be.
 */
const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime])
);

/**
 * A key is only acceptable if it is one WE could have issued, for THIS project.
 *
 * `projects/<projectId>/<32 hex><ext>` is exactly what `documentKey` produces, so
 * anything else was not minted by this API. The project id is interpolated from
 * the URL's already-parsed integer, which is what stops a caller from confirming
 * an object that belongs to a different project — the one thing a signed ticket
 * on its own would not prevent, since a person may hold tickets for two projects
 * they legitimately belong to and could otherwise file one against the other.
 */
function isKeyForProject(key, projectId) {
  return new RegExp(`^projects/${projectId}/[0-9a-f]{32}(\\.[a-z0-9]+)?$`).test(key);
}

/**
 * Raised when the deployment has no object store to sign against.
 *
 * ALWAYS A MISCONFIGURATION IN A DEPLOYED ENVIRONMENT, never a state a caller
 * can do anything about: documents live in Supabase, and if the credentials are
 * absent the driver falls back to a local folder that a serverless host wipes
 * between requests. So this is a 5xx and the client is told to try later, while
 * the thing that actually needs fixing — which driver is active — is put in
 * `details` where whoever is reading the logs will see it.
 *
 * The one legitimate way to reach it is running locally, or in tests, without
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.
 */
function directTransferUnavailable() {
  logger.error(
    'Document storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required ' +
      `for uploads and downloads, and the active driver is "${config.storage.driver}".`
  );

  return new ApiError(503, 'Document storage is not available right now.', {
    code: 'DIRECT_TRANSFER_UNAVAILABLE',
    details: { driver: config.storage.driver },
  });
}

/**
 * POST /projects/:projectId/documents/upload-url — permission to write, as links.
 *
 * The first of the three steps that let a file larger than the host's request
 * ceiling be uploaded at all: the browser asks here, PUTs each file straight to
 * the bucket, then calls `confirmUploads` to have them recorded.
 *
 * WHAT IS DECIDED HERE IS ACCESS, and it is decided by exactly the rule that
 * governs the multipart route — the project must exist and be live, the caller
 * must be party to its company, and the `companyId` in the request must agree
 * with the project's. A ticket is issued only after all three, so a person who
 * cannot upload through the API cannot upload around it either.
 *
 * NOTHING IS RECORDED BY THIS CALL. A ticket that is never used costs a row
 * nowhere and leaves nothing behind; an upload that lands but is never confirmed
 * leaves an unreferenced object, which is the one piece of litter this design
 * accepts in exchange for the size limit disappearing. It is bounded — a ticket
 * writes to one key, of a size the browser has already declared and the confirm
 * step re-measures — and a periodic sweep for objects with no row is the cleanup,
 * not anything this request can do.
 */
async function createUploadTickets({ userId, requestId, projectId, companyId, files }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const { project, company } = await projectService.loadProjectForRead(prisma, { userId, projectId });
  if (project.companyId !== companyId) throw companyMismatch(projectId);

  const tickets = await Promise.all(
    files.map(async (file) => {
      const key = documentKey(project.id, file.mimeType);
      const ticket = await storage.signedUploadUrl({ bucket: BUCKET, key });

      if (!ticket) {
        throw new ApiError(502, 'Could not prepare the upload. Try again.', {
          code: 'STORAGE_TICKET_FAILED',
          details: { fileName: file.fileName },
        });
      }

      return {
        fileName: toDisplayName(file.fileName),
        key,
        uploadUrl: ticket.url,
        // Supabase's own client can take this instead of the URL
        // (`uploadToSignedUrl`), so a frontend using their SDK does not have to
        // pick the URL apart to find it.
        token: ticket.token,
      };
    })
  );

  logEvent({
    event: 'project.document.upload_ticket.issued',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    detail: `${tickets.length} ticket(s)`,
  });

  return { projectId: project.id, companyId: company.id, uploads: tickets };
}

/**
 * POST /projects/:projectId/documents/confirm — record what actually landed.
 *
 * The third step, and the one that decides what is true. The bytes went to the
 * bucket without passing through here, so this call is the first moment the API
 * can know anything about them — and it does not ask the client. Every field the
 * caps depend on is read back from the object itself:
 *
 *   IT EXISTS        an object is fetched for each key. A confirm for something
 *                    that never uploaded is a 404, not a row pointing at nothing.
 *   ITS REAL SIZE    from the bucket, not from the request. This is what makes
 *                    the earlier size check enforceable rather than advisory: a
 *                    client that understated a file gets its ticket and then a
 *                    413 here, with the oversized object deleted again.
 *   ITS TYPE         from the extension in the key, which came from the allowlist
 *                    when the ticket was issued. The browser's Content-Type is
 *                    not consulted; it is the client's word for the one property
 *                    the allowlist exists to constrain.
 *
 * The key itself is checked against the project before any of that (see
 * `isKeyForProject`), so a caller cannot confirm somebody else's object, and
 * against the rows already recorded, so a retried or double-clicked confirm adds
 * nothing the second time.
 */
async function confirmUploads({ userId, requestId, projectId, companyId, files }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const { project, company } = await projectService.loadProjectForRead(prisma, { userId, projectId });
  if (project.companyId !== companyId) throw companyMismatch(projectId);

  const foreign = files.filter((f) => !isKeyForProject(f.key, project.id));
  if (foreign.length) {
    throw new ApiError(400, 'Those uploads do not belong to this project.', {
      code: 'INVALID_UPLOAD_KEY',
      fields: { files: 'Confirm only the uploads this project issued.' },
      details: { keys: foreign.map((f) => f.key) },
    });
  }

  const already = await repo.findDocumentsByKeys(prisma, files.map((f) => f.key));
  if (already.length) {
    throw new ApiError(409, 'Those uploads have already been recorded.', {
      code: 'DOCUMENT_ALREADY_RECORDED',
      details: { documentIds: already.map((d) => d.id) },
    });
  }

  const stats = await Promise.all(
    files.map((file) => storage.statObject({ bucket: BUCKET, key: file.key }))
  );

  const missing = files.filter((_, i) => !stats[i]);
  if (missing.length) {
    throw new ApiError(404, 'Some of those uploads did not arrive.', {
      code: 'UPLOAD_NOT_FOUND',
      fields: { files: 'Upload the file before confirming it.' },
      details: { fileNames: missing.map((f) => toDisplayName(f.fileName)) },
    });
  }

  /*
   * Anything past the cap is deleted rather than left sitting in the bucket. It
   * was written by a signed ticket this API issued, so it is ours to clean up,
   * and refusing to record it while leaving it stored would be the worst of both
   * — space consumed for a document that does not exist.
   */
  const oversized = files
    .map((file, i) => ({ file, sizeBytes: stats[i].sizeBytes }))
    .filter((f) => f.sizeBytes > config.uploads.maxDocumentBytes);

  if (oversized.length) {
    await discardStoredObjects(oversized.map((f) => f.file.key), requestId);
    const mb = Math.round(config.uploads.maxDocumentBytes / (1024 * 1024));
    throw new ApiError(413, `That file is too large. Maximum size is ${mb} MB.`, {
      code: 'FILE_TOO_LARGE',
      fields: { files: `Each file must be under ${mb} MB.` },
      details: {
        files: oversized.map((f) => ({
          fileName: toDisplayName(f.file.fileName),
          sizeBytes: f.sizeBytes,
        })),
        maxBytes: config.uploads.maxDocumentBytes,
      },
    });
  }

  const rows = files.map((file, i) => {
    const ext = path.extname(file.key).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[ext];

    // Unreachable through a ticket this API issued — the extension came from the
    // allowlist. Checked anyway, because this is the last point before a type
    // outside it would become a stored row.
    if (!mimeType) {
      throw new ApiError(415, `Only ${ACCEPTED_LABEL} files are accepted.`, {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        details: { fileName: toDisplayName(file.fileName), extension: ext },
      });
    }

    return {
      projectId: project.id,
      fileKey: file.key,
      originalName: toDisplayName(file.fileName),
      mimeType,
      // The bucket's measurement, never the client's claim.
      sizeBytes: BigInt(stats[i].sizeBytes),
      uploadedByUserId: userId,
    };
  });

  let documents;
  try {
    documents = await prisma.$transaction(async (tx) => {
      const created = await repo.createDocuments(tx, rows);
      return repo.findDocumentsByIds(tx, created.map((d) => d.id));
    });
  } catch (err) {
    // Same reasoning as the multipart route: objects with no row are garbage.
    await discardStoredObjects(rows.map((r) => r.fileKey), requestId);
    throw err;
  }

  logEvent({
    event: 'project.document.uploaded',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    detail: `${documents.length} file(s) via direct upload, ${rows.reduce((sum, r) => sum + Number(r.sizeBytes), 0)} bytes`,
  });

  return dto.toUploadResult({ projectId: project.id, companyId: company.id, documents });
}

/**
 * GET /projects/:projectId/documents — the attachments panel.
 *
 * Read access to the project is read access to its documents: if you can see
 * that the work exists, you can see what is attached to it. Narrowing this to
 * the uploader would break the case the feature is FOR — a customer uploads a
 * bank statement so that their specialist can open it.
 */
async function listDocuments({ userId, requestId, projectId, query }) {
  const { project, company } = await projectService.loadProjectForRead(prisma, { userId, projectId });

  const { search, limit, offset, sort, order } = query;

  const [documents, summary] = await Promise.all([
    repo.listDocuments(prisma, { projectId: project.id, search, limit, offset, sort, order }),
    repo.summarizeDocuments(prisma, { projectId: project.id, search }),
  ]);

  logEvent({
    event: 'project.document.list.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    detail: `${documents.length} document(s)`,
  });

  return dto.toDocumentList({
    documents,
    total: summary._count._all,
    totalBytes: summary._sum.sizeBytes,
    limit,
    offset,
  });
}

/**
 * GET /documents?companyId= — every file on a company, across its projects.
 *
 * The per-project panel answers "what is attached to this piece of work". This
 * answers "what has this client sent us", which previously had no endpoint at
 * all: a client wanting it had to list the projects and then call the documents
 * route once per project, so a company with forty projects cost forty-one
 * requests to render one screen. Here it is two queries whatever the size.
 *
 * Authorization is the COMPANY read rule, borrowed whole from projectService
 * rather than rebuilt — owner, admin, the company's accounting manager, or an
 * assigned specialist. It is checked before any document is read, so an
 * unauthorized caller learns nothing about how many files exist.
 *
 * Both soft-delete filters live in the repository: deleted documents are gone,
 * and so are the documents of a deleted project.
 */
async function listCompanyDocuments({ userId, requestId, query }) {
  const { companyId, projectId, search, limit, offset, sort, order } = query;

  const { company } = await projectService.loadCompanyForRead(prisma, { userId, companyId });

  const [documents, summary] = await Promise.all([
    repo.listCompanyDocuments(prisma, { companyId: company.id, projectId, search, limit, offset, sort, order }),
    repo.summarizeCompanyDocuments(prisma, { companyId: company.id, projectId, search }),
  ]);

  logEvent({
    event: 'company.document.list.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `${documents.length} document(s)`,
  });

  return dto.toCompanyDocumentList({
    companyId: company.id,
    documents,
    total: summary._count._all,
    totalBytes: summary._sum.sizeBytes,
    limit,
    offset,
  });
}

/**
 * The document behind GET .../documents/:documentId/download, with its bytes —
 * authorized first.
 *
 * Returns rather than writes: the controller owns the response, and a service
 * that writes to `res` cannot be called from anywhere else.
 *
 * The document is looked up on its OWN id and then checked against the project
 * in the URL. Fetching it "within" the project would give the same answer to the
 * question that matters, but this way a mismatched pair is a 404 on the document
 * rather than a silent empty result — and the access check that follows is
 * performed on the project the document really belongs to, not the one the URL
 * claimed.
 */
async function getDocumentForDownload({ userId, requestId, projectId, documentId }) {
  const document = await repo.findDocumentForAccess(prisma, documentId);
  if (!document || document.projectId !== projectId || document.project?.deletedAt) {
    throw documentNotFound();
  }

  const { company } = await projectService.loadProjectForRead(prisma, {
    userId,
    projectId: document.projectId,
  });

  const audit = () =>
    logEvent({
      event: 'project.document.downloaded',
      status: 'success',
      requestId,
      userId,
      companyId: company.id,
      projectId: document.projectId,
      detail: `document ${document.id}`,
    });

  /*
   * REMOTE: a link, not the bytes. Everything above this line — the row, the
   * project, the company membership — has already decided that this caller may
   * read this file; the only question left is which road the bytes take.
   *
   * They must not take this one. A serverless host buffers the whole response
   * before sending it and refuses anything past ~4.5 MB, so returning the file
   * through this function caps every download at a few megabytes no matter what
   * the upload allowed. A signed URL points the browser straight at the bucket,
   * and the file's size stops being this API's concern.
   *
   * The audit line is written HERE rather than after the transfer because this is
   * the moment we authorized it — the fetch itself happens against Supabase and
   * we will never see it. What is recorded is what actually happened: at this
   * instant, this user was granted this document.
   */
  const url = await storage.signedUrl({
    bucket: BUCKET,
    key: document.fileKey,
    expiresIn: config.storage.signedUrlTtlSeconds,
    download: document.originalName,
  });

  if (url) {
    audit();
    return {
      url,
      fileName: document.originalName,
      mimeType: document.mimeType,
      sizeBytes: Number(document.sizeBytes ?? 0),
    };
  }

  /*
   * LOCAL: the bytes, as before. There is no object store to sign against on a
   * laptop or in the test suite, and no ceiling to work around either.
   *
   * Fetched in full before the controller starts a response, so a missing object
   * is a clean 404 the client can act on. Streaming would discover the same
   * problem after the headers were already sent, and the download would simply
   * truncate — a corrupt file that looks like a success.
   *
   * This is also where a REMOTE document with no object lands: `signedUrl`
   * declines to sign a key that is not in the bucket, so the read below returns
   * null too and the 404 is reached by the same path it always was. The commonest
   * cause is a row written by one storage driver being read by another — a
   * document uploaded to a developer's local folder has a perfectly valid row,
   * and nothing in the bucket.
   */
  const body = await storage.getObject({ bucket: BUCKET, key: document.fileKey });
  if (!body) {
    logger.error(`[${requestId}] Document ${document.id} has no stored object at ${document.fileKey}`);
    throw documentNotFound();
  }

  audit();

  return {
    body,
    fileName: document.originalName,
    mimeType: document.mimeType,
    // From the bytes actually fetched, not from the row. The two agree in every
    // normal case; when they do not, the Content-Length must describe what is
    // really being sent or the client hangs waiting for bytes that never come.
    sizeBytes: body.length,
  };
}

/**
 * POST /projects/:projectId/documents/links — the bulk download, as links.
 *
 * The alternative to the zip, and the reason it exists is the zip's one
 * unavoidable limit: an archive is not an object in the bucket, so there is
 * nothing to hand out a URL for — the function has to fetch every file, build it
 * in memory and send it, which puts the whole selection back inside the host's
 * response ceiling. This endpoint returns one signed link per document instead,
 * and the browser fetches them directly (and may zip them itself). Nothing passes
 * through the API, so nothing is capped by it.
 *
 * SAME SELECTION RULES AS THE ARCHIVE, deliberately: omit `documentIds` for
 * everything on the project, or send the ticked ones and have any id that does
 * not resolve on THIS project come back as a 404 naming it. A caller must not be
 * able to learn a different project's document ids by watching which ones
 * silently vanish from a response.
 *
 * NO BYTE CAP HERE, and its absence is the point rather than an oversight. The
 * archive is capped because the function holds every file in memory at once; a
 * list of links holds none of them, so the only bound that still means anything
 * is the number of documents — which stays, because it bounds the round trips to
 * the bucket that minting the links costs.
 */
async function createDownloadLinks({ userId, requestId, projectId, documentIds }) {
  if (!storage.isRemote()) throw directTransferUnavailable();

  const { project, company } = await projectService.loadProjectForRead(prisma, { userId, projectId });

  const documents = await repo.listDocumentsForArchive(prisma, {
    projectId: project.id,
    ids: documentIds,
  });

  if (documentIds) {
    const found = new Set(documents.map((d) => d.id));
    const missing = documentIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new ApiError(404, 'Some of those documents could not be found on this project.', {
        code: 'DOCUMENT_NOT_FOUND',
        details: { missing },
      });
    }
  }

  if (!documents.length) {
    throw new ApiError(404, 'This project has no documents to download.', {
      code: 'NO_DOCUMENTS',
      details: { projectId: project.id },
    });
  }

  const { maxArchiveDocuments } = config.uploads;
  if (documents.length > maxArchiveDocuments) {
    throw new ApiError(413, `Download at most ${maxArchiveDocuments} documents at a time.`, {
      code: 'ARCHIVE_TOO_LARGE',
      details: { count: documents.length, maxDocuments: maxArchiveDocuments },
    });
  }

  const links = await Promise.all(
    documents.map((doc) =>
      storage.signedUrl({
        bucket: BUCKET,
        key: doc.fileKey,
        expiresIn: config.storage.signedUrlTtlSeconds,
        download: doc.originalName,
      })
    )
  );

  /*
   * All or nothing, exactly as the archive is. A response listing nine working
   * links and one that silently isn't there would have the browser download nine
   * files and fail on the tenth, after the user believed the selection had
   * succeeded — the same truncated-download failure the buffered route was
   * written to avoid, moved one layer out.
   */
  const unreadable = documents.filter((_, i) => !links[i]);
  if (unreadable.length) {
    logger.error(
      `[${requestId}] Download links for project ${project.id} are missing ${unreadable.length} stored object(s): ` +
        unreadable.map((d) => `${d.id}@${d.fileKey}`).join(', ')
    );
    throw new ApiError(404, 'Some of those documents are no longer available.', {
      code: 'DOCUMENT_NOT_FOUND',
      details: { missing: unreadable.map((d) => d.id) },
    });
  }

  logEvent({
    event: 'project.document.links.issued',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: project.id,
    detail: `${documents.length} link(s)`,
  });

  return {
    projectId: project.id,
    count: documents.length,
    /*
     * Told, not implied. The links expire, and a client that holds them while a
     * user picks a folder needs to know how long it has rather than discovering
     * the answer as a failed download halfway through the set.
     */
    expiresInSeconds: config.storage.signedUrlTtlSeconds,
    documents: documents.map((doc, i) => ({
      id: doc.id,
      fileName: doc.originalName,
      mimeType: doc.mimeType,
      sizeBytes: dto.toBytes(doc.sizeBytes),
      url: links[i],
    })),
  };
}

/**
 * DELETE /projects/:projectId/documents/:documentId — soft delete.
 *
 * WHO MAY. Whoever uploaded it, plus anyone with write access to the project
 * (the company's accounting manager, the project's creator, or the assigned
 * specialist). The uploader is on the list because taking back a file
 * you attached by mistake should not require finding a manager; everyone else is
 * on it because they are already responsible for the work the file belongs to.
 *
 * A plain teammate who did not upload it is NOT on the list — they can read the
 * project's documents, and removing someone else's attachment is a different
 * thing from reading it.
 */
async function deleteDocument({ userId, requestId, projectId, documentId }) {
  const document = await repo.findDocumentForAccess(prisma, documentId);
  if (!document || document.projectId !== projectId || document.project?.deletedAt) {
    throw documentNotFound();
  }

  const { caller, project, company } = await projectService.loadProjectForRead(prisma, {
    userId,
    projectId: document.projectId,
  });

  if (document.uploadedByUserId !== caller.id) {
    // Throws PROJECT_ACCESS_DENIED for anyone who is neither the uploader nor
    // responsible for the project.
    projectService.assertWriteAccess(caller, company, project);
  }

  await repo.softDeleteDocument(prisma, document.id, new Date());

  /*
   * THE ROW IS SOFT-DELETED; THE BYTES ARE REALLY GONE. The two halves of a
   * delete answer different needs and deliberately behave differently.
   *
   * The row stays so the history survives — who attached what, and when it was
   * removed. It costs a few hundred bytes and every listing already excludes it
   * (`findDocumentForAccess` and the list queries all filter `deletedAt: null`),
   * so nothing can read or download it from this point on.
   *
   * The OBJECT is deleted outright, because a marked-deleted row that leaves its
   * file in the bucket means storage only ever grows: a user who uploads the
   * wrong 20 MB scan and removes it has still spent that 20 MB forever, and no
   * amount of tidying in the application would give it back. Bytes are the
   * expensive half and the half nobody can see, which makes them exactly the
   * wrong thing to keep "just in case".
   *
   * ORDER MATTERS: the row is marked first, so at no instant is there a readable
   * document whose bytes are missing. The reverse order would open a window where
   * a download finds a live row pointing at nothing — a 404 on a file the user
   * can still see in the list.
   *
   * This does NOT throw if the bucket refuses (see storage.removeObjects). The
   * delete has already succeeded from the user's point of view, and failing their
   * request over a leftover object would be a wrong answer to a real outcome; the
   * orphan is logged instead.
   */
  await discardStoredObjects([document.fileKey], requestId);

  logEvent({
    event: 'project.document.deleted',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    projectId: document.projectId,
    detail: `document ${document.id}`,
  });

  return { id: document.id, projectId: document.projectId, deleted: true };
}

module.exports = {
  createUploadTickets,
  confirmUploads,
  listDocuments,
  listCompanyDocuments,
  getDocumentForDownload,
  createDownloadLinks,
  deleteDocument,
  // Exported for the tests, which check the naming rules directly rather than
  // through a multipart request.
  toDisplayName,
};
