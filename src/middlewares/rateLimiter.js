'use strict';

const { rateLimit } = require('express-rate-limit');

const config = require('../config');
const logger = require('../utils/logger');

/*
 * FUTURE — these limiters use express-rate-limit's default in-memory store,
 * which is per-process. Two things to add before running multiple instances or
 * facing real abuse:
 *   - Shared store: back the limiters with Redis (rate-limit-redis) so the limit
 *     is global across instances, not per-process.
 *   - Extra dimensions: today the cap is per-IP only. Add per-email / per-user
 *     and per-challenge keys, plus a system-wide hourly OTP-email cap, so one IP
 *     can't spread an attack across accounts and one account can't be hammered
 *     from many IPs. (Per-account attempt counters + resend cooldowns already
 *     live in authService as a partial backstop.)
 */

// The suite fires many requests from one IP in seconds, which is exactly what
// the limiter is built to block. Bypass it under test so functional assertions
// aren't masked by 429s; the limit stays fully active everywhere else.
const skip = () => config.env === 'test';

/*
 * Shared 429 handler producing the standard error envelope. Also sets
 * Retry-After (seconds until the window resets) so a well-behaved client knows
 * exactly how long to wait rather than guessing.
 */
function limitHandler(label) {
  return (req, res) => {
    logger.warn(`[${req.id}] ${label} rate limit hit by ${req.ip}`);
    const resetMs = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 0;
    const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests from this address. Please try again later.',
        requestId: req.id,
        details: { retryAfterSeconds: retryAfter },
      },
    });
  };
}

function makeLimiter({ windowMs, limit, label }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip,
    handler: limitHandler(label),
  });
}

/*
 * Creating an invitation sends mail to a caller-supplied address, so an
 * unthrottled endpoint is a way to use this server to spam arbitrary inboxes
 * (and to burn the SMTP provider's quota). Cap it. The limit is per client IP,
 * which behind a proxy only works once Express is told to trust it — see
 * `app.set('trust proxy', ...)` in app.js.
 */
const invitationLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 20, label: 'Invitation' });

/*
 * Sign-up accepts a secret invitation token and runs a deliberately slow bcrypt
 * hash on every call — both a way to brute-force tokens and a cheap
 * CPU-exhaustion vector. Cap it tighter than the invitation endpoint.
 */
const authLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10, label: 'Auth' });

/*
 * Login runs bcrypt on every call and, on success, sends an OTP email. The
 * per-IP cap here is the first line of defence; per-account limits (attempt
 * counter + temporary lock) are enforced in the service so one IP cannot spread
 * an attack across many accounts, and one account cannot be hammered from many
 * IPs, without both limits tripping.
 */
const loginLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10, label: 'Login' });

/*
 * The OTP endpoint covers both verify and resend. Per-challenge limits (attempt
 * count, resend cooldown/cap) live in the service; this per-IP cap bounds how
 * fast anyone can probe codes or trigger emails overall.
 */
const otpLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30, label: 'OTP' });

/*
 * Forgotten-password request. Unauthenticated and it sends mail to whichever
 * registered address is named, so an uncapped endpoint is both a way to flood a
 * chosen user's inbox and — because the response is deliberately identical for
 * known and unknown emails — the cheapest place to probe addresses in bulk. Held
 * to the same tight cap as sign-up. The confirm step shares it: that one runs
 * bcrypt on every call, so it is a CPU-exhaustion vector too.
 */
const passwordResetLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  label: 'Password reset',
});

/*
 * Onboarding routes run behind requireAuth, so they are far less exposed than
 * the public auth endpoints, but they still write (create a customer account,
 * update the profile). A generous per-IP cap stops a buggy or abusive client
 * from hammering them without getting in the way of a normal onboarding session.
 */
const onboardingLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30, label: 'Onboarding' });

/*
 * Company onboarding and team-management routes. Authenticated (behind
 * requireAuth) and transactional; a generous per-IP cap keeps a buggy or abusive
 * client from hammering the create/assign endpoints without hindering a normal
 * onboarding session (which issues several calls in quick succession).
 */
const companyLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 60, label: 'Company' });

/*
 * Checkout creation. Authenticated, but each call costs several Stripe API round
 * trips and creates a subscription row plus a Checkout Session, so it is capped
 * tighter than the other authenticated writes. Duplicate clicks are already
 * absorbed by the idempotency key in checkoutService — this limit is the backstop
 * against a client that loops.
 *
 * Deliberately NOT applied to /billing/webhook: throttling Stripe would only make
 * it retry, and 429 is a retryable status, so a limiter there amplifies load
 * instead of shedding it.
 */
const billingLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 20, label: 'Billing' });

module.exports = {
  invitationLimiter,
  authLimiter,
  loginLimiter,
  otpLimiter,
  passwordResetLimiter,
  onboardingLimiter,
  companyLimiter,
  billingLimiter,
};
