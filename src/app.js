'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config');
const routes = require('./routes');
const billingWebhookRoutes = require('./routes/billingWebhookRoutes');
const requestId = require('./middlewares/requestId');
const normalizeRequest = require('./middlewares/normalizeRequest');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const logger = require('./utils/logger');

// Every feature router is mounted under one prefix, so the public contract is
// defined in a single place (config.apiPrefix, overridable with API_PREFIX).
const API_PREFIX = config.apiPrefix;

/*
 * Builds the Express application. Kept separate from server startup so it can
 * be imported directly in tests without binding a port.
 */
const app = express();

// Must precede the rate limiter, which reads req.ip.
if (config.trustProxy) {
  const hops = Number(config.trustProxy);
  app.set('trust proxy', Number.isInteger(hops) ? hops : config.trustProxy);
}

// Express advertises itself in a response header by default; there is no reason
// to tell an attacker which server stack to look up known issues for.
app.disable('x-powered-by');

/* -------------------------------------------------------------------------- */
/* transport + browser hardening                                              */
/* -------------------------------------------------------------------------- */

/*
 * Secure headers. `contentSecurityPolicy` is off because this process serves
 * JSON exclusively — a CSP governs how a browser may load subresources of a
 * document, and there is no document here. `crossOriginResourcePolicy` is
 * relaxed to cross-origin for the same reason: the API is deliberately consumed
 * from another origin (the frontend), which the default `same-origin` would
 * block outright.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: config.security.forceHttps
      ? { maxAge: config.security.hstsMaxAgeSeconds, includeSubDomains: true, preload: false }
      : false,
  })
);

/*
 * HTTPS enforcement. Passwords, OTPs, reset tickets and bearer tokens all cross
 * this API, and every one of them is readable on the wire over plain HTTP.
 * Behind a proxy the original scheme arrives in X-Forwarded-Proto, which
 * `req.secure` reads only once `trust proxy` is set — so this is deliberately
 * paired with TRUST_PROXY rather than trusting the header blindly.
 */
if (config.security.forceHttps) {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    // A POST cannot be safely redirected — the body would be replayed over the
    // insecure connection first. Refuse it instead.
    return res.status(403).json({
      success: false,
      error: {
        code: 'HTTPS_REQUIRED',
        message: 'This API requires HTTPS.',
        requestId: req.id,
      },
    });
  });
}

/*
 * Credentialed CORS must name explicit origins — a wildcard with credentials is
 * rejected by browsers and unsafe.
 *
 * The old fallback reflected ANY request origin when CORS_ORIGIN was '*', which
 * is what `.env` actually shipped, so every origin on the internet was granted
 * credentialed access. Reflecting an arbitrary origin with `credentials: true`
 * is functionally the same as having no origin policy at all. Now an unset
 * CORS_ORIGIN falls back to the known local dev origins and nothing else, and a
 * literal '*' is refused outright in production rather than honoured.
 */
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

function resolveCorsOrigins() {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') {
    if (config.isProduction) {
      throw new Error('CORS_ORIGIN must list explicit origins in production; "*" is not permitted with credentials.');
    }
    logger.warn(
      `CORS_ORIGIN is unset or "*"; falling back to development origins: ${DEV_ORIGINS.join(', ')}`
    );
    return DEV_ORIGINS;
  }
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

const allowedOrigins = resolveCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      // A request with no Origin header is not a browser cross-origin request —
      // curl, a server-to-server call, a health probe. There is no cookie to
      // protect in that case, so allow it.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay', 'Retry-After'],
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
 *
 * It is also ahead of normalizeRequest, which must never see the raw body.
 */
app.use(`${API_PREFIX}/billing/webhook`, billingWebhookRoutes);

app.use(express.json({ limit: config.security.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.security.bodyLimit }));
app.use(cookieParser());

/*
 * Reconcile inbound key casing exactly once, before any validator runs, so the
 * API accepts `company_id` and `companyId` alike while every validator downstream
 * compares against a single canonical name.
 */
app.use(normalizeRequest);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Portal backend API' });
});

app.use(API_PREFIX, routes);

// 404 + error handling must stay last.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
