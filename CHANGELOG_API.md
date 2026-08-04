# API Remediation — What Changed and What To Do

Companion to `API_INTEGRATION.md` (the contract) and `API_GAPS_AND_QUESTIONS.md` (remaining gaps).

**Test suite:** 343 tests across 13 suites, all passing (was 277 across 10).

---

## 1. ⚠ Do this first — leaked credentials

`.env.example` is **tracked by git** and contained real, working credentials. They were committed in `c58b85c` and remain in the history even now that the file is sanitised.

**Rotate all of these before anything else:**

| Variable | What it was |
| --- | --- |
| `SMTP_PASSWORD` | a real mailbox password |
| `SMTP_USER` / `SMTP_FROM` | a real mailbox address |
| `STRIPE_SECRET_KEY` | a live Stripe **test-mode** secret key |
| `STRIPE_WEBHOOK_SECRET` | a real webhook signing secret |
| `NEXT_PUBLIC_SUPABASE_*` | Supabase project URL + key |

Rotating is not optional because the file was edited: git keeps every previous version, so anyone with repository access (now or in the past) can still read the originals. If the repository has ever been public or shared beyond the team, treat all five as compromised.

The file now carries a header warning and placeholders only. Real values belong in `.env`, which is gitignored.

---

## 2. Deployment steps

### 2.1 Database — run the new migrations

```bash
node scripts/run-sql.js db/schema/10_add_refresh_rotation_refunds_and_audit.sql --dry-run
node scripts/run-sql.js db/schema/10_add_refresh_rotation_refunds_and_audit.sql

node scripts/run-sql.js db/schema/11_hash_invitation_tokens.sql --dry-run
node scripts/run-sql.js db/schema/11_hash_invitation_tokens.sql
```

`scripts/run-sql.js` applies a `db/schema/` file through the `pg` driver, for machines without `psql`. `--dry-run` applies the file inside a transaction and rolls it back, so a syntax or constraint problem surfaces before anything is written. Or paste the SQL into the Supabase SQL editor.

**Migration 11 drops `invitations.token`.** It backfills `token_hash` from the raw value first, so invitation links already in inboxes keep working — but once it has run, the raw tokens are gone and cannot be recovered.

Backward compatible: every new column is nullable or defaulted, so the previous application version keeps working against this schema. It adds

- refresh-token rotation columns (`family_id`, `replaced_by_id`, `revoked_reason`, context hashes),
- refund tracking on `company_payments` (`amount_refunded`, `refunded_at`, `stripe_charge_id`),
- a partial unique index enforcing one active OTP challenge per `(user, purpose)`.

Then:

```bash
npm install          # adds helmet + cookie-parser
npx prisma generate
```

### 2.2 Environment — set these

| Variable | Why |
| --- | --- |
| **`NODE_ENV`** | Set it **explicitly everywhere**. Secure cookies, HSTS and CORS strictness key off it, and an unset value silently means `development`. |
| **`CORS_ORIGIN`** | Now a real allowlist. `*` is **refused at startup in production**. List exact origins: `https://portal.example.com,https://admin.example.com` |
| **`ACCESS_TOKEN_TTL`** | Default is now `15m` (was `615m` ≈ 10¼ hours). Leave it short — refresh exists now. |
| **`TRUST_PROXY`** | Required behind a load balancer, or per-IP rate limiting throttles all users as one and HTTPS detection misreads the scheme. |
| `DEBUG_ERRORS` | Stack traces. Defaults on for dev/test, off elsewhere. |
| `FORCE_HTTPS`, `HSTS_MAX_AGE_SECONDS` | Default on in production. |
| `CSRF_ENABLED`, `CSRF_COOKIE_NAME`, `CSRF_HEADER_NAME` | Default on. |
| `BODY_LIMIT` | Default `100kb`. |
| `INVITATION_TTL_DAYS` | Default `30`. |

### 2.3 Stripe — subscribe to two more events

Add to the webhook endpoint: **`charge.refunded`** and **`charge.dispute.created`**. Without them refunds stay invisible and `PaymentStatus.REFUNDED` is never written.

### 2.4 Frontend — the breaking bits

Nothing breaks on the **request** side: snake_case is still accepted everywhere.

Responses change. See §5 of `API_INTEGRATION.md` for the full table; the ones that bite hardest:

1. All response keys are camelCase.
2. Money fields renamed to `...AmountMinor`.
3. `GET /billing/subscription` returns `200 { hasSubscription, subscription }` instead of `404`.
4. `POST /invitations` now requires an `ADMIN` Bearer token and rejects `invitedBy`.
5. Access tokens expire in 15 minutes — implement the refresh flow.

---

## 3. What was fixed

### 3.1 Security

| Issue | Fix |
| --- | --- |
| `POST /invitations` had **no authentication** and took `invitedBy` from the body — anyone could send branded email as any active user | `requireAuth` + `ADMIN` gate; inviter is the token subject; `invitedBy` rejected |
| Credentialed CORS reflected **any** origin (`CORS_ORIGIN=*`) | Explicit allowlist; `*` refused in production; dev fallback to localhost only |
| Stack traces returned whenever `NODE_ENV` was unset — i.e. by default | Gated on explicit `DEBUG_ERRORS` |
| No CSRF, with a cookie credential in play | Double-submit tokens on `/auth/refresh` and `/auth/logout` |
| No security headers, no HTTPS enforcement | `helmet`, HSTS, HTTP→HTTPS redirect in production |
| `password_changed_at` written but never read — a reset left an existing access token usable | Enforced in `requireAuth`; such tokens now `401` |
| Access token lifetime ~10 hours, unrevocable | 15 minutes, with rotation |
| No way to end a session | `/auth/logout`, `/auth/logout-all` |
| Refresh tokens minted but never consumable | `/auth/refresh` with rotation **and reuse detection** — replaying a rotated token revokes the whole family |

