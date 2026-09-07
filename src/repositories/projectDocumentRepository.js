'use strict';

/**
 * Data access for the files attached to a project.
 *
 * Same conventions as projectRepository: the Prisma client is the first
 * argument (`prisma` for a standalone read, `tx` inside a transaction), and the
 * soft-delete filter lives HERE rather than in the service, so no caller can
 * forget it — `deletedAt: null` is part of every read below.
 *
 * WHAT IS AND IS NOT STORED. The row holds the file's IDENTITY (where the bytes
 * are, what they were called, what type they are, how big) and nothing else; the
 * bytes themselves live in the private documents bucket (see utils/storage).
 * Putting a 25 MB PDF in a bytea column would make every `SELECT *` on this
 * table drag the whole archive across the wire, and make the nightly database
 * backup carry the files as well. Metadata in Postgres, bytes in object storage,
 * joined by `file_key` — which is exactly why that column is UNIQUE.
 */

/**
 * The columns a document row needs to render, and nothing else.
 *
 * `fileKey` is DELIBERATELY ABSENT. It is an internal storage path, the client
 * has no use for it, and shipping it would invite a frontend to construct its
 * own URL — which is the one thing that must not work, since these files are not
 * publicly served. The download endpoint resolves the key server-side.
 */
const DOCUMENT_SELECT = {
  id: true,
  projectId: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedByUserId: true,
  createdAt: true,
  updatedAt: true,
  // Same allowlist as projectRepository.PROJECT_SELECT.createdBy: enough to put
  // a name, a role, and a face beside the row; no password hash, no
  // login-security column, no address.
  uploadedBy: {
    select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, avatarKey: true },
  },
};

/** Everything the authorization step needs, and none of the joins. */
const DOCUMENT_ACCESS_SELECT = {
  id: true,
  projectId: true,
  fileKey: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedByUserId: true,
};

function buildDocumentWhere({ projectId, search }) {
  const where = { projectId, deletedAt: null };
  // The name the uploader gave it — the only text on the row a person would
  // search by. The file key is random hex and searching it would match nothing
  // a user could have typed.
  if (search) where.originalName = { contains: search, mode: 'insensitive' };
  return where;
}

/** One page of a project's documents, newest first. */
function listDocuments(client, { projectId, search, limit, offset, sort, order }) {
  return client.projectDocument.findMany({
    where: buildDocumentWhere({ projectId, search }),
    select: DOCUMENT_SELECT,
    // Secondary sort on id for the same reason as projects: several files
    // uploaded in one request share a timestamp to the millisecond, and without
    // a tiebreaker their relative order can differ between two requests for the
    // same page — which shows one row twice and skips another.
    orderBy: [{ [sort || 'createdAt']: order || 'desc' }, { id: 'desc' }],
    take: limit,
    skip: offset,
  });
}

/**
 * Every document belonging to a COMPANY, across all of its projects.
 *
 * Reached through the `project` relation rather than a `projectId IN (...)`
 * list, so the company filter and the project's own soft-delete filter are one
 * query the database plans together. Fetching the project ids first and passing
 * them in would be two round trips, and would go stale between them — a project
 * deleted in the gap would still have its files listed.
 *
 * `project: { deletedAt: null }` is the load-bearing half of that: a document is
 * only reachable while the work it is attached to is. Without it, deleting a
 * project would quietly leave its attachments on this screen, which is the one
 * place they would still be downloadable from.
 *
 * `projectId` narrows to a single project when the caller wants one — the same
 * endpoint answering "this company's files" and "this project's files, seen from
 * the company screen" without a second contract to learn.
 */
function buildCompanyDocumentWhere({ companyId, projectId, search }) {
  return {
    deletedAt: null,
    project: {
      companyId,
      deletedAt: null,
      ...(projectId ? { id: projectId } : {}),
    },
    ...(search ? { originalName: { contains: search, mode: 'insensitive' } } : {}),
  };
}

/**
 * One page of a company's documents.
 *
 * The project is joined onto every row because this list spans projects: a file
 * name on its own does not say which piece of work it belongs to, and that is
 * the column the screen exists to show.
 */
function listCompanyDocuments(client, { companyId, projectId, search, limit, offset, sort, order }) {
  return client.projectDocument.findMany({
    where: buildCompanyDocumentWhere({ companyId, projectId, search }),
    select: {
      ...DOCUMENT_SELECT,
      project: { select: { id: true, projectName: true, status: true, deadlineDate: true } },
    },
    // `id` breaks ties for the same reason as the per-project list: files
    // uploaded in one request share a timestamp to the millisecond, and without
    // a tiebreaker a row can appear on two pages while another is skipped.
    orderBy: [{ [sort || 'createdAt']: order || 'desc' }, { id: 'desc' }],
    take: limit,
    skip: offset,
  });
}

