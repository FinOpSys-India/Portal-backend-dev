'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const repo = require('../repositories/billingRepository');
const webhooks = require('./stripeWebhookService');

/**
 * The safety net under a lost webhook delivery.
 *
 * Every other path that writes a subscription's Stripe ids depends on something
 * outside this process staying up:
 *
 *   the webhook          needs a listener to be running when Stripe fires
 *   getCheckoutStatus    needs the browser to return to the success page
 *
 * Both are things a human has to remember. Miss both — a dev machine with no
 * `stripe listen`, a customer who paid and closed the tab — and a PAID
 * subscription sits at INCOMPLETE indefinitely: Stripe stops retrying after its
 * window, and nothing in the system ever asks again. The money is real, the
 * entitlement is missing, and the only way anyone finds out is by noticing.
 *
 * This sweep is the thing that always asks. It runs on a timer, finds rows
 * missing something only a webhook writes, and hands each one to
 * reconcileFromCheckoutSession — the SAME function the success page calls, so
 * repair has one definition rather than two that drift.
 *
 * Nothing here is believed from local state: that function re-fetches the
 * session, the subscription and the invoices from Stripe, and refuses a session
 * that is not paid. A sweep cannot activate anything Stripe did not bill.
 */

let timer = null;
let running = false;

/**
 * One pass. Exported so it can be run on demand (a script, a test, an admin
 * action) without waiting for the timer.
 *
 * @returns {Promise<{scanned: number, repaired: number, failed: number}>}
 */
async function runSweep({ requestId = 'reconcile-sweep' } = {}) {
  const { lookbackHours, batchSize } = config.billing.reconcileSweep;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const candidates = await repo.listSubscriptionsNeedingReconcile(prisma, {
    since,
    take: batchSize,
  });

  if (!candidates.length) return { scanned: 0, repaired: 0, failed: 0 };

  let repaired = 0;
  let failed = 0;

  for (const subscription of candidates) {
    try {
      const outcome = await webhooks.reconcileFromCheckoutSession({
        sessionId: subscription.stripeCheckoutSessionId,
        requestId,
      });

      if (outcome.reconciled) {
        repaired += 1;
        logger.info(
          `Reconcile sweep: repaired subscription ${subscription.id} (company ${subscription.companyId}) — ` +
            `${outcome.status}, ${outcome.receipts} receipt(s).`
        );
      }
      /*
       * `not_paid` is the overwhelmingly common outcome and is NOT a failure: an
       * abandoned or still-open checkout is a normal state, and its row is
       * correctly INCOMPLETE. It is left unlogged so the sweep stays silent when
       * there is nothing wrong — a job that prints every five minutes is a job
       * nobody reads.
       */
    } catch (err) {
      /*
       * One bad row must not stop the pass. A Stripe outage, a deleted test-mode
       * session, a transient database error — the next subscription may well be
       * repairable, and the next pass retries this one anyway.
       */
      failed += 1;
      logger.warn(`Reconcile sweep: subscription ${subscription.id} failed: ${err.message}`);
    }
  }

  if (repaired || failed) {
    logEvent({
      event: 'billing.reconcile.sweep',
      status: failed ? 'failure' : 'success',
      requestId,
      detail: `scanned ${candidates.length}, repaired ${repaired}, failed ${failed}`,
    });
  }

  return { scanned: candidates.length, repaired, failed };
}

/**
 * Start the timer. Idempotent, and a no-op when the sweep is disabled.
 *
 * `unref()` keeps the timer from holding the process open, so a graceful
 * shutdown does not wait up to a full interval for it.
 */
function startSweep() {
  const { enabled, intervalSeconds } = config.billing.reconcileSweep;
  if (!enabled || timer) return false;

  const tick = async () => {
    // Skip rather than overlap: a slow pass (a Stripe timeout on every row)
    // must not stack a second one on top of it.
    if (running) return;
    running = true;
    try {
      await runSweep();
    } catch (err) {
      logger.error(`Reconcile sweep failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref();

  /*
   * Run once at startup, not only after the first interval. The case that
   * matters most is a backend that was down while a payment completed — those
   * rows are already broken when the process comes up, and waiting five minutes
   * to notice serves nobody. Deferred a beat so it does not race the database
   * connection check in server.js.
   */
  setTimeout(tick, 5000).unref();

  logger.info(`Billing reconcile sweep started (every ${intervalSeconds}s).`);
  return true;
}

/** Stop the timer. Used by graceful shutdown and by tests. */
function stopSweep() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { runSweep, startSweep, stopSweep };
