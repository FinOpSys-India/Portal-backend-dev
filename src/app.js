'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./config');
const routes = require('./routes');
const billingWebhookRoutes = require('./routes/billingWebhookRoutes');
const requestId = require('./middlewares/requestId');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

// Every feature router is mounted under one prefix, so the public contract is
// defined in a single place (config.apiPrefix, overridable with API_PREFIX).
const API_PREFIX = config.apiPrefix;

/*
 * Builds the Express application. Kept separate from server startup so it can
 * be imported directly in tests without binding a port.
 */
const app = express();

/*
 * FUTURE — transport & browser hardening (needed before this is exposed
 * publicly). These are deliberately not on yet so local/dev over HTTP keeps
 * working:
 *   - HTTPS enforcement: in production, reject or redirect plain-HTTP requests
 *     so passwords, OTPs, and tokens never travel in the clear.
 *   - HSTS: send Strict-Transport-Security so browsers refuse HTTP afterwards.
 *   - Secure headers: add `helmet` for HSTS, X-Content-Type-Options, frameguard, etc.
 *   - CSRF protection: auth is cookie-based (the refresh-token cookie), so once
 *     /refresh and /logout exist, add CSRF tokens on state-changing routes.
 *     SameSite=Lax on the cookie is a partial mitigation, not a full defence.
 */

// Must precede the rate limiter, which reads req.ip.
if (config.trustProxy) {
  const hops = Number(config.trustProxy);
  app.set('trust proxy', Number.isInteger(hops) ? hops : config.trustProxy);
}

// Credentialed CORS must name explicit origins — a wildcard with credentials is
// rejected by browsers and unsafe. Falls back to reflecting the request origin
// only when CORS_ORIGIN is the default '*' (development convenience).
app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  })
);
// Assigns req.id and the X-Request-Id response header; must precede the routes
// and the error handler, both of which reference it. Registered before the body
// parsers so the Stripe webhook below is correlated in the logs too.
app.use(requestId);

/*
 * The Stripe webhook is mounted HERE, ahead of express.json(), and the order is
 * load-bearing. Stripe signs the exact bytes it sent; parsing them into an object
 * discards those bytes, and no re-serialisation reproduces them faithfully. The
 * route therefore installs its own express.raw parser and receives a Buffer.
 * Move this line below express.json() and every event fails signature checking.
 */
app.use(`${API_PREFIX}/billing/webhook`, billingWebhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Portal backend API' });
});

app.use(API_PREFIX, routes);

// 404 + error handling must stay last.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
