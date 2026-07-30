// Prisma CLI configuration (Prisma 7). The datasource URL lives here rather
// than in schema.prisma so the same connection string drives both the CLI and
// the app at runtime.
//
// NOTE: there is deliberately no `migrations.path` here. This project does NOT
// manage its database schema through Prisma migrations — tables are created by
// hand from the SQL in db/schema/. Prisma is used only to (a) generate the
// client from schema.prisma and (b) seed reference rows. See README ->
// "Database (managed by hand)".
require('dotenv/config');

const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'node prisma/seed.js',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
