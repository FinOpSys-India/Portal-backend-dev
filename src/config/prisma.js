'use strict';

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const config = require('./index');
const logger = require('../utils/logger');

/*
 * Prisma 7 has no built-in query engine: it runs on a driver adapter over the
 * `pg` driver, so the connection is configured here rather than in
 * schema.prisma. PrismaPg takes a pg PoolConfig, which is why either
 * DATABASE_URL or the discrete DB_* vars work.
 */
const poolConfig = config.db.url
  ? { connectionString: config.db.url }
  : {

    
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    };

// Supabase and other managed Postgres require SSL; the provider manages the
// certificate, so we don't verify it here.
if (config.db.ssl) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

/*
 * Pool sizing and lifetime. Against a remote managed Postgres, opening a
 * connection costs a full DNS + TCP + TLS handshake — often over a second. The
 * pg defaults reap idle connections after 10s, so a request arriving after a
 * short lull pays that handshake again, and Prisma's transaction acquisition
 * window (maxWait) expires first with P2028. Keeping connections warm and
 * allowing a realistic connect time removes that failure mode.
 */
Object.assign(poolConfig, {
  max: config.db.poolMax,
  // Never reap idle connections: a warm pool is the point.
  idleTimeoutMillis: 0,
  // How long a pool checkout may wait for a brand-new connection to be
  // established. Must comfortably exceed the handshake cost.
  connectionTimeoutMillis: config.db.connectTimeoutMs,
  // TCP keepalives stop idle connections being silently dropped by NAT or the
  // provider's proxy, which would otherwise surface as a dead socket mid-query.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg(poolConfig),
  /*
   * Defaults for every interactive $transaction, so no call site has to repeat
   * them. `maxWait` is how long a transaction may wait to acquire a connection
   * before failing with P2028 — the 2s default is too tight for a remote
   * database whose pool may have to open a new connection first. `timeout` is
   * how long the transaction body itself may run once started.
   */
  transactionOptions: {
    maxWait: config.db.txMaxWaitMs,
    timeout: config.db.txTimeoutMs,
  },
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('error', (e) => logger.error('Prisma error:', e.message));
prisma.$on('warn', (e) => logger.warn('Prisma warning:', e.message));

/**
 * Verify the database is reachable. Called once on startup so the process
 * fails fast with a clear message instead of erroring on the first request.
 */
async function connectDatabase() {
  const [{ db, version }] = await prisma.$queryRaw`
    SELECT current_database() AS db, version() AS version
  `;
  logger.info(`Connected to PostgreSQL database "${db}" (${version.split(',')[0]})`);
  return { db, version };
}

async function disconnectDatabase() {
  await prisma.$disconnect();
}

module.exports = { prisma, connectDatabase, disconnectDatabase };
