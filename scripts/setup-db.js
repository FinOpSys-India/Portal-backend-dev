/**
 * Applies scripts/schema.sql to the configured database (Supabase when
 * DATABASE_URL is set). Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   node scripts/setup-db.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const db = require("../src/config/db");

async function main() {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  console.log("1) Connecting...");
  const info = await db.connect();
  console.log(`   ✔ Connected to "${info.db}"`);

  console.log("2) Applying schema.sql...");
  await db.query(sql);
  console.log("   ✔ Schema applied");

  console.log("3) Verifying tables...");
  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  rows.forEach((r) => console.log(`   - ${r.table_name}`));

  await db.pool.end();
}

main().catch((err) => {
  console.error("‼ FAILED:", err.message || err);
  process.exit(1);
});
