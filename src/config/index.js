'use strict';

const dotenv = require('dotenv');

dotenv.config();

/*
 * Convert a jsonwebtoken-style duration ("15m", "1h", "900s", or a bare number
 * of seconds) into an integer number of seconds, or null if it is not a
 * duration we understand. Returning null rather than a fallback keeps the
 * decision about what to do with a bad value at the call site.
 */
function durationToSeconds(value) {
  if (value === undefined || value === null) return null;
  const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] || 's'];
  return amount * unit;
}

/*
 * The access-token lifetime is needed in two forms: the duration string handed
 * to jsonwebtoken when signing, and the equivalent seconds reported to clients
 * as `expiresInSeconds`. Resolve it once here and derive the seconds from the
 * very string that will be signed, so the token's real lifetime and the number
 * the client is told can never drift apart. An unset or unparseable
 * ACCESS_TOKEN_TTL falls back to the default for both forms — never a string
 * jsonwebtoken would reject at signing time.
 */
/*
 * 15 minutes. The previous default was '615m' — over ten hours — which was not a
 * short-lived token by any reading, and left a leaked one useful for most of a
 * working day. It was only survivable because there was no refresh endpoint;
 * now that /auth/refresh exists, the access token can be as short as it should
 * always have been and the refresh token carries the session.
 */
const DEFAULT_ACCESS_TOKEN_TTL = '15m';

function resolveAccessTokenTtl(raw) {
  const ttl = String(raw ?? '').trim() || DEFAULT_ACCESS_TOKEN_TTL;
  const seconds = durationToSeconds(ttl);
  return seconds === null
    ? { ttl: DEFAULT_ACCESS_TOKEN_TTL, seconds: durationToSeconds(DEFAULT_ACCESS_TOKEN_TTL) }
    : { ttl, seconds };
}

