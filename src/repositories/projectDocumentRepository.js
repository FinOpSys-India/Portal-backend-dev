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
 * bytes themselves are on disk under config.uploads.documentsDir. Putting a
 * 25 MB PDF in a bytea column would make every `SELECT *` on this table drag the
 * whole archive across the wire, and make the nightly database backup carry the
 * files as well. Metadata in Postgres, bytes on the filesystem, joined by
 * `file_key` — which is exactly why that column is UNIQUE.
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

/** One document in the response shape, after a write. */
function findDocumentDetail(client, documentId) {
  return client.projectDocument.findFirst({
    where: { id: documentId, deletedAt: null },
    select: DOCUMENT_SELECT,
  });
}

/**
 * Soft delete, matching projects and companies.
 *
 * The row survives with `deleted_at` set and the bytes are left on disk. Both
 * halves are deliberate: an attachment is evidence for a piece of work that was
 * done, and a mis-click that unlinked a client's only copy of a tax return would
 * be unrecoverable. Reclaiming the disk is a separate, deliberate sweep over
 * rows that have been deleted long enough — not a side effect of a button.
 */
function softDeleteDocument(client, documentId, deletedAt) {
  return client.projectDocument.update({
    where: { id: documentId },
    data: { deletedAt },
    select: { id: true, deletedAt: true },
  });
}

module.exports = {
  DOCUMENT_SELECT,
  listDocuments,
  summarizeDocuments,
  createDocuments,
  findDocumentsByIds,
  findDocumentForAccess,
  findDocumentDetail,
  softDeleteDocument,
};
