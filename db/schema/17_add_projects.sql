-- 17_add_projects.sql
--
-- Projects: a unit of work opened against ONE company, for ONE service that
-- company is paying for, with a deadline — plus the files attached to it.
--
-- WHAT THIS ADDS
--
--   project_status      TODO / ACTIVE / COMPLETED
--   projects            the work item
--
-- The attachments table is deliberately NOT here. `project_documents` exists in
-- the database and prisma/schema.prisma describes the model, so the shape is
-- settled — but no code reads or writes it yet, and it lands with the upload
-- endpoints in its own file rather than being half-declared in this one.
--
-- NOTE ON PROVENANCE. The live table was created by hand in the Supabase editor
-- ahead of this file, so several objects here already exist under slightly
-- different names (`projects_name_not_blank` for the blank-name CHECK,
-- `projects_created_by_idx` for the creator index, and partial indexes carrying
-- `WHERE deleted_at IS NULL`, which are strictly better than the plain ones this
-- file would have made). Every statement below is guarded and matched against
-- those real names, so running this against the live database is a no-op and
-- running it against an empty one produces the same shape.
--
-- THREE DECISIONS WORTH STATING
--
--   1. `deadline_date` is a DATE, not a TIMESTAMPTZ. A deadline is the calendar
--      day someone picked in a date field. Storing a zone would make "31 Dec"
--      entered in Kolkata render as 30 Dec to a viewer in New York — a wrong
--      answer to the question actually being asked.
--
--   2. `service_plan_id` is a real foreign key into service_plans, so a project
--      names a service that exists. That it names a service the company has
--      BOUGHT is a rule about the ACTIVE subscription, and only the service
--      layer can see that (it joins company_subscription_items) — no CHECK can
--      reach across tables to enforce it.
--
--   3. `assigned_specialist_user_id` is STORED, not derived on read. The auto
--      assignment copies the company's standing specialist for the plan's
--      service line at the moment the project is created; reassigning that
--      specialist next quarter must not silently rewrite who owned a project
--      that closed last quarter. Same reasoning as
--      company_subscription_items.unit_amount.
--
--      It is NULLABLE, because "nobody is staffed on this line yet" is a real
--      and common state (a company can be onboarded and unstaffed, and FA_Q has
--      no standing-specialist column at all — see config/serviceCatalog).
--      Refusing the project would block real work; NULL is a truthful
--      "unassigned" that an admin screen can surface and fill in.
--
-- WHO MAY CREATE ONE — an ACCOUNTING_MANAGER or a CUSTOMER — is enforced in the
-- service layer, where the caller's role is already loaded from the verified
-- token. A CHECK constraint cannot reach users.role_id from here.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. project_status                                                          */
/* -------------------------------------------------------------------------- */

-- CREATE TYPE has no IF NOT EXISTS, hence the lookup.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_status') THEN
        CREATE TYPE "project_status" AS ENUM ('TODO', 'ACTIVE', 'COMPLETED');
    END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2. projects                                                                */
/* -------------------------------------------------------------------------- */

-- RESTRICT on company and plan: neither may be hard-deleted out from under a
-- project's history. Companies are soft-deleted in this application anyway, so
-- this only blocks a true DELETE.
--
-- SET NULL on the specialist: removing a staff account clears the assignment
-- rather than blocking the delete or taking the project down with it.
--
-- RESTRICT on the creator: "who opened this" is part of the record, and a
-- project whose creator vanished cannot answer the question the column exists to
-- answer.
CREATE TABLE IF NOT EXISTS "projects" (
    "id"                          SERIAL          PRIMARY KEY,
    "company_id"                  INTEGER         NOT NULL REFERENCES "companies"("id")     ON UPDATE CASCADE ON DELETE RESTRICT,
    "project_name"                VARCHAR(255)    NOT NULL,
    "deadline_date"               DATE            NOT NULL,
    "service_plan_id"             INTEGER         NOT NULL REFERENCES "service_plans"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "assigned_specialist_user_id" INTEGER                  REFERENCES "users"("id")         ON UPDATE CASCADE ON DELETE SET NULL,
    "created_by_user_id"          INTEGER         NOT NULL REFERENCES "users"("id")         ON UPDATE CASCADE ON DELETE RESTRICT,
    "status"                      "project_status" NOT NULL DEFAULT 'TODO',
    -- How far along the work is, 0–100. NUMERIC(5,2) so half a percent is
    -- expressible, NOT NULL DEFAULT 0 because a project that has not started is
    -- at zero — a fact, not a missing value. Independent of `status`: the two
    -- answer different questions, and a percentage derived from a three-value
    -- enum could only ever report three numbers.
    "progress_bar"                NUMERIC(5,2)    NOT NULL DEFAULT 0,
    "description"                 TEXT,
    "created_at"                  TIMESTAMPTZ     NOT NULL DEFAULT now(),
    "updated_at"                  TIMESTAMPTZ     NOT NULL DEFAULT now(),
    -- Soft delete, matching companies. A project referenced by documents should
    -- leave the lists without vanishing from history.
    "deleted_at"                  TIMESTAMPTZ
);

-- For a table that predates this file (see the provenance note above), the
-- column is added rather than declared.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "progress_bar" NUMERIC(5,2) NOT NULL DEFAULT 0;

-- A blank name passes NOT NULL. This is the constraint that actually means "a
-- project has a name"; the validator enforces the same rule earlier, and this is
-- what holds if anything ever writes around it.
--
-- Both names are checked because the live table already carries the shorter one.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname IN ('projects_name_not_blank', 'projects_project_name_not_blank')
    ) THEN
        ALTER TABLE "projects"
            ADD CONSTRAINT "projects_name_not_blank"
            CHECK (length(btrim("project_name")) > 0);
    END IF;
END $$;

-- The range the progress bar is drawn from. The API validates the same bounds
-- and returns a named field error; this is what holds regardless of who writes.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_progress_bar_check') THEN
        ALTER TABLE "projects"
            ADD CONSTRAINT "projects_progress_bar_check"
            CHECK ("progress_bar" >= 0 AND "progress_bar" <= 100);
    END IF;
END $$;

/*
 * Indexes.
 *
 * The three that carry a soft-delete predicate are PARTIAL on purpose: every
 * read in this feature filters `deleted_at IS NULL`, so indexing only live rows
 * keeps removed projects out of the index entirely rather than merely out of the
 * result. The `IF NOT EXISTS` guards mean the equivalents already present on the
 * live table are left exactly as they are.
 */
CREATE INDEX IF NOT EXISTS "projects_company_id_idx"     ON "projects"("company_id")                  WHERE "deleted_at" IS NULL;
-- "my projects", for a specialist.
CREATE INDEX IF NOT EXISTS "projects_specialist_idx"     ON "projects"("assigned_specialist_user_id");
CREATE INDEX IF NOT EXISTS "projects_created_by_idx"     ON "projects"("created_by_user_id");
CREATE INDEX IF NOT EXISTS "projects_service_plan_idx"   ON "projects"("service_plan_id");
-- Composite, in this order, because the question asked of it is always "what is
-- open, soonest first" — status narrows, deadline sorts.
CREATE INDEX IF NOT EXISTS "projects_status_deadline_idx" ON "projects"("status", "deadline_date")    WHERE "deleted_at" IS NULL;

COMMIT;
