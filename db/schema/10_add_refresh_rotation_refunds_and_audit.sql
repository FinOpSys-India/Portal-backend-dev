-- 10_add_refresh_rotation_refunds_and_audit.sql
--
-- Three additions, all backward compatible (every new column is nullable or has
-- a default, so existing rows stay valid and the previous application version
-- keeps working against this schema):
--
--   1. Refresh-token rotation + reuse detection. Until now refresh tokens were
--      minted and stored but never consumed — there was no /auth/refresh — so a
--      session could not be renewed or revoked. Rotation makes each token
--      single-use; reuse detection turns a replayed token into a signal that it
--      was stolen, and revokes the whole family rather than the one row.
--
--   2. Refund tracking on company_payments. PaymentStatus.REFUNDED existed in
--      the enum but nothing ever wrote it, so a refunded invoice still displayed
--      as PAID and the billing history contradicted the customer's statement.
--
--   3. A one-active-challenge-per-(user, purpose) partial unique index. That
--      rule was previously enforced only in application code, so two concurrent
--      requests could leave two live OTPs for one account.
--
-- Run against the live database by hand, as with every other file in db/schema.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. refresh-token rotation + reuse detection                                */
/* -------------------------------------------------------------------------- */

-- Every token descended from one login shares a family id. On reuse of an
-- already-rotated token, the entire family is revoked: the legitimate holder and
-- the thief both lose the session, which is the correct outcome because we
-- cannot tell which one presented it.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "family_id" UUID;

-- The token this one was rotated into. NULL means "this is the current token in
-- its family". A non-NULL value on a token being presented is exactly the reuse
-- signal.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "replaced_by_id" INTEGER;

-- Why a session ended, for after-the-fact investigation. Deliberately a short
-- machine string, never free text.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "revoked_reason" VARCHAR(50);

-- Keyed hashes of the requesting context, never the values in the clear — same
-- treatment as login_challenges.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "created_ip_hash" VARCHAR(64);
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "user_agent_hash" VARCHAR(64);

ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ(6);

-- Backfill: give every pre-existing token its own family, so a token minted
-- before this migration still rotates correctly instead of tripping the
-- reuse check on its first use.
UPDATE "refresh_tokens" SET "family_id" = gen_random_uuid() WHERE "family_id" IS NULL;

DO $$ BEGIN
  ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey"
    FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The family-wide revoke reads by family_id, so it must be indexed.
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

/* -------------------------------------------------------------------------- */
/* 2. refunds on company_payments                                             */
/* -------------------------------------------------------------------------- */

-- Tracked separately from amount_paid rather than by mutating it: the receipt of
-- what was charged must stay true, and a partial refund has to be expressible
-- without rewriting history.
ALTER TABLE "company_payments"
  ADD COLUMN IF NOT EXISTS "amount_refunded" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "company_payments" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ(6);
ALTER TABLE "company_payments" ADD COLUMN IF NOT EXISTS "stripe_charge_id" VARCHAR(255);

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

-- The refund webhook identifies the payment by charge, which we did not store.
CREATE INDEX IF NOT EXISTS "company_payments_stripe_charge_id_idx"
  ON "company_payments"("stripe_charge_id");

/* -------------------------------------------------------------------------- */
/* 3. one active OTP challenge per (user, purpose)                            */
/* -------------------------------------------------------------------------- */

-- Prisma cannot express a partial unique index, so it lives here. The
-- application already invalidates the previous challenge in the same
-- transaction; this makes that a hard guarantee rather than a convention, so two
-- concurrent logins cannot leave two live codes for one account.
--
-- Created CONCURRENTLY is not possible inside a transaction block; this table is
-- small and the lock is brief.
CREATE UNIQUE INDEX IF NOT EXISTS "login_challenges_one_active_per_user_purpose"
  ON "login_challenges"("user_id", "purpose")
  WHERE "used_at" IS NULL AND "invalidated_at" IS NULL;

COMMIT;
