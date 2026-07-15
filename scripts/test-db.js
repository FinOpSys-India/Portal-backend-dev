/**
 * Standalone database smoke test — isolates the DB connection from the API.
 *
 * Usage:
 *   node scripts/test-db.js
 *
 * It connects using the same config the app uses (DATABASE_URL when set,
 * otherwise the DB_* vars), reports the connected database and server
 * version, and lists the public tables so you can confirm your schema.
 */
require("dotenv").config();

const db = require("../src/config/db");

async function main() {
  const usingUrl = Boolean(process.env.DATABASE_URL);
  console.log(`1) Connecting to PostgreSQL (${usingUrl ? "DATABASE_URL" : "DB_* vars"})...`);
  const info = await db.connect();
  console.log(`   ✔ Connected to "${info.db}"`);
  console.log(`   ${info.version.split(" ").slice(0, 2).join(" ")}`);

  console.log("2) Listing public tables...");
  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  if (rows.length === 0) {
    console.log("   (no tables yet — you'll need to create your schema in Supabase)");
  } else {
    rows.forEach((r) => console.log(`   - ${r.table_name}`));
  }

  await db.pool.end();
}

main().catch((err) => {
  console.error("‼ FAILED:", err.message || err);
  process.exit(1);
});
