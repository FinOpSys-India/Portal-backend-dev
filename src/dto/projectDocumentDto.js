'use strict';

const config = require('../config');
const { toPerson } = require('./projectDto');

/**
 * Response shapes for project documents.
 *
 * Two rules, and both exist because the raw row cannot simply be serialised.
 *
 *   1. `size_bytes` is BIGINT, so Prisma hands back a JavaScript BigInt — and
 *      `JSON.stringify` THROWS on a BigInt rather than rendering it. Every size
 *      that leaves this file goes through `toBytes` below. (Safe to narrow: the
 *      per-file cap is 25 MB and Number holds integers exactly up to 2^53, so a
 *      single file would have to be nine petabytes before it mattered.)
 *
 *   2. `file_key` never leaves this file — it is not even selected by the
 *      repository. Unlike an avatar key, it does not correspond to any URL a
 *      client could fetch: these files are not served statically, on purpose.
 *      What the client gets is `downloadUrl`, which points at the authorized
 *      endpoint, so moving the bytes to S3 with signed URLs later is an edit to
 *      `downloadUrl()` and nothing else.
 */

/** The API's own origin plus prefix — where the download endpoint is mounted. */
const API_BASE = `${config.uploads.publicBaseUrl}${config.apiPrefix === '/' ? '' : config.apiPrefix.replace(/\/+$/, '')}`;

/** A BIGINT column as a JSON number. See rule 1 above. */
function toBytes(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/**
 * Where the bytes can be fetched from — an authenticated API route, not a static
 * file.
 *
 * It carries the project id as well as the document id even though the document
 * id alone would identify the row. That is what makes the URL self-checking: the
 * service refuses a document whose project does not match the path, so a
 * mis-pasted id fails loudly instead of quietly serving somebody else's file.
 */
function downloadUrl(document) {
  return `${API_BASE}/projects/${document.projectId}/documents/${document.id}/download`;
}

/**
 * One attachment as the client sees it.
 *
 * `fileName` rather than `originalName`: the column is named for what it holds
 * (the name the file arrived with, as opposed to the generated storage name),
 * but from the other side of the screen there is only one name and this is it.
 */
function toDocument(document) {
  return {
    id: document.id,
    projectId: document.projectId,
    fileName: document.originalName,
    mimeType: document.mimeType,
    sizeBytes: toBytes(document.sizeBytes),
    downloadUrl: downloadUrl(document),
    // Null when the uploader's account has since been deleted — the FK is SET
    // NULL, so the file outlives the attribution rather than the other way
    // round.
    uploadedBy: toPerson(document.uploadedBy),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/**
 * The documents panel in one response: the page, the paging block, and the
 * project's totals.
 *
 * `totals` is the whole collection, NOT the page — "3 files, 1.2 MB" is a fact
 * about the project, and computing it from a page of 25 would understate it the
 * moment there are 26. When a search is applied it describes the matches, which
 * is what the count beside a filtered list should say.
 */
function toDocumentList({ documents, total, totalBytes, limit, offset }) {
  return {
    documents: documents.map(toDocument),
    totals: { count: total, sizeBytes: toBytes(totalBytes) },
    pagination: { total, limit, offset, hasMore: offset + documents.length < total },
  };
}

/**
 * The result of an upload: what was stored, and how many.
 *
 * Always an array, even for one file, because the endpoint always accepts an
 * array — a client that special-cases the single-file response would break the
 * first time somebody selected two.
 */
function toUploadResult({ projectId, companyId, documents }) {
  return {
    projectId,
    companyId,
    uploaded: documents.length,
    documents: documents.map(toDocument),
  };
}

module.exports = { toBytes, downloadUrl, toDocument, toDocumentList, toUploadResult };
