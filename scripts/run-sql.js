'use strict';

/**
 * Apply a hand-written schema file from db/schema/ to the configured database.
 *
 * The schema here is managed BY HAND (see db/README.md) — there are no Prisma
 * migrations — which normally means running the SQL through `psql`. That is not
 * available on every machine the project is developed on, so this runs the same
 * file through the `pg` driver already in the dependency tree.
 *
 *   node scripts/run-sql.js db/schema/10_add_...sql            # apply
 *   node scripts/run-sql.js db/schema/10_add_...sql --dry-run  # parse + report only
 *
 * The file is sent as ONE simple query, so a BEGIN/COMMIT inside it behaves
 * exactly as it would in psql: either the whole file applies or none of it does.
 * Files in db/schema/ are written to be idempotent (IF NOT EXISTS, duplicate_object
 * guards), so re-running one is safe.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      // Managed Postgres (Supabase, Neon) terminates TLS at its own proxy with a
      // certificate we do not pin; the same setting the app itself uses.
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
    };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'postgres',
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 30000,
  };
}

async function main() {
  const [, , file, ...flags] = process.argv;
  if (!file) {
    console.error('Usage: node scripts/run-sql.js <path-to.sql> [--dry-run]');
    process.exit(1);
  }

  const dryRun = flags.includes('--dry-run');
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`No such file: ${abs}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(abs, 'utf8');
  console.log(`file    : ${path.relative(process.cwd(), abs)}`);
  console.log(`bytes   : ${sql.length}`);
  console.log(`mode    : ${dryRun ? 'DRY RUN (nothing will be written)' : 'APPLY'}`);

  const client = new Client(buildConfig());
  await client.connect();

  const [{ db, version }] = (
    await client.query('SELECT current_database() AS db, version() AS version')
  ).rows;
  console.log(`database: ${db} (${version.split(',')[0]})`);

  if (dryRun) {
    /*
     * A real parse check, not a guess: run the file inside a transaction and roll
     * it back. Postgres reports a syntax or constraint error exactly as it would
     * on a live apply, and nothing survives the rollback.
     */
    try {
      await client.query('BEGIN');
      await client.query(sql.replace(/^\s*BEGIN;\s*$/im, '').replace(/^\s*COMMIT;\s*$/im, ''));
      await client.query('ROLLBACK');
      console.log('\nresult  : OK — the file applies cleanly (rolled back)');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\nresult  : FAILED — ${err.message}`);
      if (err.detail) console.error(`detail  : ${err.detail}`);
      if (err.hint) console.error(`hint    : ${err.hint}`);
      await client.end();
      process.exit(1);
    }
    await client.end();
    return;
  }

  const startedAt = Date.now();
  try {
    await client.query(sql);
    console.log(`\nresult  : APPLIED in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`\nresult  : FAILED — ${err.message}`);
    if (err.detail) console.error(`detail  : ${err.detail}`);
    if (err.hint) console.error(`hint    : ${err.hint}`);
    // The file wraps itself in BEGIN/COMMIT, so a failure has already aborted
    // the transaction and nothing was written.
    await client.end();
    process.exit(1);
  }

  await client.end();
}

main().catch((err) => {
  console.error('run-sql failed:', err.message);
  process.exit(1);
});
