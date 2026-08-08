-- Company onboarding: companies + address mapping, the specialization catalog,
-- specialist assignments, and the idempotency ledger. Also adds country_code to
-- the shared addresses table (collected by the company onboarding form).
--
-- Written in the same defensive style as the earlier migrations: every statement
-- is a no-op when the object already exists (IF NOT EXISTS, or a DO block that
-- swallows duplicate_object), so this both builds from scratch on a fresh
-- database and brings a hand-drifted one up to date.

-- CreateEnum: company_status
DO $$ BEGIN
  CREATE TYPE "company_status" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: company_type
DO $$ BEGIN
  CREATE TYPE "company_type" AS ENUM (
    'SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LIMITED_LIABILITY_COMPANY',
    'C_CORPORATION', 'S_CORPORATION', 'NON_PROFIT', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: company_address_type
DO $$ BEGIN
  CREATE TYPE "company_address_type" AS ENUM ('BUSINESS', 'BILLING', 'MAILING', 'REGISTERED', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: assignment_status
DO $$ BEGIN
  CREATE TYPE "assignment_status" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable: address country code (nullable so existing rows stay valid).
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "country_code" VARCHAR(2);

-- CreateTable: companies
CREATE TABLE IF NOT EXISTS "companies" (
    "id" SERIAL NOT NULL,
    "company_name" VARCHAR(255) NOT NULL,
    "company_type" "company_type" NOT NULL,
    "company_email" VARCHAR(255) NOT NULL,
    "company_phone" VARCHAR(30) NOT NULL,
    "employee_count" INTEGER NOT NULL,
    "last_year_revenue" DECIMAL(18,2) NOT NULL,
    "revenue_currency" CHAR(3) NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "accounting_manager_user_id" INTEGER,
    "status" "company_status" NOT NULL DEFAULT 'ONBOARDING',
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- Non-negativity guards. Prisma cannot express CHECKs in-schema, so they live here.
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_employee_count_nonneg" CHECK ("employee_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_last_year_revenue_nonneg" CHECK ("last_year_revenue" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One owner may own many companies -> indexed, NOT unique.
CREATE INDEX IF NOT EXISTS "companies_owner_user_id_idx" ON "companies"("owner_user_id");
CREATE INDEX IF NOT EXISTS "companies_accounting_manager_user_id_idx" ON "companies"("accounting_manager_user_id");
CREATE INDEX IF NOT EXISTS "companies_status_idx" ON "companies"("status");

-- CreateTable: company_addresses
CREATE TABLE IF NOT EXISTS "company_addresses" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "address_id" INTEGER NOT NULL,
    "address_type" "company_address_type" NOT NULL DEFAULT 'BUSINESS',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_addresses_pkey" PRIMARY KEY ("id")
);

-- Same address cannot be linked to a company twice under one type.
CREATE UNIQUE INDEX IF NOT EXISTS "company_addresses_company_id_address_id_address_type_key"
    ON "company_addresses"("company_id", "address_id", "address_type");
-- At most ONE primary address per company (partial unique — the "one primary" rule).
CREATE UNIQUE INDEX IF NOT EXISTS "company_addresses_one_primary_per_company"
    ON "company_addresses"("company_id") WHERE "is_primary";
CREATE INDEX IF NOT EXISTS "company_addresses_company_id_idx" ON "company_addresses"("company_id");
CREATE INDEX IF NOT EXISTS "company_addresses_address_id_idx" ON "company_addresses"("address_id");

-- CreateTable: specializations
CREATE TABLE IF NOT EXISTS "specializations" (
    "id" SERIAL NOT NULL,
    "specialization_code" VARCHAR(50) NOT NULL,
    "specialization_name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specializations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "specializations_specialization_code_key"
    ON "specializations"("specialization_code");

-- Seed the four business specializations. Idempotent; seed.js also upserts these,
-- so a fresh `migrate deploy` has them even before the seed runs.
INSERT INTO "specializations" ("specialization_code", "specialization_name") VALUES
    ('BOOKKEEPING', 'Bookkeeping'),
    ('PAYROLL', 'Payroll'),
    ('TAX', 'Tax'),
    ('FA_Q', 'FA and Q')
ON CONFLICT ("specialization_code") DO NOTHING;

-- CreateTable: company_specialist_assignments
CREATE TABLE IF NOT EXISTS "company_specialist_assignments" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "specialist_user_id" INTEGER NOT NULL,
    "specialization_id" INTEGER NOT NULL,
    "assignment_status" "assignment_status" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_specialist_assignments_pkey" PRIMARY KEY ("id")
);

-- No two ACTIVE assignments for the same (company, specialist, specialization).
-- Partial so a soft-removed (INACTIVE) row does not block re-assigning later.
CREATE UNIQUE INDEX IF NOT EXISTS "csa_active_company_specialist_specialization_key"
    ON "company_specialist_assignments"("company_id", "specialist_user_id", "specialization_id")
    WHERE "assignment_status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "csa_company_id_idx" ON "company_specialist_assignments"("company_id");
CREATE INDEX IF NOT EXISTS "csa_specialist_user_id_idx" ON "company_specialist_assignments"("specialist_user_id");
CREATE INDEX IF NOT EXISTS "csa_specialization_id_idx" ON "company_specialist_assignments"("specialization_id");

-- CreateTable: idempotency_keys
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" SERIAL NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "company_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_user_id_idempotency_key_key"
    ON "idempotency_keys"("user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idempotency_keys_user_id_idx" ON "idempotency_keys"("user_id");

-- AddForeignKey: companies -> owning user (RESTRICT: can't delete an owner).
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: companies -> accounting manager (SET NULL when the user is gone).
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_accounting_manager_user_id_fkey"
    FOREIGN KEY ("accounting_manager_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: company_addresses -> companies (CASCADE) and addresses (RESTRICT).
DO $$ BEGIN
  ALTER TABLE "company_addresses" ADD CONSTRAINT "company_addresses_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_addresses" ADD CONSTRAINT "company_addresses_address_id_fkey"
    FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: company_specialist_assignments -> companies, users, specializations.
DO $$ BEGIN
  ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "csa_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "csa_specialist_user_id_fkey"
    FOREIGN KEY ("specialist_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "csa_specialization_id_fkey"
    FOREIGN KEY ("specialization_id") REFERENCES "specializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: idempotency_keys -> users (CASCADE).
DO $$ BEGIN
  ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