/** The company-wide totals, computed by Postgres — see summarizeDocuments. */
function summarizeCompanyDocuments(client, { companyId, projectId, search }) {
  return client.projectDocument.aggregate({
    where: buildCompanyDocumentWhere({ companyId, projectId, search }),
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
}

/**
 * The page's totals: how many files and how many bytes.
 *
 * One `aggregate` rather than a `count` plus a `findMany().reduce()` — the sum
 * is computed by Postgres over the index, so a project with 400 attachments
 * costs the same as one with four, and no row leaves the database to be added up
 * in JavaScript.
 */
function summarizeDocuments(client, { projectId, search }) {
  return client.projectDocument.aggregate({
    where: buildDocumentWhere({ projectId, search }),
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
}

/**
 * Insert a whole upload in ONE statement and return the rows.
 *
 * `createManyAndReturn` is a single multi-row INSERT ... RETURNING. Ten files
 * inserted one at a time would be ten round trips to a managed Postgres — the
 * dominant cost here is latency, not the insert. The relation columns cannot be
 * joined by a returning-insert, so the ids come back and the caller re-reads
 * them with DOCUMENT_SELECT: two queries for any number of files.
 */
function createDocuments(client, rows) {
  return client.projectDocument.createManyAndReturn({
    data: rows,
    select: { id: true },
  });
}

/** The rows just written, in the shape the response wants. */
function findDocumentsByIds(client, ids) {
  if (!ids.length) return Promise.resolve([]);
  return client.projectDocument.findMany({
    where: { id: { in: ids } },
    select: DOCUMENT_SELECT,
    orderBy: { id: 'asc' },
  });
}

/**
 * One document plus the few project columns the access rules read.
 *
 * The project is joined rather than fetched separately because every caller of
 * this needs both, and because it is what makes "does this document belong to
 * the project in the URL" answerable without a second query.
 */
function findDocumentForAccess(client, documentId) {
  return client.projectDocument.findFirst({
    where: { id: documentId, deletedAt: null },
    select: {
      ...DOCUMENT_ACCESS_SELECT,
      project: {
        select: {
          id: true,
          companyId: true,
          createdByUserId: true,
          assignedSpecialistUserId: true,
          deletedAt: true,
        },
      },
    },
  });
}

/**
 * The documents a bulk download will archive — everything needed to fetch the
 * bytes and name the member, and nothing else.
 *
 * `ids` null means the whole project, which is what "Download all" sends. When
 * ids ARE given they are intersected with the project rather than trusted: an id
 * belonging to another project simply does not come back, and the service turns
 * that absence into a 404 naming it. That is what stops a caller with legitimate
 * access to project 5 from pulling project 9's files into their archive by id.
 *
 * Ordered by name so the archive's contents read the way the panel does, rather
 * than in whatever order the ids arrived.
 */
function listDocumentsForArchive(client, { projectId, ids }) {
  return client.projectDocument.findMany({
    where: {
      projectId,
      deletedAt: null,
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: {
      id: true,
      fileKey: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: [{ originalName: 'asc' }, { id: 'asc' }],
  });
}

/** One document in the response shape, after a write. */
function findDocumentDetail(client, documentId) {
  return client.projectDocument.findFirst({
    where: { id: documentId, deletedAt: null },
    select: DOCUMENT_SELECT,
  });
}

/**
 * Rows already pointing at any of these storage keys — the guard against
 * recording one uploaded object as two documents.
 *
 * Only the direct-upload path needs this. When a file arrives THROUGH the API the
 * key is generated and inserted in the same call, so nothing can name it twice;
 * when the browser uploads to the bucket itself, the confirm call that follows is
 * an ordinary HTTP request that can be retried, replayed, or double-clicked, and
 * without this each attempt would add another row for the same bytes.
 *
 * Soft-deleted rows are INCLUDED deliberately. A key belonging to a deleted
 * document is not free to reuse: the row still refers to it, and re-confirming it
 * would resurrect the object under a second id while the first still claims it.
 */
function findDocumentsByKeys(client, keys) {
  return client.projectDocument.findMany({
    where: { fileKey: { in: keys } },
    select: { id: true, fileKey: true },
  });
}

/**
 * Soft delete, matching projects and companies.
 *
 * The ROW survives with `deleted_at` set, because an attachment is evidence for a
 * piece of work that was done and the history of who removed what is worth a few
 * hundred bytes. The BYTES do not: the service deletes the object immediately
 * afterwards, since a marked-deleted row that leaves its file in the bucket means
 * stored data only ever grows and a user who removes a 20 MB mistake never gets
 * that space back. See projectDocumentService.deleteDocument, which owns the
 * ordering.
 */
function softDeleteDocument(client, documentId, deletedAt) {
  return client.projectDocument.update({
    where: { id: documentId },
    data: { deletedAt },
    select: { id: true, deletedAt: true },
  });
}

/**
 * Every LIVE document on a project, with the storage key its bytes sit under.
 *
 * Read by the project delete, which cannot remove the objects after it has
 * marked the rows: `deletedAt: null` is on this query too, so a moment later
 * there is nothing left here to tell it what to remove. `fileKey` is otherwise
 * kept out of every select in this file (see DOCUMENT_SELECT) — it is an
 * internal path and never leaves the server, which is still true here.
 */
function listLiveDocumentKeysForProject(client, projectId) {
  return client.projectDocument.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, fileKey: true },
  });
}

/**
 * Soft delete every live document on a project, in one statement.
 *
 * WHY updateMany RATHER THAN A LOOP. This runs inside the project-delete
 * transaction, and a project with forty attachments would otherwise be forty
 * round trips holding a write lock. It also makes the cascade atomic with the
 * project row: either the project and all of its documents are marked, or none
 * of them are, so there is no state where a deleted project still has live
 * documents hanging off it.
 *
 * `deletedAt: null` in the filter is not redundant — it stops an already-deleted
 * document having its timestamp rewritten to the moment the PROJECT went, which
 * would lose the record of when the file itself was actually removed.
 */
function softDeleteDocumentsForProject(client, projectId, deletedAt) {
  return client.projectDocument.updateMany({
    where: { projectId, deletedAt: null },
    data: { deletedAt },
  });
}

module.exports = {
  DOCUMENT_SELECT,
  listDocuments,
  summarizeDocuments,
  listCompanyDocuments,
  summarizeCompanyDocuments,
  createDocuments,
  findDocumentsByIds,
  listDocumentsForArchive,
  findDocumentForAccess,
  findDocumentDetail,
  findDocumentsByKeys,
  listLiveDocumentKeysForProject,
  softDeleteDocument,
  softDeleteDocumentsForProject,
};
