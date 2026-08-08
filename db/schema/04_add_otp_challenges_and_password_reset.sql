-- Email-OTP challenges and the password-reset flow.
--
-- The login_challenges table and its two enums were added to schema.prisma
-- without a migration and reached the dev database by hand, so every statement
-- here is written to be a no-op when the object already exists. That way this
-- migration both brings a drifted database up to date and builds the same
-- objects from scratch on a fresh one.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "challenge_purpose" AS ENUM ('LOGIN_EMAIL_OTP', 'PASSWORD_RESET_EMAIL_OTP');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterEnum: no-op where the type was just created with both values.
ALTER TYPE "challenge_purpose" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_EMAIL_OTP';

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "otp_delivery_status" AS ENUM ('QUEUED', 'DELIVERED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "login_challenges" (
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "login_challenges_user_id_idx" ON "login_challenges"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "login_challenges_expires_at_idx" ON "login_challenges"("expires_at");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE IF NOT EXISTS "password_reset_tickets" (
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

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tickets_challenge_id_key" ON "password_reset_tickets"("challenge_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tickets_token_hash_key" ON "password_reset_tickets"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "password_reset_tickets_user_id_idx" ON "password_reset_tickets"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "password_reset_tickets_expires_at_idx" ON "password_reset_tickets"("expires_at");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "password_reset_tickets" ADD CONSTRAINT "password_reset_tickets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
