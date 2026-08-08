-- 13_drop_customers.sql
--
-- Remove the `customers` table and both columns that pointed at it.
--
-- The account layer was a tenant sitting between a user and their companies:
-- one customer per owner (customers.owner_user_id was UNIQUE), many companies
-- per customer. Because of that uniqueness the customer was fully determined by
-- the owner, so `companies.customer_id` never carried information that
-- `companies.owner_user_id` did not already carry. Two columns, one fact.
--
-- Nothing else depended on it. Subscriptions, subscription items and payments
-- hang off `company_id`; Stripe billing is per company via
-- `companies.stripe_customer_id` (an entirely different "customer" — Stripe's,
-- not ours, and untouched here). Roles come from the invitation at sign-up, not
-- from account provisioning. So the table can go without rehoming any data.
--
-- What this gives up, stated plainly: there is no longer a grouping above the
-- company. A user who owns three companies has three independent companies, not
-- one account holding three. Restoring that later means a new table and a
-- backfill from owner_user_id — recoverable, but not free.
--
-- Ownership now lives in exactly one place: companies.owner_user_id.
--
-- IRREVERSIBLE: dropping the table destroys every customer row. Take a dump
-- first if the data matters.

BEGIN;

-- Report what is about to be destroyed, so an operator running this against the
-- wrong database sees the row count before the COMMIT rather than after.
DO $$
DECLARE
  customer_rows INTEGER;
  linked_users  INTEGER;
BEGIN
  SELECT COUNT(*) INTO customer_rows FROM "customers";
  SELECT COUNT(*) INTO linked_users  FROM "users" WHERE "customer_id" IS NOT NULL;
  RAISE NOTICE 'dropping customers: % row(s); clearing customer_id on % user(s)', customer_rows, linked_users;
END $$;

-- Drop the dependants before the parent. Each column takes its own FK and index
-- with it, so the constraints are not named individually.
ALTER TABLE "companies" DROP COLUMN IF EXISTS "customer_id";
ALTER TABLE "users"     DROP COLUMN IF EXISTS "customer_id";

DROP TABLE IF EXISTS "customers";

COMMIT;
