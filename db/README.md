# Database

**The schema is managed by hand.** This project does not use Prisma migrations.
Tables are created by running the SQL in `schema/` against the database
yourself — nothing in the application code creates, alters, or drops a table.

## Layout

```
db/
├── schema/     numbered DDL, applied in order. The definition of the database.
└── roles/      the restricted application role
```

`schema/` files are the historical order in which the database was built. They
are all idempotent (`IF NOT EXISTS`, duplicate-tolerant `DO` blocks), so
re-running any of them is a no-op.

## Standing up a new database

Run the files in `schema/` in numeric order, then seed the reference rows:

```bash
psql "$ADMIN_DATABASE_URL" -f db/schema/01_init.sql
# ... 02 through 09 ...
npm run db:seed
```

Or paste each file into the Supabase SQL editor in order.

## Changing the schema

1. Write the DDL and run it against the database yourself (Supabase SQL editor
   or `psql` with an **admin** connection string).
2. Save it as the next numbered file in `schema/`, so the folder stays a
   complete description of the database.
3. Update `prisma/schema.prisma` to match — **or** run `npm run db:pull` to
   regenerate it from the live database.
4. `npm run db:generate` to rebuild the Prisma Client.

Step 3 is not optional. `schema.prisma` is what the Prisma Client is generated
from: if it disagrees with the real tables, queries fail at runtime against
columns that do not exist. It *describes* the database — it no longer *drives*
it.

## Two connection strings

| Used by | Role | Rights |
|---|---|---|
| The app (`.env` `DATABASE_URL`) | `portal_app` | rows only — SELECT/INSERT/UPDATE/DELETE |
| You, for schema changes | `postgres` (admin) | full DDL |

Set this up with `roles/app_user.sql`. Once the app connects as `portal_app`, no
code path — application, script, or stray CLI command — can alter the schema,
because the database refuses it. That is the real guarantee; leaving migration
commands out of `package.json` is only a convention on top of it.

## Commands that still exist

| Command | Effect |
|---|---|
| `npm run db:seed` | Inserts/upserts reference rows (roles, specializations, service plans). Rows only. |
| `npm run db:generate` | Regenerates the Prisma Client from `schema.prisma`. Touches nothing in the database. |
| `npm run db:pull` | Rewrites `schema.prisma` **from** the live database. Read-only against the DB. |
| `npm run db:studio` | Browse rows. |

`prisma migrate dev`, `prisma migrate deploy`, `prisma db push`, and
`prisma migrate reset` are deliberately **not** wired into any npm script.
Do not run them — the first three would try to take schema control back, and
`reset` drops every table.

## Note on `_prisma_migrations`

The database still contains a `_prisma_migrations` table listing the seven
migrations that were applied before the switch to manual management. It is inert
— nothing reads it now. Leave it as a record, or drop it once you are confident
you will never run a Prisma migration command again.
