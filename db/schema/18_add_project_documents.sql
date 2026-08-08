-- 18_add_project_documents.sql
--
-- The files attached to a project — the table 17_add_projects.sql deliberately
-- left out, landing here with the upload endpoints that read and write it.
--
-- WHAT THIS ADDS
--
--   project_documents   one row per uploaded file
--
-- NOTE ON PROVENANCE, same as 17. The live table was created by hand in the
-- Supabase editor ahead of this file and prisma/schema.prisma already describes
-- the model, so every object below already exists in the deployed database under
-- the names used here (`project_documents_size_positive`,
-- `project_documents_project_id_idx` carrying `WHERE deleted_at IS NULL`,
-- `project_documents_uploaded_by_idx`). Every statement is guarded and matched
-- against those real names, so running this against the live database is a no-op
-- and running it against an empty one produces the same shape.
--
-- FOUR DECISIONS WORTH STATING
--
--   1. THE BYTES ARE NOT IN THE DATABASE. The row holds a `file_key` — the path
--      the upload middleware generated, e.g. "projects/42/9f3c…b1.pdf" — and the
--      file lives on the filesystem under UPLOAD_DOCUMENTS_DIR. A bytea column
--      would put a 25 MB PDF behind every careless `SELECT *`, carry the whole
--      archive into each database backup, and push rows into TOAST storage where
--      the metadata queries this feature actually runs would still have to walk
--      past them. Metadata in Postgres, bytes on disk, joined by the key.
--
--   2. THAT FILE LIVES OUTSIDE THE PUBLIC UPLOAD FOLDER. `uploads/` is served by
--      express.static to anyone with the URL (avatars must be reachable from an
--      <img> tag, which cannot send an Authorization header). A project document
--      is a client's bank statement. It is stored under a separate root that
--      nothing serves statically, and the only way to read one is the download
--      endpoint, which authorizes the caller first.
--
--   3. `file_key` IS UNIQUE. It is what makes a retried upload unable to
--      register the same bytes twice, and it is what guarantees that two rows can
--      never point at one file — which would make deleting either one corrupt the
--      other.
--
--   4. THERE IS NO `company_id` COLUMN, and its absence is the design. A document
--      belongs to a project, and the project already names the company; a second
--      copy of that fact could disagree with the first, and then no query could
--      say which was true. The upload endpoint DOES require companyId in the
--      request — as a consistency check against the project, not as something to
--      store. "Which company is this document for" is one join away and always
--      correct.
--
-- WHO MAY UPLOAD — someone associated with the project's company (its owner, a
-- teammate on company_members, the accounting manager, an assigned specialist,
-- or an admin) — is enforced in the service layer, where the caller's identity
-- comes from the verified token and the company link can actually be read. No
-- CHECK constraint can reach across four tables from here.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. project_documents                                                       */
/* -------------------------------------------------------------------------- */

-- CASCADE on the project: a document means nothing without the project it is
-- attached to. Note that ordinary removal of a project is the SOFT delete in
-- 17_add_projects.sql, which leaves these rows alone — this only fires on a true
-- DELETE, where keeping orphaned rows pointing at a project id that no longer
-- exists would be worse than losing them.
--
-- SET NULL on the uploader: deleting a staff account loses the attribution, not
-- the file. The document is the company's; who happened to attach it is
-- secondary, and blocking the account deletion over it (RESTRICT) would make
-- offboarding impossible.
CREATE TABLE IF NOT EXISTS "project_documents" (
    "id"                  SERIAL       PRIMARY KEY,
    "project_id"          INTEGER      NOT NULL REFERENCES "projects"("id") ON UPDATE CASCADE ON DELETE CASCADE,

    -- The generated storage path, relative to the documents root. 512 because a
    -- future move to an object store may key by a longer prefix; the value this
    -- application writes is about 40 characters.
    "file_key"            VARCHAR(512) NOT NULL UNIQUE,

    -- The name the file arrived with, shown back to the user. NEVER used to
    -- build a path: it is attacker-controlled, and "../../server.js" is a
    -- perfectly ordinary string in this column.
    "original_name"       VARCHAR(255) NOT NULL,

    -- Measured from the upload, not taken from the request, and constrained to
    -- an allowlist in the middleware.
    "mime_type"           VARCHAR(150) NOT NULL,

    -- BIGINT rather than INTEGER. A 25 MB cap fits in an INTEGER today, but the
    -- cap is configuration and INTEGER tops out at 2 GB; a column that has to be
    -- widened later is a migration on a table with millions of rows, and eight
    -- bytes now costs nothing.
    "size_bytes"          BIGINT       NOT NULL,

    "uploaded_by_user_id" INTEGER               REFERENCES "users"("id")    ON UPDATE CASCADE ON DELETE SET NULL,

    "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Soft delete, matching projects and companies. A removed attachment leaves
    -- the list without erasing the record that it was once filed — and the bytes
    -- stay on disk, so a mis-click is recoverable.
    "deleted_at"          TIMESTAMPTZ
);

-- A zero-byte file is an upload that failed, not a document. NOT NULL alone
-- would accept it; this is the constraint that actually means "there are bytes",
-- and it holds regardless of who writes the row.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_documents_size_positive') THEN
        ALTER TABLE "project_documents"
            ADD CONSTRAINT "project_documents_size_positive"
            CHECK ("size_bytes" > 0);
    END IF;
END $$;

/*
 * Indexes.
 *
 * The project one is PARTIAL on purpose, matching the projects table: every read
 * in this feature filters `deleted_at IS NULL`, so indexing only live rows keeps
 * removed documents out of the index entirely rather than merely out of the
 * result. It serves both questions the panel asks — the page of documents and
 * the COUNT/SUM beside it — because Postgres can aggregate straight off it.
 *
 * The uploader one is plain: "everything this person ever uploaded" is an audit
 * question, and an audit that cannot see deleted rows is not an audit.
 *
 * `file_key` needs no index of its own — the UNIQUE constraint already built one.
 */
CREATE INDEX IF NOT EXISTS "project_documents_project_id_idx"
    ON "project_documents"("project_id") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "project_documents_uploaded_by_idx"
    ON "project_documents"("uploaded_by_user_id");

COMMIT;
