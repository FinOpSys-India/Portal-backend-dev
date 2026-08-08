-- A company email must be a company's own address, and only one company's.
--
-- Two rules, one of which the database can hold and one of which it cannot:
--
--   1. UNIQUE across companies. Enforced here. company_email is what Stripe is
--      told to invoice and what receipts are sent to, so two companies sharing
--      one is not a cosmetic duplicate — it is two businesses' billing landing
--      in the same inbox.
--   2. NOT a registered user's login email. Enforced in companyService, because
--      a cross-table rule is not something a unique index can express. A login
--      address belongs to a person; reusing it as a company's billing address
--      conflates the two identities the whole role model is built on keeping
--      apart.
--
-- The index is FUNCTIONAL, on lower(company_email). The validator already
-- lower-cases the field, so in practice the values are canonical — but the
-- validator is application code and this is the last line of defence. A row
-- inserted by a seed, a fixture, or a hand-written statement must not be able to
-- slip 'Billing@acme.com' past a plain unique index that already holds
-- 'billing@acme.com'.
--
-- And PARTIAL, on deleted_at IS NULL. Companies are soft-deleted; an archived
-- company must not hold its address hostage forever, or a business that closes
-- and re-registers can never use its own email again.
--
-- Same defensive style as the earlier files: IF NOT EXISTS, so re-running this
-- is a no-op.
--
-- If this fails with "could not create unique index", the table already holds
-- duplicates. Find them first:
--
--   SELECT lower(company_email), count(*) FROM companies
--    WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "companies_company_email_key"
    ON "companies" (lower("company_email"))
    WHERE "deleted_at" IS NULL;
