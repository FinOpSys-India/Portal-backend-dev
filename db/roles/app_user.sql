-- Restricted application role.
--
-- Run this ONCE, in the Supabase SQL editor, as an admin (postgres). Then point
-- the app's DATABASE_URL at portal_app instead of postgres.
--
-- Why: the application only ever needs to read and write ROWS. It has no
-- legitimate reason to create, alter, or drop a TABLE. Granting it DDL rights
-- means one stray `prisma migrate dev`, one bad script, or one compromised
-- deployment can reshape or destroy the schema. This role removes the
-- capability rather than relying on everyone remembering not to use it.
--
-- Keep an admin connection string somewhere safe for when you DO want to change
-- the schema by hand (db/schema/*.sql) — just never put it in the app's .env.

-- 1. Create the role. Replace the password before running.
DO $$ BEGIN
  CREATE ROLE portal_app LOGIN PASSWORD 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'role portal_app already exists, skipping create';
END $$;

-- 2. Let it reach the database and see the public schema, but NOT create in it.
--    The revoke matters: in Postgres, PUBLIC has CREATE on the public schema by
--    default on older versions, which would let this role make tables anyway.
GRANT CONNECT ON DATABASE postgres TO portal_app;
GRANT USAGE ON SCHEMA public TO portal_app;
REVOKE CREATE ON SCHEMA public FROM portal_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Row-level access on everything that exists today.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portal_app;

-- 4. Sequences, so SERIAL primary keys can allocate ids on INSERT.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO portal_app;

-- 5. Same rights automatically on any table/sequence YOU create later, so you
--    do not have to re-run step 3 after every hand-written DDL change.
--    Note: "FOR ROLE postgres" must name whichever role actually creates the
--    tables — default privileges are per-creator, not global.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO portal_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO portal_app;

-- 6. Verify. portal_app should have NO create rights on the schema.
--    Expected: has_create = false, can_select_companies = true
SELECT
  pg_catalog.has_schema_privilege('portal_app', 'public', 'CREATE') AS has_create,
  pg_catalog.has_table_privilege('portal_app', 'companies', 'SELECT') AS can_select_companies;

-- After this, set in .env:
--   DATABASE_URL=postgresql://portal_app:<password>@db.<ref>.supabase.co:5432/postgres
--
-- A DDL attempt from the app will now fail with:
--   ERROR: permission denied for schema public
