'use strict';

const express = require('express');

const { handleWebhook } = require('../controllers/billingController');

/*
 * The Stripe webhook endpoint, isolated in its own router for one reason: it must
 * receive the RAW request body.
 *
 * Stripe signs the exact bytes it sent. `express.json()` parses those bytes into
 * an object and throws them away — re-serialising later produces different bytes
 * (key order, whitespace, unicode escaping), so the signature would never verify
 * again. `express.raw` hands the handler a Buffer instead, untouched.
 *
 * This router is therefore mounted in app.js BEFORE `app.use(express.json())`.
 * Mounting order is load-bearing: move it after the JSON parser and every event
 * fails signature verification.
 *
 * There is no requireAuth here, and that is correct — Stripe has no access token.
 * The signature check in stripeWebhookService IS the authentication, and it runs
 * before anything is read out of the payload.
 *
 * No rate limiter either: throttling Stripe would make it retry, and a 429 is a
 * retryable status, so a limiter under load would amplify the traffic it is
 * trying to shed rather than reduce it.
 */
const router = express.Router();

/*
 * Yield the raw bytes whether or not the host already read the request stream.
 *
 * express.raw alone is enough behind a plain Node server, which is what
 * src/server.js is: the stream reaches this router untouched. A serverless host
 * is not that. Vercel's Node runtime consumes the body itself before invoking
 * the function, so raw() would find an exhausted stream and hand the controller
 * an empty Buffer — and an empty Buffer fails signature verification exactly
 * like a forged one, so every genuine Stripe event would be rejected with
 * "No signatures found matching the expected signature". Nothing about that
 * failure points at the platform, which is what makes it worth pre-empting.
 *
 * A body already produced by the host is used verbatim: a Buffer as-is, a string
 * re-encoded as UTF-8. Both are still the bytes Stripe sent. Only when neither
 * is present — the normal local path — is raw() invoked to read the stream.
 *
 * Note what is deliberately NOT here: no branch reconstructs a Buffer from a
 * parsed object. JSON.stringify of a parsed body is a different byte sequence
 * (key order, whitespace, unicode escaping) and would verify against nothing,
 * so it is better to fail loudly than to appear handled. That case is prevented
 * upstream by `bodyParser: false` in api/index.js.
 */
function rawBody(req, res, next) {
  if (Buffer.isBuffer(req.body)) return next();

  if (typeof req.body === 'string') {
    req.body = Buffer.from(req.body, 'utf8');
    return next();
  }

  // `type: '*/*'` rather than 'application/json': the signature must be checked
  // even when a misconfigured sender omits or mangles the Content-Type, and a
  // body that never reached the handler cannot be rejected with a clear reason.
  return express.raw({ type: '*/*', limit: '1mb' })(req, res, next);
}

router.post('/', rawBody, handleWebhook);

module.exports = router;
