'use strict';

const app = require('./app');
const config = require('./config');
const { connectDatabase, disconnectDatabase } = require('./config/prisma');
const { verifyEmailConnection } = require('./services/emailService');
const reconcileSweep = require('./services/billingReconcileSweep');
const logger = require('./utils/logger');

const server = app.listen(config.port, () => {
  logger.info(`Server running in ${config.env} mode on port ${config.port}`);
});

// Verify the database on startup so an unreachable database fails here with a
// clear message rather than on the first request.
connectDatabase().catch((err) => {
  logger.error('Failed to connect to PostgreSQL:', err.message);
  process.exit(1);
});

/*
 * Check SMTP too, but only warn: unlike the database, bad mail config does not
 * make the API unusable — invitations still persist as PENDING and are retried
 * by re-inviting. Surfacing it here beats discovering it one silent failure at
 * a time.
 */
verifyEmailConnection()
  .then(() => logger.info('SMTP connection verified'))
  .catch((err) => logger.warn(`SMTP unavailable, invitation emails will fail: ${err.message}`));

/*
 * Repair subscriptions whose webhook never arrived. Started here rather than in
 * app.js so importing the app in a test does not spawn a timer that calls Stripe.
 */
reconcileSweep.startSweep();

// Graceful shutdown: stop accepting connections, then release the pool.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);
  reconcileSweep.stopSweep();

  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await disconnectDatabase();
      logger.info('Database connection closed');
    } catch (err) {
      logger.error('Error closing database connection:', err.message);
    }
    process.exit(0);
  });

  // Don't hang forever on a stuck connection.
  setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  throw reason;
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = server;
