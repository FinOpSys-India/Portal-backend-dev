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

router.post(
  '/',
  // `type: '*/*'` rather than 'application/json': the signature must be checked
  // even when a misconfigured sender omits or mangles the Content-Type, and a
  // body that never reached the handler cannot be rejected with a clear reason.
  express.raw({ type: '*/*', limit: '1mb' }),
  handleWebhook
);

module.exports = router;
