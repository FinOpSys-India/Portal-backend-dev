'use strict';

/*
 * Vercel entry point.
 *
 * Vercel never runs src/server.js: there is no long-lived process to bind a
 * port, so `app.listen()` would have nothing to listen on. It invokes this file
 * once per request instead, handing the Express app the (req, res) pair it
 * already understands. src/app.js is the whole API and stays the single source
 * of routing — this file adds nothing to it and deliberately contains no logic.
 *
 * What is therefore NOT running here, because it lives in server.js:
 *   - connectDatabase() / verifyEmailConnection() startup checks. Harmless: the
 *     first query fails with the same error the check would have reported.
 *   - billingReconcileSweep, which is a setInterval timer. A serverless function
 *     is not alive between requests, so the sweep never fires. It needs a Vercel
 *     Cron hitting a route, or `npm run billing:reconcile` run elsewhere.
 */
const app = require('../src/app');

module.exports = app;

/*
 * Vercel's Node runtime parses the request body before the handler sees it,
 * which consumes the stream express.raw would have read. The Stripe webhook
 * signs the exact bytes Stripe sent, so a parsed-and-reserialised body never
 * verifies. Turning the platform parser off leaves the stream intact for
 * src/routes/billingWebhookRoutes.js to read itself.
 */
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
