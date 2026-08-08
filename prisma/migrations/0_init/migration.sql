-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('INVITED', 'ACTIVE', 'HIBERNATED');

-- CreateEnum
CREATE TYPE "challenge_purpose" AS ENUM ('LOGIN_EMAIL_OTP', 'PASSWORD_RESET_EMAIL_OTP');

-- CreateEnum
CREATE TYPE "otp_delivery_status" AS ENUM ('QUEUED', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "company_type" AS ENUM ('SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LIMITED_LIABILITY_COMPANY', 'C_CORPORATION', 'S_CORPORATION', 'NON_PROFIT', 'OTHER');

-- CreateEnum
CREATE TYPE "company_address_type" AS ENUM ('BUSINESS', 'BILLING', 'MAILING', 'REGISTERED', 'OTHER');

-- CreateEnum
CREATE TYPE "assignment_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specific_roles" (
    "id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specific_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" SERIAL NOT NULL,
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(120),
    "postal_code" VARCHAR(20),
    "country" VARCHAR(100) NOT NULL,
    "country_code" VARCHAR(2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255),
    "role_id" INTEGER NOT NULL,
    "specific_role_id" INTEGER,
    "address_id" INTEGER,
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "hibernated_at" TIMESTAMPTZ(6),
    "phone" VARCHAR(30),
    "job_title" VARCHAR(150),
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip_hash" VARCHAR(64),
    "password_changed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "family_id" UUID,
    "replaced_by_id" INTEGER,
    "revoked_reason" VARCHAR(50),
    "created_ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "role_id" INTEGER NOT NULL,
    "specific_role_id" INTEGER,
    "invited_by" INTEGER NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "purpose" "challenge_purpose" NOT NULL DEFAULT 'LOGIN_EMAIL_OTP',
    "otp_digest" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "invalidated_at" TIMESTAMPTZ(6),
    "delivery_status" "otp_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "request_ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tickets" (
    "id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "challenge_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "request_ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
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
    "stripe_customer_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_addresses" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "address_id" INTEGER NOT NULL,
    "address_type" "company_address_type" NOT NULL DEFAULT 'BUSINESS',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specializations" (
    "id" SERIAL NOT NULL,
    "specialization_code" VARCHAR(50) NOT NULL,
    "specialization_name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specializations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_specialist_assignments" (
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

-- CreateTable
CREATE TABLE "idempotency_keys" (
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

-- CreateTable
CREATE TABLE "service_plans" (
    "id" SERIAL NOT NULL,
    "specialization_id" INTEGER,
    "plan_code" VARCHAR(50) NOT NULL,
    "plan_name" VARCHAR(150) NOT NULL,
    "stripe_product_id" VARCHAR(255) NOT NULL,
    "stripe_price_id" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "billing_interval" "billing_interval" NOT NULL DEFAULT 'MONTH',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_add_on" BOOLEAN NOT NULL DEFAULT false,
    "quantity_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quantity_label" VARCHAR(100),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_subscriptions" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "stripe_subscription_id" VARCHAR(255),
    "stripe_checkout_session_id" VARCHAR(255),
    "status" "subscription_status" NOT NULL DEFAULT 'INCOMPLETE',
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "last_stripe_event_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_subscription_items" (
    "id" SERIAL NOT NULL,
    "company_subscription_id" INTEGER NOT NULL,
    "service_plan_id" INTEGER NOT NULL,
    "stripe_subscription_item_id" VARCHAR(255),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_subscription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_payments" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "company_subscription_id" INTEGER,
    "stripe_invoice_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount_refunded" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMPTZ(6),
    "stripe_charge_id" VARCHAR(255),
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" SERIAL NOT NULL,
    "stripe_event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "specific_roles_role_id_code_key" ON "specific_roles"("role_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "specific_roles_id_role_id_key" ON "specific_roles"("id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "login_challenges_user_id_idx" ON "login_challenges"("user_id");

-- CreateIndex
CREATE INDEX "login_challenges_expires_at_idx" ON "login_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tickets_challenge_id_key" ON "password_reset_tickets"("challenge_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tickets_token_hash_key" ON "password_reset_tickets"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tickets_user_id_idx" ON "password_reset_tickets"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tickets_expires_at_idx" ON "password_reset_tickets"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "companies_stripe_customer_id_key" ON "companies"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "companies_owner_user_id_idx" ON "companies"("owner_user_id");

-- CreateIndex
CREATE INDEX "companies_accounting_manager_user_id_idx" ON "companies"("accounting_manager_user_id");

-- CreateIndex
CREATE INDEX "companies_status_idx" ON "companies"("status");

-- CreateIndex
CREATE INDEX "company_addresses_company_id_idx" ON "company_addresses"("company_id");

-- CreateIndex
CREATE INDEX "company_addresses_address_id_idx" ON "company_addresses"("address_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_addresses_company_id_address_id_address_type_key" ON "company_addresses"("company_id", "address_id", "address_type");

-- CreateIndex
CREATE UNIQUE INDEX "specializations_specialization_code_key" ON "specializations"("specialization_code");

-- CreateIndex
CREATE INDEX "company_specialist_assignments_company_id_idx" ON "company_specialist_assignments"("company_id");

-- CreateIndex
CREATE INDEX "company_specialist_assignments_specialist_user_id_idx" ON "company_specialist_assignments"("specialist_user_id");

-- CreateIndex
CREATE INDEX "company_specialist_assignments_specialization_id_idx" ON "company_specialist_assignments"("specialization_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_user_id_idx" ON "idempotency_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_idempotency_key_key" ON "idempotency_keys"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_plans_plan_code_key" ON "service_plans"("plan_code");

-- CreateIndex
CREATE UNIQUE INDEX "service_plans_stripe_price_id_key" ON "service_plans"("stripe_price_id");

-- CreateIndex
CREATE INDEX "service_plans_specialization_id_idx" ON "service_plans"("specialization_id");

-- CreateIndex
CREATE INDEX "service_plans_stripe_product_id_idx" ON "service_plans"("stripe_product_id");

-- CreateIndex
CREATE INDEX "service_plans_is_active_idx" ON "service_plans"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "company_subscriptions_stripe_subscription_id_key" ON "company_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_subscriptions_stripe_checkout_session_id_key" ON "company_subscriptions"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "company_subscriptions_company_id_idx" ON "company_subscriptions"("company_id");

-- CreateIndex
CREATE INDEX "company_subscriptions_status_idx" ON "company_subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "company_subscription_items_stripe_subscription_item_id_key" ON "company_subscription_items"("stripe_subscription_item_id");

-- CreateIndex
CREATE INDEX "company_subscription_items_company_subscription_id_idx" ON "company_subscription_items"("company_subscription_id");

-- CreateIndex
CREATE INDEX "company_subscription_items_service_plan_id_idx" ON "company_subscription_items"("service_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_subscription_items_company_subscription_id_service__key" ON "company_subscription_items"("company_subscription_id", "service_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_payments_stripe_invoice_id_key" ON "company_payments"("stripe_invoice_id");

-- CreateIndex
-- MOVED: this index must be PARTIAL. See the hand-written section at the end of this file.

-- CreateIndex
CREATE INDEX "company_payments_company_id_idx" ON "company_payments"("company_id");

-- CreateIndex
CREATE INDEX "company_payments_company_subscription_id_idx" ON "company_payments"("company_subscription_id");

-- CreateIndex
CREATE INDEX "company_payments_status_idx" ON "company_payments"("status");

-- CreateIndex
CREATE INDEX "company_payments_paid_at_idx" ON "company_payments"("paid_at");

-- CreateIndex
CREATE INDEX "company_payments_stripe_charge_id_idx" ON "company_payments"("stripe_charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "stripe_events_event_type_idx" ON "stripe_events"("event_type");

-- AddForeignKey
ALTER TABLE "specific_roles" ADD CONSTRAINT "specific_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_specific_role_id_role_id_fkey" FOREIGN KEY ("specific_role_id", "role_id") REFERENCES "specific_roles"("id", "role_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_specific_role_id_role_id_fkey" FOREIGN KEY ("specific_role_id", "role_id") REFERENCES "specific_roles"("id", "role_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tickets" ADD CONSTRAINT "password_reset_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_accounting_manager_user_id_fkey" FOREIGN KEY ("accounting_manager_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_addresses" ADD CONSTRAINT "company_addresses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_addresses" ADD CONSTRAINT "company_addresses_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "company_specialist_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "company_specialist_assignments_specialist_user_id_fkey" FOREIGN KEY ("specialist_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_specialist_assignments" ADD CONSTRAINT "company_specialist_assignments_specialization_id_fkey" FOREIGN KEY ("specialization_id") REFERENCES "specializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_specialization_id_fkey" FOREIGN KEY ("specialization_id") REFERENCES "specializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_subscription_items" ADD CONSTRAINT "company_subscription_items_company_subscription_id_fkey" FOREIGN KEY ("company_subscription_id") REFERENCES "company_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_subscription_items" ADD CONSTRAINT "company_subscription_items_service_plan_id_fkey" FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_company_subscription_id_fkey" FOREIGN KEY ("company_subscription_id") REFERENCES "company_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- HAND-WRITTEN SECTION — do not remove.
--
-- Everything below is copied verbatim from db/schema/06..10. Prisma cannot
-- express any of it in schema.prisma, so `prisma migrate diff` will never
-- regenerate it: it has to be carried forward by hand into every baseline.
-- Dropping this block does not fail loudly — the tables still build, and the
-- rules they enforce are simply gone.
--
-- The DO $$ ... EXCEPTION WHEN duplicate_object $$ wrappers and the
-- IF NOT EXISTS clauses are kept so re-running the file is safe.
-- ---------------------------------------------------------------------------

-- 1..8: non-negativity guards, and the refund ceiling.
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_employee_count_nonneg" CHECK ("employee_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_last_year_revenue_nonneg" CHECK ("last_year_revenue" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_amount_nonneg" CHECK ("amount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_quantity_nonneg" CHECK ("quantity" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_unit_amount_nonneg" CHECK ("unit_amount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_amount_paid_nonneg" CHECK ("amount_paid" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_payments"
    ADD CONSTRAINT "company_payments_amount_refunded_nonneg" CHECK ("amount_refunded" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A refund can never exceed what was actually charged. Enforced here because the
-- amounts arrive from Stripe webhooks that may be delivered out of order.
DO $$ BEGIN
  ALTER TABLE "company_payments"
    ADD CONSTRAINT "company_payments_refund_not_over_paid"
    CHECK ("amount_refunded" <= "amount_paid");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 9..13: partial and functional unique indexes. A plain @@unique in
-- schema.prisma is NOT equivalent to any of these — it would apply to every
-- row, including the soft-deleted and inactive ones these deliberately skip.

-- At most ONE primary address per company.
CREATE UNIQUE INDEX IF NOT EXISTS "company_addresses_one_primary_per_company"
    ON "company_addresses"("company_id") WHERE "is_primary";

-- No two ACTIVE assignments for the same (company, specialist, specialization).
-- Partial so a soft-removed (INACTIVE) row does not block re-assigning later.
CREATE UNIQUE INDEX IF NOT EXISTS "csa_active_company_specialist_specialization_key"
    ON "company_specialist_assignments"("company_id", "specialist_user_id", "specialization_id")
    WHERE "assignment_status" = 'ACTIVE';

-- One row per Stripe PaymentIntent, where one exists. This replaces the FULL
-- unique index Prisma generated above (same name) — the partial form is what the
-- database actually has, and it is the guard against a redelivered
-- payment_intent.succeeded creating a duplicate receipt.
CREATE UNIQUE INDEX IF NOT EXISTS "company_payments_stripe_payment_intent_id_key"
    ON "company_payments"("stripe_payment_intent_id")
    WHERE "stripe_payment_intent_id" IS NOT NULL;

-- Company email unique among LIVE companies only, and case-insensitively.
-- Note lower(): this is a functional index, which Prisma cannot express either.
CREATE UNIQUE INDEX IF NOT EXISTS "companies_company_email_key"
    ON "companies" (lower("company_email"))
    WHERE "deleted_at" IS NULL;

-- One live OTP challenge per (user, purpose).
CREATE UNIQUE INDEX IF NOT EXISTS "login_challenges_one_active_per_user_purpose"
  ON "login_challenges"("user_id", "purpose")
  WHERE "used_at" IS NULL AND "invalidated_at" IS NULL;