### 3.2 Blocked frontend work

| Issue | Fix |
| --- | --- |
| No way to list a user's companies — `companyId` was returned once and unrecoverable | `GET /api/companies`, with `accessRole` per row |
| No user directory — assignment fields required a `userId` nothing exposed | `GET /api/users` |
| No company read/update/delete | `GET`/`PATCH`/`DELETE /api/companies/:companyId` |
| Team payload lacked `assignmentId`, so a remove button had no id | each specialization now carries one |
| Adding a service to a live subscription was impossible — a revenue dead end | `POST /api/billing/subscription/services` |
| No invitation list/revoke/resend; `REVOKED` and `EXPIRED` unreachable | all three added |
| **Invitation tokens stored in plain text** — the only credential in the schema kept readable, and enough to complete a signup as the invited person | hashed with SHA-256 (`invitations.token_hash`); the raw column is dropped. Existing links keep working — the digest was backfilled from the raw value, verified byte-for-byte against Node's hash before the column was removed |
| `expiresInSeconds` was `null` (config bug) | real number, derived from the signed TTL |
| Role changed by onboarding but the token was not reissued → `403` on the next step | token reissued, **and** `requireRole` falls back to the database with `X-Token-Stale: true` |

### 3.3 Contract consistency

| Issue | Fix |
| --- | --- |
| camelCase in auth/onboarding, snake_case in company/billing | both accepted in; camelCase out |
| Sending both spellings of a field silently dropped one | explicit `400` naming the conflict |
| `emailSent` outside `data`; `message` sometimes missing | envelope uniform everywhere |
| Money as bare `unit_amount` — trivially rendered as dollars | `...AmountMinor` |
| Stripe ids as siblings that vanish in production | grouped under one `stripe` key |
| `GET /billing/subscription` 404'd on a normal empty state | `200` with `hasSubscription` |
| Two codes carried two different statuses | separated |
| Body-parser errors surfaced as `500` | `400 MALFORMED_JSON` / `413 PAYLOAD_TOO_LARGE` |
| No refund handling; `REFUNDED` unreachable | `charge.refunded` + `charge.dispute.created`, partial refunds supported |

### 3.4 Validation

Consolidated into `src/validators/common.js`, which removed five copies of the email rule and two of the phone rule.

- Email capped at **254 everywhere** — signup allowed 255 while login allowed 254, so an address of exactly 255 could register and never log in.
- Control-character rejection now applies to every string, not just two endpoints.
- `countryCode` checked against the real ISO 3166-1 list — `XX` was accepted.
- `postalCode` format-checked for ~20 countries.
- US `state` validated **and normalised**: `"Texas"` and `"TX"` both accepted, `"TX"` stored.
- `employeeCount` bounded (was unbounded at onboarding, capped at billing).
- `invitationToken` shape-checked (64 hex) before any lookup.
- Unknown fields rejected on **every** endpoint — auth and onboarding used to ignore them silently, which is the worst failure mode a form can have.

### 3.5 Lists

Pagination and sorting on companies, users, invitations, specialists and payments. `sort` is always an allowlist, never forwarded to `ORDER BY`.

### 3.6 Operations

- `GET /api/health` actually round-trips a database query.
- Auth events (`auth.refresh.rotated`, `auth.refresh.reuse_detected`, `auth.logout*`, `invitation.*`) go through the structured audit log.
- Removed unused `@supabase/*` and `@neondatabase/serverless` dependency usage from the documented surface (the packages remain in `package.json` pending confirmation — see Q-12).

---

## 4. Behaviour changes worth knowing

1. **`requireRole` may hit the database.** Only when the token claim fails; a matching claim still short-circuits. Prevents a stale claim from wrongly refusing a legitimate caller.
2. **`requireAuth` reads one row per request** (`passwordChangedAt`, `status`) to enforce token freshness. Fails *open* on a database error — the token is already cryptographically verified, so failing closed would turn a blip into a total outage.
3. **Concurrent refreshes.** Two tabs refreshing at once: one wins, the other gets `401 REFRESH_TOKEN_INVALID` — deliberately *not* the family-wide revoke, which would log the user out everywhere. Share one in-flight refresh promise on the client.
4. **Soft-deleting a company is refused while a subscription is live** (`409 SUBSCRIPTION_STILL_ACTIVE`). Cancel first, so Stripe stops charging for something the customer can no longer see.
5. **Partial refunds keep `status: "PAID"`** with a non-zero `amountRefundedMinor`; only a full refund becomes `REFUNDED`.

---

## 5. Files added

| File | Purpose |
| --- | --- |
| `src/utils/caseTransform.js` | deep key translation + collision detection |
| `src/middlewares/normalizeRequest.js` | reconciles inbound casing once, before validation |
| `src/middlewares/csrf.js` | double-submit CSRF |
| `src/validators/common.js` | the shared validation primitives |
| `src/validators/invitationValidator.js` | invitation bodies and list queries |
| `src/services/refreshTokenService.js` | rotation, reuse detection, revocation |
| `src/services/invitationService.js` | invitation lifecycle |
| `src/dto/invitationDto.js` | invitation response shape |
| `src/config/countries.js` | ISO codes, postal formats, US state normalisation |
| `src/routes/userRoutes.js` | the user directory |
| `db/schema/10_…sql` | the migration |
| `tests/invitations.test.js` | 22 tests — this module had **none** |
| `tests/auth.session.test.js` | 18 tests for refresh/logout/rotation |
| `tests/contract.caseAndDiscovery.test.js` | 26 tests for casing + the new endpoints |
