-- 12_link_company_to_customer.sql
--
-- Give `companies` the missing foreign key to `customers`.
--
-- The two tables have always described the same hierarchy — a customer account,
-- and the companies onboarded under it — but nothing in the schema said so. The
-- only thing joining them was that both happened to reference the same
-- `owner_user_id`, which is an accident of the data rather than a rule the
-- database enforces. That left two questions unanswerable in SQL: "which
-- companies belong to this customer?" and "is this company part of that
-- customer?".
--
-- The relationship is one customer -> many companies. `customers.owner_user_id`
-- is UNIQUE (one customer per owner) while `companies.owner_user_id` is not (an
-- owner may hold several companies), so the customer is the parent.
--
-- Nullable, deliberately:
--   * a company created before this migration whose owner never completed
--     customer provisioning has no customer to point at, and inventing one would
--     be worse than recording the truth;
--   * ON DELETE RESTRICT would then be the only safe option on a NOT NULL column,
--     which would make a customer undeletable for reasons unrelated to billing.
-- New companies always get one set by the application.

BEGIN;

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "customer_id" INTEGER;

/*
 * Backfill from the shared owner. This is exactly the implicit rule the
 * application has been relying on all along, written down once: a company
 * belongs to the customer account owned by the same user.
 */
UPDATE "companies" c
   SET "customer_id" = cu."id"
  FROM "customers" cu
 WHERE cu."owner_user_id" = c."owner_user_id"
   AND c."customer_id" IS NULL;

DO $$
DECLARE
  linked   INTEGER;
  unlinked INTEGER;
BEGIN
  SELECT COUNT(*) INTO linked   FROM "companies" WHERE "customer_id" IS NOT NULL;
  SELECT COUNT(*) INTO unlinked FROM "companies" WHERE "customer_id" IS NULL;
  RAISE NOTICE 'companies linked to a customer: %, still unlinked: %', linked, unlinked;
END $$;

-- RESTRICT: a customer that still has companies under it must not be deleted out
-- from beneath them, which would orphan every subscription and payment hanging
-- off those companies.
DO $$ BEGIN
  ALTER TABLE "companies"
    ADD CONSTRAINT "companies_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "companies_customer_id_idx" ON "companies"("customer_id");

COMMIT;
