'use strict';

const { Pool } = require('pg');

const config = require('./index');
const logger = require('../utils/logger');


const poolConfig = config.db.url
  ? { connectionString: config.db.url }
  : {
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    };

// Supabase (and other managed Postgres) require SSL. The certificate is
// managed by the provider, so we don't reject unauthorized here.
if (config.db.ssl) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Verify the database is reachable. Called once on startup so the process
 * fails fast with a clear message instead of erroring on the first query.
 */
async function connect() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db, version() AS version');
    logger.info(`Connected to PostgreSQL database "${rows[0].db}"`);
    return rows[0];
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  connect,
  query: (text, params) => pool.query(text, params),
};
