'use strict';

const path = require('path');

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
 * THE HOST'S OWN CEILING ON A REQUEST OR RESPONSE BODY.
 *
 * Vercel does not hand a function the raw socket: every request and every
 * response is buffered whole by the platform's gateway first, and to keep that
 * from exhausting memory the body is capped at roughly 4.5 MB. It is a platform
 * limit, not a plan one — no Pro or Enterprise upgrade lifts it — and it applies
 * before any of this application's code runs.
 *
 * That mattered because our own limits were written for a normal server: a 25 MB
 * document was accepted by the config, refused by the platform, and the user saw
 * Vercel's error page instead of the message this API would have given them. A
 * limit the user cannot see is worse than a lower one they can.
 *
 * ONLY THE AVATAR IS STILL SUBJECT TO IT. Project documents no longer travel
 * through this API in either direction — the browser PUTs them to a signed URL
 * and fetches them from one — so their limits describe what Supabase and this
 * business allow, and nothing about the host. A profile picture is small enough
 * that routing it through a function is simpler than a ticket exchange, so it
 * stays, and stays clamped.
 *
 * So on Vercel — and only there, detected by the platform's own VERCEL variable —
 * a limit describing a body that travels THROUGH this API is clamped to sit
 * inside the ceiling, and the request is refused by our validator with our
 * wording.
 *
 * THE CLAMP OVERRIDES AN EXPLICIT SETTING, unlike every other option in this
 * file, because it is not a policy — it is a fact about where the code is
 * running. Setting UPLOAD_MAX_DOCUMENT_BYTES to 25 MB on Vercel does not make a
 * 25 MB multipart upload arrive; it only decides whether the user is told why.
 * Off Vercel the clamp does nothing at all, so a container or a VM keeps exactly
 * the number it was given.
 *
 * 4 MB rather than 4.5: the cap counts the whole HTTP body, and a multipart
 * upload carries field names and boundaries alongside the file itself.
 */
const PLATFORM_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const HAS_PLATFORM_BODY_LIMIT = process.env.VERCEL === '1';

