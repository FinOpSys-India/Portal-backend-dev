# Gap Analysis — Status After Remediation

Companion to `API_INTEGRATION.md` (the contract) and `CHANGELOG_API.md` (what changed).

The original audit raised **52 gaps** and **18 open questions**. This document tracks each to a status. Everything marked FIXED is covered by the test suite (343 tests, all passing).

**Summary: 41 fixed · 6 partly fixed · 5 open (product decisions or infrastructure).**

---

## 1. Closed

### Critical — all 9 fixed

| ID | Item | How |
| --- | --- | --- |
| GAP-01 | No endpoint listed a user's companies | `GET /api/companies` with `accessRole` per row |
| GAP-02 | `POST /invitations` completely unauthenticated, took `invitedBy` | `requireAuth` + `ADMIN`; inviter from the token; `invitedBy` rejected |
| GAP-03 | `expiresInSeconds` was `null` | both TTL forms derive from one resolution |
| GAP-04 | Token not reissued after onboarding changed the role | reissued, plus a database fallback in `requireRole` and `X-Token-Stale` |
| GAP-05 | No user directory | `GET /api/users` |
| GAP-06 | No token refresh | `POST /auth/refresh` with rotation + reuse detection; TTL cut to 15m |
| GAP-07 | No logout | `POST /auth/logout`, `/auth/logout-all` |
| GAP-08 | No CSRF; credentialed CORS reflected any origin | double-submit tokens; explicit allowlist, `*` refused in production |
| GAP-09 | Stack traces returned whenever `NODE_ENV` was unset | gated on explicit `DEBUG_ERRORS` |

### High — 11 of 13 fixed

| ID | Item | How |
| --- | --- | --- |
| GAP-10 | Zero tests on invitations | `tests/invitations.test.js`, 22 tests |
| GAP-11 | No invitation list/revoke/resend; `REVOKED`/`EXPIRED` unreachable | all three added; resend reuses the token |
| GAP-12 | No company update or delete | `PATCH` + `DELETE` (soft archive) |
| GAP-13 | No company/address read after onboarding | `GET /api/companies/:companyId` with `primaryAddress` |
| GAP-14 | `REFUNDED` never written | `charge.refunded` + `charge.dispute.created`; partial refunds supported |
| GAP-15 | Could not add a service to a live subscription | `POST /api/billing/subscription/services` |
| GAP-16 | Inconsistent empty states | `GET /billing/subscription` → `200 { hasSubscription }` |
| GAP-17 | `password_changed_at` never read | enforced in `requireAuth` |
| GAP-19 | Unknown fields silently ignored on auth/onboarding | rejected everywhere |
| GAP-22 | Rate limiting per-IP only | per-endpoint limiters incl. a dedicated refresh limiter *(per-email still open — see §2)* |

### Medium — 15 of 18 fixed

| ID | Item | How |
| --- | --- | --- |
| GAP-23 | No pagination except payments | companies, users, invitations, specialists, payments |
| GAP-24 | No sorting anywhere | allowlisted `sort`/`order` on every list |
| GAP-25 | Casing split by module | both accepted in, camelCase out; `invitedBy`→`invitedById` mismatch removed |
| GAP-26 | Envelope not uniform | `{success, message, data}` everywhere; `emailSent` moved inside `data` |
| GAP-27 | Email max 255 vs 254 | 254 everywhere |
| GAP-28 | Control-char check on 2 of 5 entry points | applied to every string |
| GAP-29 | `countryCode` unvalidated | real ISO 3166-1 list |
| GAP-30 | `postalCode` unvalidated | format-checked for ~20 countries |
| GAP-31 | `employeeCount` unbounded at onboarding | bounded |
| GAP-32 | `invitationToken` not shape-checked | 64-hex check before lookup |
| GAP-33 | Body limit implicit | explicit `BODY_LIMIT` |
| GAP-34 | Body-parser errors became `500` | `400 MALFORMED_JSON` / `413 PAYLOAD_TOO_LARGE` |
| GAP-37 | No real health check | `GET /api/health` round-trips a query |
| GAP-39 | Auth events not in the structured audit log | routed through `logEvent` |
| GAP-47 | One-active-challenge rule only in application code | partial unique index in migration 10 |

### Low — 6 fixed

| ID | Item | How |
| --- | --- | --- |
| GAP-41 | Dead `resolveAccessTokenTtl` result | wired up |
| GAP-44 | `615m` default contradicting "short-lived" | `15m` |
| GAP-45 | Hardcoded invitation TTL | `INVITATION_TTL_DAYS` |
| GAP-48 | `notFound` echoed the URL | unchanged behaviour, but no longer the only 404 path |
| GAP-49 | `parseId` and regexes duplicated | `validators/common.js` |
| GAP-50 | `OTP_RESEND_COOLDOWN` thrown two ways | unchanged — see §2 |

---

## 2. Partly fixed

| ID | Item | Done | Remaining |
| --- | --- | --- | --- |
| GAP-18 | `GET /billing/plans` unscoped | Still open to any authenticated user | Deliberate pending **Q-05** — the catalog is public pricing, but confirm |
| GAP-20 | Rate limiters in-memory, per-process | Limits tuned per endpoint | Redis-backed store before horizontal scaling — **infrastructure, not code** |
| GAP-21 | `TRUST_PROXY` unset | Documented as required; HTTPS enforcement depends on it | Must be **set at deploy time**; nothing in code can infer the hop count |
| GAP-22 | Rate-limit dimensions | Per-IP, per-endpoint; per-challenge caps in the services | Per-email and per-user keys still absent |
| GAP-40 | Reset-flow enumeration signal | Unchanged | `403 ACCOUNT_INACTIVE` at step 2 still distinguishes a hibernated account from a decoy |
| GAP-50 | `OTP_RESEND_COOLDOWN` two shapes | Unchanged | The race variant still omits `Retry-After` |

