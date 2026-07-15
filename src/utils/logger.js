'use strict';

/**
 * Tiny dependency-free logger. Swap the internals for winston/pino later
 * without changing call sites across the app.
 */
const levels = ['error', 'warn', 'info', 'debug'];

function timestamp() {
  return new Date().toISOString();
}

function log(level, ...args) {
  const line = `[${timestamp()}] [${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line, ...args);
}

const logger = levels.reduce((acc, level) => {
  acc[level] = (...args) => log(level, ...args);
  return acc;
}, {});

module.exports = logger;
