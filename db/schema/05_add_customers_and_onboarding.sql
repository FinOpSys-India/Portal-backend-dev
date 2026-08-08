-- Post-signup onboarding: customer accounts + owner linkage, and the user
-- profile fields collected by the onboarding form.
--
-- Written in the same defensive style as the earlier migrations: every
-- statement is a no-op when the object already exists, so this both builds the
-- objects from scratch on a fresh database and brings a hand-drifted one up to
-- date.

-- CreateTable
CREATE TABLE IF NOT EXISTS "customers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "address_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one customer per owner (makes ownership one-to-one).
CREATE UNIQUE INDEX IF NOT EXISTS "customers_owner_user_id_key" ON "customers"("owner_user_id");

-- AlterTable: onboarding profile + membership link on users.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "customer_id" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(30);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "job_title" VARCHAR(150);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_customer_id_idx" ON "users"("customer_id");

-- AddForeignKey: customer -> owning user (RESTRICT: can't delete an owner).
DO $$
BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AddForeignKey: customer -> address (optional).
DO $$
BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_address_id_fkey"
    FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AddForeignKey: user -> customer they belong to (optional membership link).
DO $$
BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