function clampToPlatform(bytes) {
  return HAS_PLATFORM_BODY_LIMIT ? Math.min(bytes, PLATFORM_BODY_LIMIT_BYTES) : bytes;
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
 * 8 hours — one working day, so a signed-in user is not asked to re-authenticate
 * partway through a shift. This is a deliberate trade: an access token is
 * stateless and cannot be revoked before it expires, so a leaked one stays
 * useful for the whole window. What bounds the damage is /auth/refresh (rotated,
 * revocable, hashed at rest) and the freshness check in requireAuth, which
 * rejects any token predating the last password change. Shorten this to '15m'
 * via ACCESS_TOKEN_TTL for a deployment that wants the tighter posture.
 */
const DEFAULT_ACCESS_TOKEN_TTL = '8h';

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
    /*
     * The background reconcile sweep — the safety net under a lost webhook.
     *
     * Every path that writes a subscription's Stripe ids depends on something
     * outside this process staying up: the webhook needs a listener to be
     * running, and the self-heal in getCheckoutStatus needs the browser to come
     * back to the success page. Miss both — a dev machine with no `stripe
     * listen`, a customer who closed the tab — and a PAID subscription sits at
     * INCOMPLETE forever, because Stripe stops retrying and nothing else ever
     * asks.
     *
     * This sweep is the thing that always asks. It re-runs the same
     * reconcileFromCheckoutSession the success page would have triggered, so
     * there is one definition of repair rather than two.
     */
    reconcileSweep: {
      // Off under test: it would spawn a timer and hit the Stripe API.
      enabled: process.env.BILLING_RECONCILE_SWEEP_ENABLED
        ? process.env.BILLING_RECONCILE_SWEEP_ENABLED === 'true'
        : process.env.NODE_ENV !== 'test',
      intervalSeconds: parseInt(process.env.BILLING_RECONCILE_SWEEP_INTERVAL_SECONDS, 10) || 300,
      /*
       * Only sessions younger than this are considered. A Checkout Session
       * expires after 24h, so an older INCOMPLETE row is an abandoned checkout —
       * a normal, permanent state — and re-reading it from Stripe every five
       * minutes forever would be pure API burn.
       */
      lookbackHours: parseInt(process.env.BILLING_RECONCILE_SWEEP_LOOKBACK_HOURS, 10) || 48,
      // Bound on one pass, so a backlog cannot turn into a burst of API calls.
      batchSize: parseInt(process.env.BILLING_RECONCILE_SWEEP_BATCH_SIZE, 10) || 25,
    },
  },
  /*
   * Uploaded files — today just profile pictures.
   *
   * The database stores a KEY ("avatars/18/9f3c2a.jpg"); everything needed to
   * turn that into bytes on disk and into a URL a browser can fetch lives here,
   * so the two are defined once and cannot drift.
   *
   * `dir` is deliberately outside `src/`: nodemon watches the source tree, and
   * writing an upload into it would restart the server on every avatar change.
   * It is served read-only by express.static at `publicPath` (see app.js).
   *
   * MOVING TO S3/R2 LATER is a change to this block plus the two fs calls in
   * userService — the stored keys stay valid, because a key is not a URL.
   */
  uploads: {
    dir: process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'),
    // Mount path of the static file server. Must not collide with apiPrefix.
    publicPath: process.env.UPLOAD_PUBLIC_PATH || '/uploads',
    /*
     * Origin prepended to publicPath when building `avatarUrl`. Absolute rather
     * than relative because the frontend runs on a different origin (5173) than
     * this API, so a bare "/uploads/..." would resolve against the wrong host.
     */
    publicBaseUrl:
      process.env.UPLOAD_PUBLIC_BASE_URL ||
      `http://localhost:${parseInt(process.env.PORT, 10) || 3000}`,
    // 2 MB. An avatar is displayed at ~256px; anything larger is a phone camera
    // original that will be downscaled to nothing in the browser anyway. Enforced
    // by multer, which aborts the stream at the limit rather than buffering it.
    //
    // Clamped because this is the one upload still carried by this API — see
    // PLATFORM_BODY_LIMIT_BYTES. At 2 MB the clamp changes nothing today; it is
    // here so that raising this value on Vercel produces our error rather than
    // the platform's.
    maxAvatarBytes: clampToPlatform(parseInt(process.env.UPLOAD_MAX_AVATAR_BYTES, 10) || 2 * 1024 * 1024),
    // How long a browser may cache an avatar. Long is safe: every upload gets a
    // new random filename, so a changed picture is a changed URL.
    cacheMaxAgeSeconds: parseInt(process.env.UPLOAD_CACHE_MAX_AGE_SECONDS, 10) || 86400,

    /*
     * Project documents live in a DIFFERENT root, and that is the single most
     * important line in this block. (Local driver only — under the supabase
     * driver the same separation is the private `documentsBucket` below.)
     *
     * `dir` above is handed to express.static and served to anyone who knows the
     * URL — deliberately, because an <img src> cannot send an Authorization
     * header (see app.js). A project document is a company's bank statement or
     * payroll register. Writing one under `dir` would publish it, and no amount
     * of care in the service layer would undo that: the static handler runs
     * before the router and never sees a token.
     *
     * So documents get their own tree, nothing serves it statically, and the
     * only way to read a byte out of it is GET
     * /projects/:projectId/documents/:documentId/download — which authorizes
     * the caller against the project's company first.
     */
    documentsDir:
      process.env.UPLOAD_DOCUMENTS_DIR || path.join(__dirname, '..', '..', 'private-uploads'),
    /*
     * 25 MB per file. A scanned year of bank statements is the realistic upper
     * end of what this feature carries; anything larger is a video or a mistake.
     *
     * NOT clamped by the platform ceiling, unlike the avatar above, because a
     * document never passes through this API: the browser uploads it to a signed
     * URL and downloads it from one. This number is therefore a real business
     * limit rather than a description of the host, and it is enforced twice — once
     * against the size the client declares, so an oversized file is refused before
     * anyone waits for it to upload, and again against the size the bucket reports
     * once it has, which is the check that actually binds.
     */
    maxDocumentBytes: parseInt(process.env.UPLOAD_MAX_DOCUMENT_BYTES, 10) || 25 * 1024 * 1024,
    /*
     * Files accepted in ONE request. A cap is needed because the per-file limit
     * says nothing about the total: without this, one request could carry a
     * thousand 25 MB files. Ten matches what a person drags onto a form in one
     * go; more than that is several requests, which the rate limiter then sees.
     */
    maxDocumentsPerRequest: parseInt(process.env.UPLOAD_MAX_DOCUMENTS_PER_REQUEST, 10) || 10,
    /*
     * Documents in ONE bulk download (POST .../documents/links).
     *
     * A COUNT AND NOT A BYTE TOTAL, which is the whole difference from what this
     * endpoint used to be. When it returned a zip, the bytes were the binding
     * limit: every file had to be fetched and held in memory to build the
     * archive, so fifty 25 MB scans meant 1.25 GB in a serverless function. Now it
     * returns links, and the response is the same handful of kilobytes whether the
     * documents behind it are 50 KB or 50 GB — the bytes go from the bucket to the
     * browser and never pass through here at all.
     *
     * What survives is this count, because minting a link is a round trip to the
     * bucket and fifty is already generous for one screen's selection. A larger
     * request is refused with a 413 naming the limit, so the client can split it.
     */
    maxArchiveDocuments: parseInt(process.env.UPLOAD_MAX_ARCHIVE_DOCUMENTS, 10) || 50,
  },
  /*
   * WHERE THE BYTES ACTUALLY LIVE.
   *
   * The `uploads` block above describes the files; this one describes the shelf
   * they sit on. Two drivers, chosen by whether Supabase credentials are
   * present:
   *
   *   local      a folder on this machine. Correct for `npm run dev` and for the
   *              test suite, which must not need a network or a bucket.
   *   supabase   Supabase Storage. REQUIRED IN ANY DEPLOYED ENVIRONMENT, because
   *              a serverless host has no durable disk: on Vercel the project
   *              tree is read-only and /tmp is wiped between invocations, so a
   *              file written during an upload is gone before the download that
   *              wants it. That is not a theoretical failure — it is the reason
   *              every document download from the deployment returned 404 while
   *              the list endpoint, which touches only Postgres, worked fine.
   *
   * The driver is INFERRED rather than configured, so no deployment can be one
   * env var away from silently writing to a disk that will not survive. Set the
   * two Supabase values and files go to the bucket; leave them unset and they go
   * to a folder.
   *
   * THE STORED KEY IS THE SAME SHAPE UNDER BOTH ("avatars/18/9f3c.jpg",
   * "projects/5/1a2b.pdf"), which is what lets a database written by one driver
   * be read by the other, and what keeps every avatar row valid across the
   * switch. A key is not a URL — see dto/userDto.avatarUrl.
   */
  storage: {
    /*
     * `NEXT_PUBLIC_SUPABASE_URL` is accepted as a fallback because the frontend
     * already carries the same value under that name and one project URL in two
     * variables is a thing to keep in sync and eventually get wrong. Safe to read
     * a NEXT_PUBLIC_ variable here precisely because a project URL is not a
     * secret — it is in every browser request the frontend makes. The KEY below
     * has no such fallback, and must not grow one: NEXT_PUBLIC_ means "shipped to
     * the browser", which is the one thing a service-role key must never be.
     */
    url: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, ''),
    // The SERVICE ROLE key, not the anon key. These buckets are written from the
    // server only, and the documents bucket is private — an anon key cannot read
    // it, which is the entire point of keeping documents out of the public one.
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    /*
     * THE TEST SUITE IS FORCED ONTO THE LOCAL DRIVER, unconditionally, and this
     * is not a convenience.
     *
     * Several suites drive the storage layer for real rather than stubbing it —
     * that is what makes them worth having. The moment real Supabase credentials
     * appear in a developer's .env, those same tests would start writing probe
     * files into the real bucket and deleting them again, against whatever
     * project that key belongs to. A test run must
     * never be able to touch live storage, and the only reliable place to
     * guarantee that is here, above every test file, rather than in each one's
     * setup where a new file would simply forget.
     *
     * A test that genuinely needs the remote driver mocks utils/storage.
     */
    get driver() {
      if (process.env.NODE_ENV === 'test') return 'local';
      return this.url && this.serviceKey ? 'supabase' : 'local';
    },
    /*
     * TWO BUCKETS, AND THEY MUST HAVE DIFFERENT VISIBILITY.
     *
     * avatars    PUBLIC. An <img src> cannot send an Authorization header, so a
     *            profile picture has to be fetchable by URL alone. Safe because
     *            the filename is 32 random hex characters — unguessable and
     *            unenumerable — and because nothing confidential is ever written
     *            here. This mirrors exactly what express.static does locally.
     *
     * documents  PRIVATE. A client's bank statement or payroll register. Nothing
     *            reads it but this server, and the only way out is
     *            GET /projects/:id/documents/:id/download, which authorizes the
     *            caller against the project's company first. Making this bucket
     *            public would publish every client's financial records to anyone
     *            with the URL, and no care in the service layer would undo it.
     */
    avatarBucket: process.env.SUPABASE_AVATAR_BUCKET || 'avatars',
    documentsBucket: process.env.SUPABASE_DOCUMENTS_BUCKET || 'project-documents',
    /*
     * How long a signed download link stays valid.
     *
     * Short, because the link IS the authorization once it exists: anyone holding
     * it can fetch the object without a token, so its lifetime is the window in
     * which a leaked URL — out of a browser history, a proxy log, a pasted
     * message — is still worth something.
     *
     * Sixty seconds is far longer than the redirect it exists for (the browser
     * follows it immediately) and far too short to be worth passing around. It is
     * not a limit on the DOWNLOAD: a transfer already in progress when the link
     * expires runs to completion, so a slow connection on a large file is not cut
     * off. Only STARTING a new fetch needs a fresh link, which means a re-request
     * to this API, which means the access check runs again.
     */
    signedUrlTtlSeconds: parseInt(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS, 10) || 60,
  },
  /*
   * LIVE CHAT — Supabase Realtime, and why the browser needs a second token.
   *
   * This API is deployed to Vercel as serverless functions with a 10-second
   * ceiling per request (vercel.json), so it cannot hold a WebSocket or an SSE
   * stream open: the connection would be cut mid-conversation every ten seconds.
   * services/realtimeService — the admin SSE channel — works only because a long
   * local `npm run dev` process is where it is used.
   *
   * Supabase already holds those sockets and already reads the Postgres
   * replication stream, so the browser subscribes to it DIRECTLY and this API
   * stays out of the live path entirely. What it still has to do is say who the
   * browser is: this application signs its own JWTs, so a Supabase connection
   * would otherwise arrive anonymous and the RLS policies in
   * db/schema/21_add_chat_realtime.sql would show it nothing.
   *
   * GET /chat/realtime-token mints that bridge — a Supabase-shaped JWT carrying
   * this user's id — and the secret below is what signs it.
   */
  realtime: {
    /*
     * The Supabase project's JWT secret (Dashboard -> Project Settings -> API ->
     * JWT Settings). The SAME secret Supabase verifies its own tokens with,
     * which is exactly why it is not `JWT_SECRET`: that one is this API's, and a
     * single secret signing both would mean a token minted for a chat socket was
     * also a valid access token for every endpoint here.
     *
     * No fallback and no default. An unset value disables live chat with a clear
     * 503 (see chatRealtimeService) rather than minting tokens Supabase will
     * reject — a signature failure at the socket looks like a network fault and
     * is diagnosed as one.
     */
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || '',
    /*
     * How long a realtime token is good for. Thirty minutes: long enough that a
     * user reading a thread is not interrupted, short enough that a token
     * scraped out of a browser session stops working within the hour. The client
     * re-requests one when the socket closes, which costs one call.
     *
     * It grants strictly less than an access token does — a read-only
     * subscription to rows the RLS policies already allow, with no INSERT,
     * UPDATE or DELETE policy anywhere on the chat tables — so its expiry is
     * about limiting a leak, not about session length.
     */
    tokenTtlSeconds: parseInt(process.env.SUPABASE_REALTIME_TOKEN_TTL_SECONDS, 10) || 30 * 60,
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
    connectTimeoutMs: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 10000,
    // maxWait: time allowed to acquire a connection for a transaction.
    txMaxWaitMs: parseInt(process.env.DB_TX_MAX_WAIT_MS, 10) || 10000,
    // timeout: time allowed for the transaction body once it has started.
    txTimeoutMs: parseInt(process.env.DB_TX_TIMEOUT_MS, 10) || 15000,
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