const accessTokenTtl = resolveAccessTokenTtl(process.env.ACCESS_TOKEN_TTL);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  /*
   * Single mount point for every feature router (see src/app.js). Kept in config
   * rather than hardcoded so the prefix can be changed — or versioned to
   * '/api/v2' alongside the existing one — without editing route files.
   */
  apiPrefix: process.env.API_PREFIX || '/',
  /*
   * Number of proxy hops in front of the app, or '' when it is exposed
   * directly. Without this the rate limiter sees the proxy's IP on every
   * request and throttles all clients as one. Set it to the real hop count —
   * a blanket `true` would let anyone forge X-Forwarded-For and bypass the
   * limit entirely.
   */
  trustProxy: process.env.TRUST_PROXY || '',
  /*
   * Transport and browser hardening. These used to be a "FUTURE" comment in
   * app.js; they are now enforced, with the knobs here so a deployment can tune
   * them without editing middleware.
   */
  security: {
    // Maximum JSON / urlencoded body. Previously left at body-parser's implicit
    // 100kb default, which meant the limit was real but undocumented and its
    // breach surfaced as an unhandled 500.
    bodyLimit: process.env.BODY_LIMIT || '100kb',
    /*
     * CSRF protection for cookie-authenticated, state-changing requests. On by
     * default: the refresh cookie is a real credential, and SameSite=Lax alone
     * is a partial mitigation rather than a defence.
     */
    csrfEnabled: process.env.CSRF_ENABLED ? process.env.CSRF_ENABLED === 'true' : true,
    csrfCookieName: process.env.CSRF_COOKIE_NAME || 'csrfToken',
    csrfHeaderName: (process.env.CSRF_HEADER_NAME || 'x-csrf-token').toLowerCase(),
    // Redirect plain HTTP to HTTPS and send HSTS. Off outside production so
    // local development over http keeps working.
    forceHttps: process.env.FORCE_HTTPS
      ? process.env.FORCE_HTTPS === 'true'
      : process.env.NODE_ENV === 'production',
    hstsMaxAgeSeconds: parseInt(process.env.HSTS_MAX_AGE_SECONDS, 10) || 15552000,
  },
  auth: {
    /*
     * Secret used to sign access-token JWTs. There is deliberately no default:
     * a hardcoded fallback would mean every deployment that forgot to set it
     * shares a signing key, so anyone could mint valid tokens. The guard below
     * turns a missing secret into a startup failure in production rather than a
     * silent security hole.
     */
    jwtSecret: process.env.JWT_SECRET || '',
    /*
     * Access tokens are short-lived so a leaked one is only briefly useful; the
     * refresh token (revocable, stored hashed, rotated on every use) carries the
     * long session.
     *
     * Both forms come from the SAME resolution, so the token's real lifetime and
     * the `expiresInSeconds` reported to the client cannot drift. They used to:
     * `accessTokenTtlSeconds` called durationToSeconds with a second argument the
     * function does not accept, so an unset ACCESS_TOKEN_TTL produced `null` —
     * and every client computing an expiry from it got NaN.
     */
    accessTokenTtl: accessTokenTtl.ttl,
    accessTokenTtlSeconds: accessTokenTtl.seconds,
    refreshTokenTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10) || 30,
    // bcrypt work factor. 12 is a sensible 2020s default; raise as hardware
    // improves. Higher is slower to both hash and brute-force.
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    // Issuer/audience claims, verified on every token. Keeps a token minted for
    // this service from being accepted by an unrelated one that shares a secret.
    jwtIssuer: process.env.JWT_ISSUER || 'finopsys-portal',
    jwtAudience: process.env.JWT_AUDIENCE || 'finopsys-portal-api',
    // Password attempt limiter. After `maxLoginAttempts` failures the account is
    // locked for `lockMinutes` — a temporary lock, never a permanent one, so a
    // guessing attack cannot be turned into a denial of service on the account.
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS, 10) || 5,
    loginLockMinutes: parseInt(process.env.LOGIN_LOCK_MINUTES, 10) || 15,
  },
  /*
   * Email-OTP login settings. The digest secret is treated like the JWT secret:
   * no production default (a shared key would let anyone forge OTP digests), an
   * obviously-fake dev fallback so tests and `npm run dev` work with no setup.
   */
  otp: {
    secret: process.env.OTP_SECRET || '',
    length: 6,
    ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS, 10) || 300,
    // Max wrong OTP guesses per challenge before it is invalidated.
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5,
    // Minimum gap between resends, and the ceiling on resends per challenge.
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS, 10) || 60,
    maxResends: parseInt(process.env.OTP_MAX_RESENDS, 10) || 3,
  },
  /*
   * Forgotten-password settings. The OTP itself reuses the `otp` block above
   * (same length, TTL, attempt cap and resend rules), so there is one place to
   * tune code policy. What is specific to the reset flow is the ticket minted
   * once the OTP is verified: it is the bearer permission to set a new password,
   * so it gets its own, deliberately short, lifetime.
   */
  passwordReset: {
    ticketTtlSeconds: parseInt(process.env.PASSWORD_RESET_TICKET_TTL_SECONDS, 10) || 600,
  },
  /*
   * Stripe + service-selection billing.
   *
   * The plan catalog itself is NOT here — it lives in the `service_plans` table
   * (plan_code -> stripe_product_id + stripe_price_id + amount + currency +
   * interval + is_active), which is the single source of truth. What this block
   * holds is the secret material, the URLs, the guard rails, and OPTIONAL
   * per-plan "pins": when an env var below is set, the catalog row must match it
   * or the request is refused. That gives a deployment the option to freeze the
   * Stripe ids in the environment without creating a second catalog that can
   * silently drift from the first.
   */
  stripe: {
    // Server-side secret key (sk_...). No default: a missing key must be a
    // startup failure in production, not a runtime surprise at first checkout.
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    // Signing secret (whsec_...) for the webhook endpoint. Without it every
    // event would have to be trusted unverified, so the handler refuses to run.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // Leave unset to use the SDK's pinned API version. Only set this when you
    // have tested against that specific version.
    apiVersion: process.env.STRIPE_API_VERSION || undefined,
    /*
     * Re-read every Price from Stripe before it reaches a Checkout Session, so
     * a price deactivated or re-pointed in the dashboard cannot be sold from a
     * stale local row. Disabled automatically under test (no network).
     */
    verifyPricesWithApi: process.env.STRIPE_VERIFY_PRICES !== 'false',
    // Validated Price objects are memoised for this long, so a checkout that
    // touches five plans does not cost five round trips on every click.
    priceCacheTtlSeconds: parseInt(process.env.STRIPE_PRICE_CACHE_TTL_SECONDS, 10) || 60,
  },
  billing: {
    // Where Stripe returns the browser. {CHECKOUT_SESSION_ID} is substituted by
    // Stripe itself; the success page must still call the status endpoint —
    // landing on it is not proof of payment.
    checkoutSuccessUrl:
      process.env.STRIPE_CHECKOUT_SUCCESS_URL ||
      `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    checkoutCancelUrl:
      process.env.STRIPE_CHECKOUT_CANCEL_URL ||
      `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/cancelled`,
    // The only currency the checkout flow will assemble. Every resolved Price
    // must match, so a plan mis-seeded in EUR cannot join a USD session.
    supportedCurrency: (process.env.BILLING_SUPPORTED_CURRENCY || 'USD').toUpperCase(),
    // Upper bounds on the payroll quantities. These are sanity limits, not
    // business limits: they stop a typo (or a script) turning into a five-figure
    // invoice. Raise them if a real customer legitimately exceeds them.
    maxEmployeeCount: parseInt(process.env.BILLING_MAX_EMPLOYEE_COUNT, 10) || 5000,
    maxContractorCount: parseInt(process.env.BILLING_MAX_CONTRACTOR_COUNT, 10) || 5000,
    /*
     * Echo the resolved Stripe product/price ids in the pricing summary. Useful
     * while wiring the frontend up; off in production, where the client only
     * needs our own option ids and the amounts.
     */
    exposeStripeIds: process.env.BILLING_EXPOSE_STRIPE_IDS
      ? process.env.BILLING_EXPOSE_STRIPE_IDS === 'true'
      : process.env.NODE_ENV !== 'production',
    /*
     * What Stripe does about money already paid when a payroll head count
     * changes mid-period. `create_prorations` (the default) credits the unused
     * part of the old quantity and charges the new one pro rata, settling on the
     * next invoice — the fair, least-surprising behaviour, and the one that keeps
     * a customer from paying twice for the same fortnight. `none` bills the new
     * quantity only from the next period. `always_invoice` charges the difference
     * immediately instead of waiting.
     */
    prorationBehavior: process.env.BILLING_PRORATION_BEHAVIOR || 'create_prorations',
    // Where Stripe's hosted billing portal returns the browser.
    portalReturnUrl:
      process.env.STRIPE_PORTAL_RETURN_URL ||
      `${process.env.FRONTEND_URL || 'http://localhost:5173'}/billing`,
    // Page size cap for payment history.
    maxPageSize: parseInt(process.env.BILLING_MAX_PAGE_SIZE, 10) || 100,
  },
  db: {
    // When set (e.g. Supabase/Neon), the connection string takes precedence
    // over the individual DB_* fields below.
    url: process.env.DATABASE_URL || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'Finopsys Portal',
    // Supabase requires SSL. Enabled automatically for a remote connection
    // string, or force it with DB_SSL=true.
    ssl: process.env.DB_SSL === 'true' || Boolean(process.env.DATABASE_URL),
    /*
     * Connection-pool and transaction timing. The defaults are tuned for a
     * remote managed Postgres (Supabase), where establishing a connection costs
     * a TLS handshake and the stock 2s transaction acquisition window produces
     * spurious P2028 "unable to start a transaction" errors.
     */
    poolMax: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    connectTimeoutMs: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 15000,
    // maxWait: time allowed to acquire a connection for a transaction.
    txMaxWaitMs: parseInt(process.env.DB_TX_MAX_WAIT_MS, 10) || 15000,
    // timeout: time allowed for the transaction body once it has started.
    txTimeoutMs: parseInt(process.env.DB_TX_TIMEOUT_MS, 10) || 20000,
  },
};

config.isProduction = config.env === 'production';
config.isDevelopment = config.env === 'development';

/*
 * Whether error responses may carry a stack trace and the raw message of a
 * server error.
 *
 * Gated on an explicit opt-in rather than on `NODE_ENV !== 'production'`. That
 * older test was true whenever NODE_ENV was merely unset — which it is by
 * default — so any deployment that had not thought to set it was returning file
 * paths and internal call frames to clients. An absent environment variable
 * should never be the thing that decides to disclose internals; say so on
 * purpose, or get the safe behaviour.
 */
config.exposeErrorDetails = process.env.DEBUG_ERRORS
  ? process.env.DEBUG_ERRORS === 'true'
  : config.env === 'development' || config.env === 'test';

/*
 * Fail fast on a missing JWT secret in production: without it the auth routes
 * would sign every token with an empty key. Outside production we fall back to
 * an obviously-fake secret so `npm run dev` and the test suite work without any
 * setup — that token is worthless to anyone and must never be used live.
 */
if (!config.auth.jwtSecret) {
  if (config.isProduction) {
    throw new Error('JWT_SECRET must be set in production.');
  }
  config.auth.jwtSecret = 'insecure-dev-secret-do-not-use-in-production';
}

/*
 * The OTP digest secret gets the same fail-fast treatment as the JWT secret:
 * without it every deployment would key its OTP HMAC with an empty string, so a
 * six-digit code (only a million possibilities) could be forged offline.
 */
if (!config.otp.secret) {
  if (config.isProduction) {
    throw new Error('OTP_SECRET must be set in production.');
  }
  config.otp.secret = 'insecure-dev-otp-secret-do-not-use-in-production';
}

/*
 * Stripe credentials get the same fail-fast treatment, with one difference: there
 * is no dev fallback, because a fake Stripe key cannot do anything useful. Outside
 * production the app starts without them and the billing routes answer 503
 * STRIPE_NOT_CONFIGURED until they are supplied — so the rest of the API (auth,
 * onboarding, the whole test suite) still runs with no Stripe account at all.
 */
if (config.isProduction) {
  if (!config.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY must be set in production.');
  }
  if (!config.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set in production.');
  }
}

// The test suite has no network and no Stripe account, so live Price verification
// is forced off there; the resolver falls back to the local catalog row.
if (config.env === 'test') {
  config.stripe.verifyPricesWithApi = false;
}

module.exports = config;
