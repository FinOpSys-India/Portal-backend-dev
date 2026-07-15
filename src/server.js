'use strict';

const app = require('./app');
const config = require('./config');
const db = require('./config/db');
const logger = require('./utils/logger');

const server = app.listen(config.port, () => {
  logger.info(`Server running in ${config.env} mode on port ${config.port}`);
});

// Verify the database connection on startup; exit if it is unreachable.
db.connect().catch((err) => {
  logger.error('Failed to connect to PostgreSQL:', err.message);
  process.exit(1);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

// Crash on unexpected fatal errors so the process manager can restart cleanly
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  throw reason;
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = server;
