-- 14_add_company_specialist_columns.sql
--
-- Give `companies` a standing specialist per service line: bookkeeping, payroll,
-- and tax. Three nullable user references, one per column.
--
-- Why columns and not rows in company_specialist_assignments: the two answer
-- different questions. The assignment table is the record of specialist WORK —
-- many rows per company, keyed by specialization, with assignment_status and
-- unassigned_at so history survives. These columns answer "who is the ONE
-- bookkeeping specialist on this account right now", which is what the admin
-- company-accounts grid renders as three columns. Deriving that from the
-- assignment table would mean picking a winner whenever a company has two active
-- assignments for the same specialization, and the table deliberately allows
-- that. A single column is what "exactly one" means.
--
-- Nullable because a company can be unstaffed for a line, and that is a truthful
-- state — the same reason accounting_manager_user_id is nullable. ON DELETE SET
-- NULL for the same reason too: deleting a staff account should clear the link,
-- not block the delete or orphan the row.
--
-- The columns themselves were added by hand in the Supabase SQL editor; this
-- file is the record of that change and adds the foreign keys and indexes that
-- were not part of it. Every statement is guarded, so running it against a
-- database that already has the columns is a no-op.

ALTER TABLE "companies"
    ADD COLUMN IF NOT EXISTS "bookkeeping_specialist_user_id" INTEGER,
    ADD COLUMN IF NOT EXISTS "payroll_specialist_user_id"     INTEGER,
    ADD COLUMN IF NOT EXISTS "tax_specialist_user_id"         INTEGER;

-- Foreign keys. ADD CONSTRAINT has no IF NOT EXISTS, hence the lookup.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_bookkeeping_specialist_user_id_fkey') THEN
        ALTER TABLE "companies"
            ADD CONSTRAINT "companies_bookkeeping_specialist_user_id_fkey"
            FOREIGN KEY ("bookkeeping_specialist_user_id") REFERENCES "users"("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_payroll_specialist_user_id_fkey') THEN
        ALTER TABLE "companies"
            ADD CONSTRAINT "companies_payroll_specialist_user_id_fkey"
            FOREIGN KEY ("payroll_specialist_user_id") REFERENCES "users"("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_tax_specialist_user_id_fkey') THEN
        ALTER TABLE "companies"
            ADD CONSTRAINT "companies_tax_specialist_user_id_fkey"
            FOREIGN KEY ("tax_specialist_user_id") REFERENCES "users"("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END
$$;

-- Indexed for the same reason accounting_manager_user_id is: "which companies is
-- this specialist on" is a question the staff screens ask.
CREATE INDEX IF NOT EXISTS "companies_bookkeeping_specialist_user_id_idx"
    ON "companies"("bookkeeping_specialist_user_id");
CREATE INDEX IF NOT EXISTS "companies_payroll_specialist_user_id_idx"
    ON "companies"("payroll_specialist_user_id");
CREATE INDEX IF NOT EXISTS "companies_tax_specialist_user_id_idx"
    ON "companies"("tax_specialist_user_id");
