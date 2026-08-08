-- Stripe billing: the local plan catalog, per-company subscriptions and their
-- line items, the invoice ledger, and the webhook idempotency table. Also adds
-- stripe_customer_id to companies.
--
-- Written in the same defensive style as the earlier migrations: every statement
-- is a no-op when the object already exists (IF NOT EXISTS, or a DO block that
-- swallows duplicate_object), so this both builds from scratch on a fresh
-- database and brings a hand-drifted one up to date.
--
-- Billing model. The Stripe Customer belongs to the COMPANY, not the user: one
-- user owns many companies and each pays for its own service, so a per-user
-- customer would merge two companies' billing and make "is THIS company paid?"
-- unanswerable. A company holds at most one ACTIVE subscription, carrying one
-- line item per service it bought (Bookkeeping, Payroll, Tax, FA_Q) — that is
-- how Stripe models a multi-service plan, and it keeps a single renewal date.
--
-- Nothing here stores card data. Only Stripe identifiers and the amounts that
-- were actually charged.

-- CreateEnum: billing_interval
DO $$ BEGIN
  CREATE TYPE "billing_interval" AS ENUM ('MONTH', 'YEAR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: subscription_status — mirrors Stripe's subscription.status, so a
-- webhook can be applied by mapping the value straight across.
DO $$ BEGIN
  CREATE TYPE "subscription_status" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: payment_status
DO $$ BEGIN
  CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable: the company's Stripe Customer. Nullable because it is created
-- lazily on first checkout, and unique because a Stripe Customer maps to exactly
-- one company. Postgres unique indexes ignore NULLs, so every not-yet-billed
-- company can sit at NULL without colliding.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "stripe_customer_id" VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS "companies_stripe_customer_id_key"
    ON "companies"("stripe_customer_id");

-- CreateTable: service_plans
-- Local catalog of the Stripe Products/Prices that are sellable. `plan_code` is
-- OUR identifier — the frontend sends that and nothing else; the price id is
-- resolved here, server-side. Accepting a price or an amount from the request
-- body would let a client subscribe to a premium tier at basic pricing.
CREATE TABLE IF NOT EXISTS "service_plans" (
    "id" SERIAL NOT NULL,
    "specialization_id" INTEGER,
    "plan_code" VARCHAR(50) NOT NULL,
    "plan_name" VARCHAR(150) NOT NULL,
    "stripe_product_id" VARCHAR(255) NOT NULL,
    "stripe_price_id" VARCHAR(255) NOT NULL,
    -- Display cache only. Stripe owns real pricing; re-sync when it changes.
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "billing_interval" "billing_interval" NOT NULL DEFAULT 'MONTH',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_plans_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_amount_nonneg" CHECK ("amount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "service_plans_plan_code_key" ON "service_plans"("plan_code");
-- One row per Stripe Price. Guards against seeding the same price twice under
-- two plan codes, which would silently create two plans that charge the same.
CREATE UNIQUE INDEX IF NOT EXISTS "service_plans_stripe_price_id_key" ON "service_plans"("stripe_price_id");
CREATE INDEX IF NOT EXISTS "service_plans_specialization_id_idx" ON "service_plans"("specialization_id");
CREATE INDEX IF NOT EXISTS "service_plans_stripe_product_id_idx" ON "service_plans"("stripe_product_id");
CREATE INDEX IF NOT EXISTS "service_plans_is_active_idx" ON "service_plans"("is_active");

-- CreateTable: company_subscriptions
CREATE TABLE IF NOT EXISTS "company_subscriptions" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "stripe_subscription_id" VARCHAR(255),
    -- The Checkout Session that created this row. Written BEFORE the redirect,
    -- so an abandoned checkout is visible as INCOMPLETE rather than invisible,
    -- and so the completed webhook can find the row it belongs to.
    "stripe_checkout_session_id" VARCHAR(255),
    "status" "subscription_status" NOT NULL DEFAULT 'INCOMPLETE',
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_stripe_subscription_id_key"
    ON "company_subscriptions"("stripe_subscription_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_stripe_checkout_session_id_key"
    ON "company_subscriptions"("stripe_checkout_session_id");

-- At most ONE ACTIVE subscription per company. PARTIAL on purpose: a plain
-- UNIQUE(company_id) would let a company subscribe exactly once ever, so a
-- cancelled customer could never come back.
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_one_active_per_company"
    ON "company_subscriptions"("company_id") WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "company_subscriptions_company_id_idx" ON "company_subscriptions"("company_id");
CREATE INDEX IF NOT EXISTS "company_subscriptions_status_idx" ON "company_subscriptions"("status");

-- CreateTable: company_subscription_items
-- One row per service the company bought — this is what makes "Bookkeeping +
-- Payroll on one subscription" work.
CREATE TABLE IF NOT EXISTS "company_subscription_items" (
    "id" SERIAL NOT NULL,
    "company_subscription_id" INTEGER NOT NULL,
    "service_plan_id" INTEGER NOT NULL,
    "stripe_subscription_item_id" VARCHAR(255),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    -- FROZEN at purchase time. Deliberately duplicated from service_plans.amount
    -- rather than joined: raising a price must never rewrite what an existing
    -- subscriber is recorded as paying.
    "unit_amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_subscription_items_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_quantity_nonneg" CHECK ("quantity" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_unit_amount_nonneg" CHECK ("unit_amount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The same plan cannot appear twice on one subscription.
CREATE UNIQUE INDEX IF NOT EXISTS "csi_subscription_id_service_plan_id_key"
    ON "company_subscription_items"("company_subscription_id", "service_plan_id");
CREATE UNIQUE INDEX IF NOT EXISTS "csi_stripe_subscription_item_id_key"
    ON "company_subscription_items"("stripe_subscription_item_id");
CREATE INDEX IF NOT EXISTS "csi_company_subscription_id_idx"
    ON "company_subscription_items"("company_subscription_id");
CREATE INDEX IF NOT EXISTS "csi_service_plan_id_idx" ON "company_subscription_items"("service_plan_id");

-- CreateTable: company_payments
-- The immutable record of money actually charged, one row per Stripe invoice.
-- amount_paid is copied from the invoice and never recalculated from the plan
-- catalog, so historical receipts stay true after a price change.
CREATE TABLE IF NOT EXISTS "company_payments" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "company_subscription_id" INTEGER,
    "stripe_invoice_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(6),
    -- Stripe's decline reason, e.g. 'card_declined'. Short and non-sensitive;
    -- never put a card number or customer PII here.
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_payments_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_amount_paid_nonneg" CHECK ("amount_paid" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per Stripe invoice. This is the idempotency guard for the recurring
-- invoice webhooks, which Stripe may deliver more than once.
CREATE UNIQUE INDEX IF NOT EXISTS "company_payments_stripe_invoice_id_key"
    ON "company_payments"("stripe_invoice_id");
CREATE INDEX IF NOT EXISTS "company_payments_company_id_idx" ON "company_payments"("company_id");
CREATE INDEX IF NOT EXISTS "company_payments_company_subscription_id_idx"
    ON "company_payments"("company_subscription_id");
CREATE INDEX IF NOT EXISTS "company_payments_status_idx" ON "company_payments"("status");
CREATE INDEX IF NOT EXISTS "company_payments_paid_at_idx" ON "company_payments"("paid_at");

-- CreateTable: stripe_events
-- Webhook idempotency ledger. Stripe retries delivery until it gets a 2xx, so
-- the same event WILL arrive twice. The handler inserts the id first and stops
-- on conflict — same trick as idempotency_keys, three columns wide.
CREATE TABLE IF NOT EXISTS "stripe_events" (
    "id" SERIAL NOT NULL,
    "stripe_event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");
CREATE INDEX IF NOT EXISTS "stripe_events_event_type_idx" ON "stripe_events"("event_type");

-- AddForeignKey: service_plans -> specializations (RESTRICT: a specialization
-- that is still sold cannot be deleted).
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_specialization_id_fkey"
    FOREIGN KEY ("specialization_id") REFERENCES "specializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: company_subscriptions -> companies (RESTRICT: never drop a
-- company that still has billing history hanging off it).
DO $$ BEGIN
  ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: company_subscription_items -> subscription (CASCADE: line items
-- have no meaning without their subscription) and service_plans (RESTRICT).
DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_company_subscription_id_fkey"
    FOREIGN KEY ("company_subscription_id") REFERENCES "company_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_subscription_items" ADD CONSTRAINT "csi_service_plan_id_fkey"
    FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey: company_payments -> companies (RESTRICT) and subscription
-- (SET NULL: a payment outlives the subscription it renewed).
DO $$ BEGIN
  ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "company_payments" ADD CONSTRAINT "company_payments_company_subscription_id_fkey"
    FOREIGN KEY ("company_subscription_id") REFERENCES "company_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