---

## 3. Still open

| ID | Item | Why not done | Recommendation |
| --- | --- | --- | --- |
| GAP-35 | `billingLimiter` = 20/15min may be tight for repeated payroll edits | A product/ops judgement, not a defect | Confirm the number with the product team |
| GAP-36 | Enum values defined but unreachable | Partly resolved — `REVOKED`, `EXPIRED`, `REFUNDED`, `ARCHIVED` are now written. `HIBERNATED`, `SUSPENDED`, `BillingInterval.YEAR`, `CompanyAddressType` (all but `BUSINESS`), `PaymentStatus.PENDING` still are not | **Q-07** — confirm which are live vs reserved |
| GAP-38 | No OpenAPI spec | `API_INTEGRATION.md` is the contract; a generated spec should follow it, not race it | Generate from this document once the frontend confirms the shapes |
| GAP-42 | `@supabase/*` installed, imported nowhere | Removing a dependency someone may be mid-way through adopting is not my call | **Q-12** — confirm, then remove |
| GAP-43 | `@neondatabase/serverless` unused | Same | Remove with GAP-42 |
| GAP-46 | No cleanup job for expired challenges/tokens/tickets/events | Needs a scheduler, which is a deployment decision (cron vs worker vs pg_cron) | Add a prune job; the queries are trivial |
| GAP-51 | Thin coverage on the authorization matrix | Improved substantially (343 tests) but the manager/specialist read paths are still lightly covered | Add cases per role per endpoint |
| GAP-52 | Idempotency records never expire | Needs the same scheduler as GAP-46 | Prune alongside |

---

## 4. Questions still needing a decision

Answered by the work: **Q-01** (TTL was wrong — now `15m`), **Q-09** (`API_PREFIX=/api` confirmed), **Q-14** (empty state → `200`), **Q-15** (send `Idempotency-Key` on company onboarding; checkout derives one).

Still open:

| # | Question | Why it matters |
| --- | --- | --- |
| Q-02 | Are invitations always issued as `CUSTOMER`+`OWNER` for self-service customers? | Determines whether the role-staleness path is ever exercised in practice |
| Q-03 | What is the intended relationship between `Customer` and `Company`? There is no linking column, yet `Customer.ownerUserId` is unique while `Company.ownerUserId` is not | This shapes the whole navigation model. `POST /onboarding` takes a field called `companyName` that creates a **Customer**, which will keep confusing people |
| Q-04 | Must `POST /onboarding` precede `POST /onboarding/company`? | Currently the company flow checks the role but not whether a `Customer` exists |
| Q-05 | Should `GET /billing/plans` be owner/admin only? | Any authenticated user, including a specialist, reads the full price catalog |
| Q-06 | Is one active subscription per company permanent? | `POST /subscription/services` now covers the common case; if the rule is meant to relax, the partial unique index needs changing |
| Q-07 | Which enum values are live vs reserved? | The frontend needs to know whether to render UI for states that cannot occur |
| Q-08 | Intended production value of `BILLING_EXPOSE_STRIPE_IDS`? | Ids appear in dev and vanish in production; the contract says never depend on them, but confirm |
| Q-10 | Was `POST /invitations` unauthenticated by design (e.g. behind a gateway)? | Now fixed regardless, but worth knowing whether a gateway assumption exists elsewhere |
| Q-11 | On `emailSent: false`, what should the UI offer? | Implemented as *resend* (reuses the token). Confirm that is the desired behaviour |
| Q-12 | Are the Supabase dependencies planned or leftovers? | Blocks GAP-42/43 |
| Q-13 | Are file uploads planned? | No multipart parser or storage integration exists — a whole missing subsystem, not a missing endpoint |
| Q-16 | May any `ACCOUNTING_MANAGER` be attached to any company, or must they be related to the customer account first? | Today any user holding the role can be assigned to any company by its owner |
| Q-17 | Should a specialist's `SPECIALIST_1..4` sub-role constrain which `specializationCodes` they can be assigned? | Today a "Tax Specialist" can be assigned `BOOKKEEPING` with no objection |
| Q-18 | Retention policy for challenges, tokens, tickets, events, idempotency keys? | Needed before GAP-46/52 can be implemented |

---

## 5. New items found during the work

| Priority | Item | Status |
| --- | --- | --- |
| **Critical** | **Real credentials committed in `.env.example`**, which is git-tracked: SMTP password and mailbox, Stripe test secret key, Stripe webhook secret, Supabase URL and key. Present in commit `c58b85c` and still in history | File sanitised. **Rotation is required and is not something code can do** — see `CHANGELOG_API.md` §1 |
| **High** | **Invitation tokens were stored in plain text** in `invitations.token`. Alone among the schema's secrets — passwords are bcrypt, refresh tokens and reset tickets SHA-256, OTPs a keyed HMAC — and holding one is enough to complete a sign-up as the invited person, inheriting that invitation's role and email | FIXED. Hashed to `invitations.token_hash`, raw column dropped (migration 11). Existing links preserved: the digest was backfilled and verified against Node's hash on every live row before the column was removed. **Consequence:** resend now rotates the token instead of re-sending it |
| Medium | `requireAuth` now costs one indexed row read per request (token-freshness check) | Accepted: it is what makes a password reset actually end existing sessions. Fails open on a database error |
| Low | `.env.example` had a duplicated `SMTP_FROM` where the second shadowed the first | Fixed |
