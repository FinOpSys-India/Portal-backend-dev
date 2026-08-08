'use strict';

/**
 * Run the billing reconcile sweep once, from the command line.
 *
 * `npm run billing:reconcile`
 *
 * The same pass the server runs on a timer, for when you do not want to wait for
 * it — after a test checkout with no listener running, say. It repairs every
 * subscription missing something only a webhook writes, and touches nothing that
 * Stripe does not report as paid.
 */

const { runSweep } = require('../src/services/billingReconcileSweep');
const { prisma } = require('../src/config/prisma');
const logger = require('../src/utils/logger');

(async () => {
  const result = await runSweep({ requestId: 'cli-reconcile' });
  logger.info(
    `Reconcile sweep: scanned ${result.scanned}, repaired ${result.repaired}, failed ${result.failed}.`
  );
  await prisma.$disconnect();
  process.exit(result.failed ? 1 : 0);
})().catch(async (err) => {
  logger.error(`Reconcile sweep failed: ${err.stack || err.message}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
