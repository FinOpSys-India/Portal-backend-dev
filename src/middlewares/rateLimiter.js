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

/*
 * The caller's own profile: phone/address edits and avatar upload/removal.
 *
 * Authenticated, so the exposure is bounded to a real account — but the avatar
 * route is the only endpoint in the API that writes files, and each call can
 * write megabytes and orphan the previous file. The cap is what stops a looping
 * client (or a bored account holder) from filling the disk, which no amount of
 * per-request size limiting would prevent on its own.
 */
const profileLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30, label: 'Profile' });

/*
 * Token refresh. Unauthenticated by nature — an expired access token is exactly
 * when this is called — and every hit writes (revoke the old row, insert the new
 * one), so it is both a guessing surface and a write amplifier.
 *
 * The cap is generous rather than tight: a legitimate client refreshes roughly
 * once per access-token lifetime, but several tabs of the same app each hold
 * their own timer, and throttling a real user out of their session is a worse
 * outcome than letting an attacker make a few dozen doomed guesses against a
 * 96-hex-character token.
 */
const refreshLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 60, label: 'Refresh' });

/*
 * Project creation and edits. Authenticated and transactional, and each create
 * resolves the company's subscription and staffing before it writes — the same
 * shape as the company routes, so it gets the same generous cap. A form-driven
 * session issues a handful of calls; a looping client is what this stops.
 */
const projectLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 60, label: 'Project' });

/*
 * Project document uploads.
 *
 * Tighter than projectLimiter even though both are authenticated, because this
 * is the only endpoint in the API where one call can write hundreds of megabytes
 * — up to ten files at 25 MB each. The per-file and per-request caps bound one
 * request; this is what bounds the sequence of them, and it is the only thing
 * standing between a looping client and a full disk.
 *
 * It runs BEFORE the multipart parser on the route, so a throttled caller is
 * refused without a single byte being written.
 */
const documentLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 40, label: 'Document upload' });

/*
 * The compose-and-send email screen: drafts, edits, and the send itself.
 *
 * Tighter than projectLimiter despite both being authenticated, because the send
 * endpoint is the only one in the API that puts mail in a THIRD PARTY'S inbox. A
 * looping client on any other route wastes this server's time; a looping client
 * here floods a real client's mailbox and burns the SMTP host's reputation,
 * which is not something a later fix undoes.
 *
 * Attachment upload and confirm deliberately do NOT use this — they carry
 * `documentLimiter`, since what they bound is bytes written to the bucket and
 * that is the same work, and the same risk, wherever it is issued from.
 */
const emailLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30, label: 'Email' });

/*
 * Chat: opening a thread, sending, marking read.
 *
 * THE LOOSEST LIMITER IN THIS FILE, and deliberately so. Every other endpoint
 * here is reached by submitting a form; a chat window is reached by typing, and
 * a real conversation is dozens of short messages in a few minutes. A cap sized
 * like emailLimiter's would cut off the one legitimate user this API has who
 * sends thirty requests in a row on purpose.
 *
 * It is still capped, because nothing else bounds a client stuck in a send loop
 * — and unlike email, a message here reaches an inbox nobody has to leave the
 * portal to see, so a flood is annoying rather than reputationally expensive.
 * That is the whole difference between the two numbers.
 *
 * Attachment uploads do NOT use this: they carry `documentLimiter`, the same as
 * the project and email upload routes, because what they bound is bytes written
 * to the bucket and that is the same work and the same risk wherever it is
 * issued from.
 */
const chatLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 300, label: 'Chat' });

module.exports = {
  invitationLimiter,
  authLimiter,
  loginLimiter,
  otpLimiter,
  passwordResetLimiter,
  onboardingLimiter,
  companyLimiter,
  billingLimiter,
  profileLimiter,
  refreshLimiter,
  projectLimiter,
  documentLimiter,
  emailLimiter,
  chatLimiter,
};
