-- Service selection and Stripe Checkout: the columns the multi-service checkout
-- flow needs on top of 07.
--
-- Three things, all additive:
--
--   1. service_plans gains the add-on/quantity columns, so a plan can describe
--      itself as a per-unit line (the payroll W-2 and 1099 components) rather
--      than a flat one, and so the catalog renders in a fixed order.
--   2. company_subscriptions gains last_stripe_event_at, the high-water mark
--      that makes webhook processing safe against out-of-order delivery.
--   3. company_payments.stripe_payment_intent_id becomes unique, which is what
--      makes a one-time (mode: 'payment') checkout idempotent — subscription
--      charges already dedupe on stripe_invoice_id.
--
-- Same defensive style as the earlier migrations: every statement is a no-op
-- when the object already exists, so this builds from scratch on a fresh
-- database and brings a hand-drifted one up to date.
--
-- Nothing here stores card data. Only Stripe identifiers and the amounts that
-- were actually charged.

-- AlterTable: service_plans — describe HOW a plan is sold, not just what it costs.
--
-- is_add_on          sold alongside a base plan rather than on its own
-- quantity_enabled   billed per unit; the quantity comes from a validated,
--                    bounded integer in the request (never a price or a total)
-- quantity_label     the wording shown next to the counter in the UI,
--                    e.g. 'Number of W-2 Employees'
-- display_order      fixes the order tiers are listed in, so re-seeding the
--                    catalog cannot reshuffle the pricing page
ALTER TABLE "service_plans"
    ADD COLUMN IF NOT EXISTS "is_add_on" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "quantity_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "quantity_label" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "display_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: company_subscriptions — out-of-order webhook protection.
--
-- Holds `created` of the newest Stripe event whose STATE has been applied to the
-- row. Stripe retries and network reordering mean an older event can arrive
-- after a newer one; applying it would move the subscription backwards, and a
-- stale 'past_due' landing after 'active' would mark a paying company unpaid
-- with nothing left to correct it — the correct event has already been
-- delivered and acknowledged. Any event older than this mark is skipped.
--
-- Nullable: existing rows have no history to compare against, and a NULL mark
-- simply means "accept the next event", which is the correct behaviour for a
-- subscription created before this column existed.
ALTER TABLE "company_subscriptions"
    ADD COLUMN IF NOT EXISTS "last_stripe_event_at" TIMESTAMPTZ(6);

-- CreateIndex: company_payments.stripe_payment_intent_id, unique.
--
-- PARTIAL (WHERE NOT NULL) on purpose. Subscription charges settle through an
-- invoice and leave this column NULL, and a plain unique index would let only
-- one such row exist. A one-time 'payment' checkout has a PaymentIntent and no
-- invoice, so this is the only thing standing between a redelivered
-- payment_intent.succeeded and a duplicate receipt.
CREATE UNIQUE INDEX IF NOT EXISTS "company_payments_stripe_payment_intent_id_key"
    ON "company_payments"("stripe_payment_intent_id")
    WHERE "stripe_payment_intent_id" IS NOT NULL;
