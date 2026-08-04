# FinOpSys Portal — Frontend API Contract

> **There is a machine-readable version of this document: [`openapi.yaml`](./openapi.yaml).**
>
> It covers all 38 endpoints and 31 schemas, and is verified against the route
> table in `src/routes/` — so it cannot silently drift from the code the way prose can.
>
> ```bash
> # Generate TypeScript types for the frontend
> npx openapi-typescript openapi.yaml -o src/api-types.ts
>
> # Or a whole typed client
> npx @hey-api/openapi-ts -i openapi.yaml -o src/api
>
> # Browse it interactively
> npx @redocly/cli preview-docs openapi.yaml
> ```
>
> Postman / Insomnia: **Import → File → `openapi.yaml`** gives you every request
> pre-built with example bodies.
>
> Use the YAML for types and tooling; use this document for the *why* — the rules
> that a schema cannot express, like "never replay a refresh token" or "landing on
> the success page is not proof of payment".

**Audience:** the frontend repository.
**Status:** current as of the remediation described in `CHANGELOG_API.md`. Everything below was read out of the source and is covered by the test suite (343 tests, 13 suites, all passing).

---

## 0. The 60-second version

| Thing | Value |
| --- | --- |
| Base URL | `{host}{API_PREFIX}` — `API_PREFIX` is `/api` |
| Auth | `Authorization: Bearer <accessToken>` |
| Access token lifetime | **15 minutes** (`ACCESS_TOKEN_TTL`) |
| Session renewal | `POST /api/auth/refresh` — rotates the refresh token |
| Request casing | **snake_case and camelCase both accepted** |
| Response casing | **always camelCase** |
| Success envelope | `{ success: true, message: string, data: object }` — on every endpoint |
| Error envelope | `{ success: false, error: { code, message, requestId, fields?, details? } }` |
| Money | integers in **minor units**, in fields ending `...AmountMinor` |
| Dates | ISO-8601 UTC strings |
| Pagination | `{ total, limit, offset, hasMore, sort, order }` |

**Do not send the same field twice in two spellings.** `{ "company_id": 1, "companyId": 2 }` is a `400` — one of them was going to be discarded and you could not learn which.

---

## 1. Authentication

### 1.1 The two ways in

```
INVITED USER (first time)
  POST /api/auth/signup   { invitationToken, email, firstName, lastName, password }
    → 201  accessToken + refreshToken + HttpOnly cookie.  Signed in. No OTP.

RETURNING USER
  POST /api/auth/login    { email, password }
    → 202  { otpRequired: true, challengeId, maskedEmail, expiresInSeconds, resendAvailableInSeconds }
           NOT signed in yet — no token is issued here.

  POST /api/auth/otp      { action: "verify", challengeId, otp }
    → 200  accessToken + HttpOnly refresh cookie + csrfToken.  Signed in.
```

### 1.2 Keeping the session alive

```
POST /api/auth/refresh
  Cookie: refreshToken=…; csrfToken=…
  x-csrf-token: <the csrfToken value>
    → 200 { accessToken, expiresInSeconds, refreshToken, refreshTokenExpiresAt, user, csrfToken }
```

Rules the client must honour:

1. **The refresh token is single-use.** Every call returns a new one; discard the old value immediately.
2. **Never replay a used refresh token.** Doing so is treated as theft and revokes *every* session for that user. If two tabs can refresh concurrently, serialise it — share one in-flight refresh promise.
3. `POST /api/auth/refresh` answers `401 REFRESH_TOKEN_INVALID` for unknown, expired, revoked, and replayed tokens alike. In all four cases: send the user to `/login`.
4. Non-browser clients may send `{ "refreshToken": "…" }` in the body instead of using the cookie, and are exempt from CSRF.

### 1.3 CSRF

The refresh cookie is `HttpOnly` and the browser attaches it automatically, so `/auth/refresh` and `/auth/logout` require a double-submit token.

- The server sets a **readable** `csrfToken` cookie and also returns the value in the response body.
- Echo it in the `x-csrf-token` header on those two routes.
- **Bearer-authenticated requests are exempt.** You do not need a CSRF header on any `/companies`, `/billing`, `/onboarding`, `/invitations` or `/users` call.

### 1.4 Signing out

```
POST /api/auth/logout        → 200 { sessionsRevoked }   ends THIS session (needs CSRF)
POST /api/auth/logout-all    → 200 { sessionsRevoked }   ends every session (needs Bearer)
```

`logout` always answers `200`, even with no or an expired token.

### 1.5 Token expiry

`expiresInSeconds` is now a real number on every token-issuing response. You may also decode the JWT `exp` claim. Refresh at roughly 80% of the lifetime.

**A token issued before the user's last password change is rejected** with `401 TOKEN_EXPIRED`. Treat it like any other expiry.

### 1.6 Password reset (three steps, no session issued)

```
POST /api/auth/password-reset          { email }
  → 202 { otpRequired, challengeId, maskedEmail, expiresInSeconds, resendAvailableInSeconds }
    Identical response whether or not the address is registered. Never say "no such account".

POST /api/auth/password-reset/otp      { action: "verify", challengeId, otp }
  → 200 { otpVerified, resetToken, expiresInSeconds, maskedEmail }   resetToken lives 10 min

POST /api/auth/password-reset/confirm  { resetToken, password, confirmPassword? }
  → 200 { passwordUpdated, sessionsRevoked }
```

Step 3 issues **no token**. Clear all local auth state and route to `/login`.

### 1.7 Password policy

≥ 8 characters, ≤ 72 bytes, at least one lowercase, one uppercase, one digit. No special character required. Identical for signup and reset.

### 1.8 Roles

| `role` | `specificRole` |
| --- | --- |
| `ADMIN` | — |
| `ACCOUNTING_MANAGER` | — |
| `SPECIALIST` | `SPECIALIST_1`…`SPECIALIST_4` |
| `CUSTOMER` | `OWNER`, `TEAM` |

**Gate "owner" features on `specificRole === 'OWNER'`, not on `role`.** Both are on the login response and on `GET /api/onboarding`.

If a response carries **`X-Token-Stale: true`**, your access token's role claims are behind the database. The request succeeded anyway, but you should call `/auth/refresh` to pick up current claims.

---

## 2. Conventions

### 2.1 Success

```json
{ "success": true, "message": "Companies retrieved.", "data": { } }
```

`success`, `message` and `data` are present on **every** endpoint. (The Stripe webhook is the sole exception and is not called by the frontend.)

### 2.2 Errors

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The submitted information is invalid.",
    "requestId": "req_9f2c1a4b7e0d5836",
    "fields":  { "companyEmail": "Enter a valid email address." },
    "details": { "unknown": ["ownerUserId"], "where": "request body" }
  }
}
```

- `code`, `message`, `requestId` — always present.
- `fields` — a flat `{ fieldName: message }` map for form highlighting. **Field names are camelCase regardless of how you sent them.** The key `_` means a form-level message with no single field.
- `details` — structured extras: `allowed`, `unknown`, `missing`, `retryAfterSeconds`, `conflictingFields`.
- There is **no `errors` array**. Read `fields` and `details`.
- Stack traces appear only when `DEBUG_ERRORS=true`.

### 2.3 Money

Every monetary value is an **integer in minor units** in a field ending `...AmountMinor`, beside a `currency`. `unitAmountMinor: 24900` with `currency: "USD"` is **$249.00**.

The one exception is `lastYearRevenue` on a company, which is a **decimal string** in major units (`"1850000.00"`) because it is a business figure, not a charge.

### 2.4 Stripe ids

When exposed at all (`BILLING_EXPOSE_STRIPE_IDS`, off in production) they are grouped under a single `stripe` key that is present in full or absent in full:

```json
{ "optionId": "bookkeeping_option_2", "unitAmountMinor": 24900,
  "stripe": { "productId": "prod_…", "priceId": "price_…" } }
```

**Never depend on them.** Never send one back.

### 2.5 Pagination and sorting

```json
"pagination": { "total": 42, "limit": 25, "offset": 0, "hasMore": true, "sort": "createdAt", "order": "desc" }
```

`limit` (clamped), `offset`, `sort` (allowlisted per endpoint), `order` (`asc`|`desc`). An unsupported `sort` is a `400` listing the allowed values in `details.allowed`.

### 2.6 Idempotency

`POST /onboarding/company` and `POST /billing/checkout` accept `Idempotency-Key` (≤255 chars). A replay returns the stored response with `Idempotent-Replay: true`. Re-using a key with a different body is `422 IDEMPOTENCY_KEY_REUSED`.

**Always send one on `POST /onboarding/company`** — unlike checkout, it does not derive a fallback key, so a double-click creates two companies.

### 2.7 Rate limits

Per IP, 15-minute window. `429` carries `Retry-After` and `details.retryAfterSeconds`.

| Endpoint group | Limit |
| --- | --- |
| signup, login, password-reset, password-reset/confirm | 10 |
| OTP (login + reset) | 30 |
| refresh | 60 |
| invitations (create, resend) | 20 |
| onboarding writes | 30 |
| company writes | 60 |
| billing writes | 20 |
| all reads | none |

---

## 3. Endpoint Reference

Legend — **Auth**: `—` none, `B` Bearer, `C` cookie+CSRF. **Role**: coarse gate; the service always re-checks against the database.

### 3.1 Auth

| Method | Path | Auth | Body / Query | Success |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/signup` | — | `invitationToken`(64 hex), `email`, `firstName`, `lastName`, `password` | `201 { user, tokens }` |
| POST | `/api/auth/login` | — | `email`, `password` | `202 { otpRequired, challengeId, maskedEmail, expiresInSeconds, resendAvailableInSeconds }` |
| POST | `/api/auth/otp` | — | `action`(`verify`\|`resend`), `challengeId`(uuid), `otp`(6 digits, verify only) | `200 { authenticated, user, accessToken, expiresInSeconds, refreshTokenExpiresAt, csrfToken }` |
| POST | `/api/auth/refresh` | C | cookie, or `{ refreshToken }` | `200 { accessToken, expiresInSeconds, refreshToken, refreshTokenExpiresAt, user, csrfToken }` |
| POST | `/api/auth/logout` | C | — | `200 { sessionsRevoked }` |
| POST | `/api/auth/logout-all` | B | — | `200 { sessionsRevoked }` |
| POST | `/api/auth/password-reset` | — | `email` | `202 { otpRequired, challengeId, … }` |
| POST | `/api/auth/password-reset/otp` | — | `action`, `challengeId`, `otp?` | `200 { otpVerified, resetToken, expiresInSeconds, maskedEmail }` |
| POST | `/api/auth/password-reset/confirm` | — | `resetToken`(96 hex), `password`, `confirmPassword?` | `200 { passwordUpdated, sessionsRevoked }` |

`user` on signup / otp / refresh:

```json
{ "id": 7, "email": "ada@example.com", "firstName": "Ada", "lastName": "Lovelace",
  "role": "CUSTOMER", "specificRole": "OWNER", "status": "ACTIVE" }
```

**Auth error codes:** `AUTH_REQUIRED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`(401) · `INVALID_CREDENTIALS`(401) · `INVALID_OTP`(401) · `CHALLENGE_NOT_ACTIVE`(409) · `OTP_EXPIRED`(410) · `OTP_ATTEMPT_LIMIT_EXCEEDED`, `OTP_RESEND_COOLDOWN`, `OTP_RESEND_LIMIT`(429) · `OTP_DELIVERY_UNAVAILABLE`(503) · `ACCOUNT_INACTIVE`(403) · `REFRESH_TOKEN_INVALID`(401) · `CSRF_TOKEN_INVALID`(403) · `RESET_TOKEN_NOT_ACTIVE`(409) · `RESET_TOKEN_EXPIRED`(410) · `PASSWORD_UNCHANGED`(400).

### 3.2 Onboarding

| Method | Path | Auth | Role | Body | Success |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/onboarding` | B | any | — | `200 { user, customer, onboarding }` |
| POST | `/api/onboarding` | B | any | `companyName?` | `201`/`200 { user, customer, onboarding, tokens? }` |
| PUT | `/api/onboarding/profile` | B | any | `firstName`, `lastName`, `phone`, `jobTitle` | `200 { user, customer, onboarding }` |
| POST | `/api/onboarding/company` | B | `OWNER` | see below | `201 { company, primaryAddress }` |

```json
{ "user": { "id": 7, "email": "…", "firstName": "Ada", "lastName": "Lovelace",
            "phone": "+1 415 555 0123", "jobTitle": "Founder",
            "role": "CUSTOMER", "specificRole": "OWNER", "status": "ACTIVE" },
  "customer": { "id": 3, "name": "Acme Ltd" },
  "onboarding": { "accountProvisioned": true, "profileComplete": true, "complete": true } }
```

**`POST /api/onboarding` may return `data.tokens.accessToken`.** It appears when the call changed your role. **Swap your stored token for it.**

**`POST /api/onboarding/company` body** (snake_case equally accepted):

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `companyName` | string | ✓ | ≤255 |
| `companyType` | enum | ✓ | `SOLE_PROPRIETORSHIP`, `PARTNERSHIP`, `LIMITED_LIABILITY_COMPANY`, `C_CORPORATION`, `S_CORPORATION`, `NON_PROFIT`, `OTHER` |
| `companyEmail` | string | ✓ | ≤254, unique across companies **and** user logins |
| `companyPhone` | string | ✓ | ≤30, 7–15 digits |
| `employeeCount` | int | ✓ | 0 – 1,000,000 |
| `lastYearRevenue` | string/number | ✓ | ≤16 integer digits, ≤2 decimals |
| `revenueCurrency` | string | ✓ | 3-letter ISO |
| `address` | object | ✓ | below |

`address`: `addressLine1`(≤255) ✓, `addressLine2`(≤255), `city`(≤120) ✓, `state` ✓ *(required unless the country has no subdivisions; **US accepts "TX" or "Texas" and stores "TX"**)*, `postalCode`(≤20, format-checked for ~20 countries) ✓, `country`(≤100) ✓, `countryCode` ✓ *(real ISO 3166-1 alpha-2 only — `XX` is rejected)*.

Unknown fields anywhere are `400`. `ownerUserId` comes from the token and must not be sent.

**Errors:** `OWNER_ROLE_REQUIRED`(403) · `COMPANY_EMAIL_IN_USE`(409, `details.reason`) · `IDEMPOTENCY_KEY_REUSED`(422).

### 3.3 Companies

| Method | Path | Auth | Role | Success |
| --- | --- | --- | --- | --- |
| GET | `/api/companies` | B | any | `200 { companies[], pagination }` |
| GET | `/api/companies/:companyId` | B | any* | `200 { company }` |
| PATCH | `/api/companies/:companyId` | B | `OWNER`,`ADMIN` | `200 { company }` |
| DELETE | `/api/companies/:companyId` | B | `OWNER`,`ADMIN` | `200 { company }` |
| PUT | `/api/companies/:companyId/accounting-manager` | B | `OWNER`,`ADMIN` | `200 { company }` |
| POST | `/api/companies/:companyId/specialists` | B | `OWNER`,`ADMIN` | `201`/`200 { assignments[], skipped[] }` |
| GET | `/api/companies/:companyId/team` | B | any* | `200 { companyId, owner, accountingManager, specialists[] }` |
| GET | `/api/companies/:companyId/specialists` | B | any* | `200 { companyId, specialists[], pagination }` |
| DELETE | `/api/companies/:companyId/specialists/:assignmentId` | B | `OWNER`,`ADMIN` | `200 { assignment }` |

\* read access = owner, admin, the company's accounting manager, or an assigned specialist.

**`GET /api/companies`** — this is how you rediscover a `companyId` after a refresh. Query: `limit`, `offset`, `sort`(`createdAt`\|`companyName`\|`status`\|`updatedAt`), `order`, `status`, `search`.

```json
{ "id": 11, "companyName": "Acme Analytics LLC", "companyType": "LIMITED_LIABILITY_COMPANY",
  "companyEmail": "billing@acme.example", "companyPhone": "+1 415 555 0199",
  "employeeCount": 24, "lastYearRevenue": "1850000.00", "revenueCurrency": "USD",
  "ownerUserId": 7, "accountingManagerUserId": null, "status": "ACTIVE",
  "onboardingCompleted": true, "createdAt": "…", "updatedAt": "…",
  "primaryAddress": { "id": 44, "addressLine1": "500 Market St", "addressLine2": "Suite 12",
                      "city": "San Francisco", "state": "CA", "postalCode": "94105",
                      "country": "United States", "countryCode": "US" },
  "owner": { "userId": 7, "firstName": "Ada", "lastName": "Lovelace", "email": "…" },
  "accountingManager": null,
  "accessRole": "OWNER" }
```

**`accessRole`** (`ADMIN`|`OWNER`|`ACCOUNTING_MANAGER`|`SPECIALIST`) tells you which actions to render. Use it instead of re-deriving the rules client-side.

**`PATCH`** — any subset of the onboarding fields; at least one required. Sending `address` replaces it wholesale.
**`DELETE`** — soft archive. `409 SUBSCRIPTION_STILL_ACTIVE` if a subscription is live; cancel first.

**Team payload** — each specialization carries its own `assignmentId`, so a remove button can be rendered straight from `/team`:

```json
{ "companyId": 11,
  "owner": { "userId": 7, "firstName": "Ada", "lastName": "Lovelace", "email": "…" },
  "accountingManager": { "userId": 19, "firstName": "Alan", "lastName": "Turing", "email": "…" },
  "specialists": [ { "userId": 22, "firstName": "Grace", "lastName": "Hopper", "email": "…",
      "specializations": [ { "assignmentId": 88, "specializationCode": "TAX", "specializationName": "Tax" } ] } ] }
```

**Assignment object** — `specialist` is always present as a key (`null` if not loaded):

```json
{ "assignmentId": 88, "companyId": 11, "specialistUserId": 22,
  "specializationCode": "TAX", "specializationName": "Tax", "assignmentStatus": "ACTIVE",
  "assignedAt": "…", "unassignedAt": null,
  "specialist": { "userId": 22, "firstName": "Grace", "lastName": "Hopper", "email": "…" } }
```

Specialization codes: `BOOKKEEPING`, `PAYROLL`, `TAX`, `FA_Q`.

**Errors:** `COMPANY_NOT_FOUND`(404) · `COMPANY_ACCESS_DENIED`(403) · `INVALID_ACCOUNTING_MANAGER_ROLE`, `INVALID_SPECIALIST_ROLE`(422) · `INVALID_SPECIALIZATION`(400, `details.unknown`) · `ASSIGNMENT_NOT_FOUND`(404).

### 3.4 Users

| Method | Path | Auth | Who | Query |
| --- | --- | --- | --- | --- |
| GET | `/api/users` | B | `ADMIN` or an `OWNER` | `role`, `search`, `limit`, `offset`, `sort`, `order` |

This is the directory behind the assignment pickers.

```json
{ "userId": 22, "email": "grace@finopsys.ai", "firstName": "Grace", "lastName": "Hopper",
  "role": "SPECIALIST", "specificRole": "SPECIALIST_2", "jobTitle": "Tax Specialist", "status": "ACTIVE" }
```

`ACTIVE` users only. `403 FORBIDDEN` for anyone else.

### 3.5 Invitations

**All four routes now require authentication.** Creating requires `ADMIN`. Non-admins see and manage only their own.

| Method | Path | Auth | Role | Body |
| --- | --- | --- | --- | --- |
| POST | `/api/invitations` | B | `ADMIN` | `email`, `firstName`, `lastName`, `roleId`, `specificRoleId?` |
| GET | `/api/invitations` | B | any | query: `status`, `search`, `limit`, `offset`, `sort`, `order` |
| DELETE | `/api/invitations/:invitationId` | B | any | — |
| POST | `/api/invitations/:invitationId/resend` | B | any | — |

**`invitedBy` is no longer accepted** — the inviter is the authenticated caller. Sending it is a `400`.

`specificRoleId` is required for roles that have subdivisions (`CUSTOMER`, `SPECIALIST`) and forbidden for those that do not (`ADMIN`, `ACCOUNTING_MANAGER`).

```json
{ "invitation": { "id": 12, "email": "ada@example.com", "firstName": "Ada", "lastName": "Lovelace",
    "roleId": 4, "roleCode": "CUSTOMER", "roleName": "Customer",
    "specificRoleId": 1, "specificRoleCode": "OWNER", "specificRoleName": "Owner",
    "invitedById": 1, "invitedBy": { "userId": 1, "firstName": "Admin", "lastName": "User", "email": "…" },
    "acceptedUserId": null, "status": "SENT", "isExpired": false,
    "expiresAt": "…", "createdAt": "…" },
  "emailSent": true }
```

- **`data.emailSent` can be `false` on a `201`.** Read it — the status code does not tell you the invitee heard anything. Offer *resend*.
- `DELETE` revokes (status `REVOKED`); the row is kept. Idempotent.
- **`resend` mints a NEW token and invalidates the previous link.** The server stores only a SHA-256 digest of the token, so it genuinely cannot re-send the original — and superseding an old link on every resend is the safer behaviour anyway, matching password reset. Tell the invitee to use the most recent email. The row keeps its id and audit trail, so nothing has to be re-entered.
- The invitation token is **never** returned by any endpoint and is not stored in readable form. The email link is `${FRONTEND_URL}/accept-invitation?token=…`; forward that value to signup as `invitationToken`. It is 64 hex characters and is validated for shape before any lookup.

**Errors:** `USER_ALREADY_EXISTS`(409) · `INVITATION_ALREADY_SENT`(409) · `INVITATION_NOT_FOUND`(404, also used for another user's invitation) · `INVITATION_ALREADY_ACCEPTED`, `INVITATION_REVOKED`(409) · `INVITER_NOT_ACTIVE`(403).

### 3.6 Billing

All billing routes require the caller to be the company **owner** or an `ADMIN` — narrower than company read access.

| Method | Path | Role | Body / Query |
| --- | --- | --- | --- |
| GET | `/api/billing/plans` | any | — |
| POST | `/api/billing/checkout` | `OWNER`,`ADMIN` | `companyId`, `selectedServices` |
| GET | `/api/billing/checkout-status` | any | `sessionId` (or `session_id`) |
| GET | `/api/billing/subscription` | any | `companyId` |
| POST | `/api/billing/subscription/services` | `OWNER`,`ADMIN` | `companyId`, `selectedServices` |
| PATCH | `/api/billing/subscription/payroll` | `OWNER`,`ADMIN` | `companyId`, `employeeCount?`, `contractorCount?` |
| DELETE | `/api/billing/subscription` | `OWNER`,`ADMIN` | `companyId`, `atPeriodEnd?` |
| GET | `/api/billing/payments` | any | `companyId`, `limit`, `offset`, `sort`, `order`, `status` |
| POST | `/api/billing/portal` | `OWNER`,`ADMIN` | `companyId` |

`DELETE /api/billing/subscription` **requires a JSON body** — many HTTP clients omit one by default.

**`GET /plans`:**

```json
{ "currency": "USD",
  "bookkeeping": [ { "optionId": "bookkeeping_option_1", "name": "Bookkeeping Starter",
                     "unitAmountMinor": 9900, "currency": "USD", "billingInterval": "MONTH",
                     "displayOrder": 10, "quantityEnabled": false } ],
  "payroll": [ { "planId": "payroll_standard", "components": {
      "base":        { "optionId": "payroll_standard", "unitAmountMinor": 2900, "quantityEnabled": false, "component": "base" },
      "employees":   { "optionId": "payroll_standard", "unitAmountMinor": 1500, "quantityEnabled": true,
                       "quantityLabel": "Number of W-2 Employees", "component": "employees" },
      "contractors": { "optionId": "payroll_standard", "unitAmountMinor": 1000, "quantityEnabled": true,
                       "quantityLabel": "Number of 1099 Contractors", "component": "contractors" } } } ],
  "taxes": [ … ] }
```

Valid ids: `bookkeeping_option_1..4`, `tax_option_1..3`, `payroll_standard`. **Send only these.** Never a price id or an amount.

**`POST /checkout` and `POST /subscription/services`** share one body grammar:

```json
{ "companyId": 11,
  "selectedServices": {
    "bookkeeping": { "selected": true, "priceOptionId": "bookkeeping_option_2" },
    "payroll":     { "selected": true, "planId": "payroll_standard", "employeeCount": 12, "contractorCount": 3 },
    "taxes":       { "selected": false } } }
```

`selected` is **opt-in**: only `true` or `"true"` selects. Counts are 0–5000; omitted means 0, and a zero component is dropped before Stripe.

Checkout → `201 { checkoutSessionId, checkoutUrl, companyId, selectedServices, pricingSummary }`. Redirect to `checkoutUrl`.

`pricingSummary`: `{ currency, bookkeeping?, payroll? { base, employees, contractors, totalAmountMinor }, taxes?, grandTotalAmountMinor }`. Each line: `{ optionId, quantity, unitAmountMinor, totalAmountMinor }`. **Show these amounts, not the ones from `/plans`** — they are re-verified against Stripe.

**`POST /subscription/services`** adds to a live subscription on the existing Stripe subscription, keeping one renewal date and one invoice. Prorated. `409 SERVICE_ALREADY_SUBSCRIBED` if already paying for it. → `200 { added[], pricingSummary, subscription }`.

**`GET /checkout-status`** — poll after the redirect. Landing on the success page is **not** proof of payment.

```json
{ "status": "paid", "checkoutStatus": "complete", "paymentStatus": "paid",
  "companyId": 11, "subscriptionStatus": "ACTIVE", "currentPeriodEnd": "…",
  "services": [ { "service": "bookkeeping", "status": "active", "priceOptionId": "bookkeeping_option_2" },
                { "service": "payroll", "status": "active", "planId": "payroll_standard",
                  "employeeCount": 12, "contractorCount": 3 } ] }
```

`status`: `paid` | `processing` | `pending` | `cancelled` | `failed`. **Keep polling while `pending` or `processing`** — asynchronous methods sit in `processing` for days and can still fail.

**`GET /subscription`** — `200` always, never `404`:

```json
{ "companyId": 11, "hasSubscription": true,
  "subscription": { "subscriptionId": 5, "companyId": 11, "status": "ACTIVE",
    "currentPeriodStart": "…", "currentPeriodEnd": "…",
    "cancelAtPeriodEnd": false, "canceledAt": null, "currency": "USD",
    "recurringTotalAmountMinor": 48800,
    "services": [ … ],
    "lines": [ { "service": "bookkeeping", "component": "plan", "optionId": "bookkeeping_option_2",
                 "planName": "Bookkeeping Growth", "quantity": 1,
                 "unitAmountMinor": 24900, "totalAmountMinor": 24900, "currency": "USD" } ] } }
```

A company with nothing bought yet returns `hasSubscription: false, subscription: null`. `lines[].unitAmountMinor` is the price **captured at purchase**, not today's list price.

**`PATCH /subscription/payroll`** — at least one count required. Payroll must already be on the subscription (`409 PAYROLL_NOT_SUBSCRIBED`; use `/subscription/services` to add it). → `200 { changes[], subscription }`. **On `502`, refetch** — `details.applied` names components that did go through.

**`DELETE /subscription`** — `atPeriodEnd` defaults to `true`. Read `data.subscription.cancelAtPeriodEnd` and `.status`, not the message. Idempotent.

**`GET /payments`** — sortable by `paidAt`, `createdAt`, `amountPaid`, `status`; filter by `status`.

```json
{ "paymentId": 31, "amountPaidMinor": 48800, "amountRefundedMinor": 0, "currency": "USD",
  "status": "PAID", "paidAt": "…", "refundedAt": null, "createdAt": "…", "failureReason": null }
```

`status`: `PENDING` | `PAID` | `FAILED` | `REFUNDED`. **`REFUNDED` and `amountRefundedMinor` are now real** — a partial refund keeps `PAID` with a non-zero refund, a full refund becomes `REFUNDED`. Render both.

**`POST /portal`** → `201 { portalUrl, companyId }`. Mint per click; never cache.

**Billing errors:** `NO_SERVICE_SELECTED`, `INVALID_BOOKKEEPING_PRICE_OPTION`, `INVALID_TAX_PRICE_OPTION`, `INVALID_PAYROLL_PLAN`, `INVALID_EMPLOYEE_COUNT`, `INVALID_CONTRACTOR_COUNT`(400, `details.allowed`) · `SUBSCRIPTION_ALREADY_ACTIVE`, `SERVICE_ALREADY_SUBSCRIBED`, `SUBSCRIPTION_NOT_ACTIVE`, `PAYROLL_NOT_SUBSCRIBED`(409) · `CHECKOUT_SESSION_NOT_FOUND`(404), `CHECKOUT_SESSION_ACCESS_DENIED`(403) · `STRIPE_PRICE_*`, `INCOMPATIBLE_CHECKOUT_PRICES`(422) · `CHECKOUT_SESSION_CREATION_FAILED`, `SUBSCRIPTION_UPDATE_FAILED`, `SUBSCRIPTION_CANCEL_FAILED`, `PORTAL_SESSION_FAILED`(502) · `STRIPE_NOT_CONFIGURED`(503).

### 3.7 Health

`GET /api/health` → `200 { status: "ok", database: "up", latencyMs }` or `503`. Unauthenticated. Actually round-trips a query, unlike `GET /`.

### 3.8 `POST /api/billing/webhook` — Stripe only, never call this

Listed for completeness so it is not called or mocked by mistake.

- **Not authenticated by token.** Stripe holds none; the `Stripe-Signature` header *is* the authentication, checked against the raw request body.
- Response is `{ received, duplicate }` — the **one** endpoint that does not use the `{success, message, data}` envelope.
- Handles: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`.
- **This is the only place a service is ever activated.** Landing on the Stripe success page is not proof of payment — always confirm with `GET /api/billing/checkout-status`.

---

## 4. Integration Notes

### 4.1 The happy path

```
POST /api/invitations                 (admin)      → invitee gets an email
POST /api/auth/signup                              → 201, signed in
POST /api/onboarding                               → 201; SWAP TOKEN if data.tokens present
PUT  /api/onboarding/profile                       → 200
POST /api/onboarding/company    + Idempotency-Key  → 201; capture data.company.id
GET  /api/billing/plans                            → render catalog
POST /api/billing/checkout                         → redirect to checkoutUrl
GET  /api/billing/checkout-status?sessionId=…      → poll until status !== pending|processing
GET  /api/companies                                → rediscover companies on any later load
```

### 4.2 HTTP client checklist

1. `credentials: 'include'` on every request.
2. Attach `Authorization: Bearer` from memory.
3. On `401 TOKEN_EXPIRED` → call `/auth/refresh` once, retry the original request, and on a second failure route to `/login`. **Share one in-flight refresh promise across concurrent 401s** — parallel refreshes replay a rotated token and revoke every session.
4. On `401 REFRESH_TOKEN_INVALID` → clear state, go to `/login`. Never retry.
5. Send `x-csrf-token` on `/auth/refresh` and `/auth/logout` only.
6. On `X-Token-Stale: true` → refresh in the background.
7. On `429` → back off by `details.retryAfterSeconds`.
8. Surface `error.requestId` in error UI; it is the key to the backend logs.
9. Do **not** apply a global snake_case↔camelCase transform. Send one convention, read camelCase.

### 4.3 Per-endpoint notes

| Endpoint | Notes |
| --- | --- |
| `POST /auth/login` | Hold `challengeId` in memory only. Never disclose why credentials failed. Start a 60s resend countdown. |
| `POST /auth/otp` | `otp` must be a **string** — a leading zero is significant. Never send `otp` with `action: "resend"`. |
| `POST /auth/password-reset` | Response is identical for unknown addresses. Never say "no such account". |
| `POST /onboarding` | Check for `data.tokens.accessToken` and swap it in. |
| `POST /onboarding/company` | Send `Idempotency-Key`. Persist `data.company.id`. |
| `GET /companies` | Call on app bootstrap. Cache per session; invalidate on any company write. |
| `GET /users` | Populate pickers. `403` for non-admin/non-owner — hide the assignment UI. |
| `POST /invitations` | Read `data.emailSent`. Offer *resend*, not re-create. |
| `GET /billing/plans` | Cache for the session. |
| `POST /billing/checkout` | Disable the button; redirect immediately. Show `pricingSummary`, not `/plans` figures. |
| `GET /billing/checkout-status` | Poll ~2s while `pending`/`processing`. Never cache. |
| `PATCH /billing/subscription/payroll` | On `502`, refetch — may be partially applied. |
| `DELETE /billing/subscription` | Send a JSON body. Warn before `atPeriodEnd: false`. |

### 4.4 Never send

`ownerUserId`, `userId`, `id`, `invitedBy`, `roleId`/`specificRoleId` at signup, `email` on profile update, any `stripe*` id, `priceId`, `productId`, `unitAmount`, `amount`, `total`, `status`, `onboardingCompleted`, `createdAt`, `updatedAt`, `assignmentId`, `subscriptionId`.

All are rejected with `400` and `details.unknown`.

### 4.5 Optimistic updates

Safe: `PUT /onboarding/profile`, `DELETE …/specialists/:id`, `DELETE /invitations/:id`.
Not safe: specialist assignment (server decides created vs skipped), accounting-manager assignment (may `422`), anything billing (Stripe decides), anything auth.

---

## 5. Migration From The Previous Contract

| Was | Now |
| --- | --- |
| snake_case responses on company/billing | **camelCase everywhere**; snake_case still accepted on requests |
| `unit_amount`, `total_amount`, `amount_paid` | `unitAmountMinor`, `totalAmountMinor`, `amountPaidMinor` |
| `product_id`, `price_id`, `stripe_invoice_id` as siblings | grouped under `stripe: { … }` |
| `has_more` | `hasMore` |
| `GET /billing/subscription` → `404` when none | `200 { hasSubscription: false, subscription: null }` |
| `emailSent` beside `success` | inside `data` |
| `user` on OTP verify = `{id,email,role}` | full user incl. `firstName`, `lastName`, `specificRole`, `status` |
| `expiresInSeconds: null` | a real number |
| `POST /invitations` unauthenticated, took `invitedBy` | `ADMIN` only; inviter from the token; `invitedBy` rejected |
| no refresh / logout | `POST /auth/refresh`, `/auth/logout`, `/auth/logout-all` |
| access token ~10h | 15 minutes + rotation |
| no company list | `GET /api/companies` |
| no user directory | `GET /api/users` |
| team payload had no `assignmentId` | each specialization carries one |
| `message` sometimes absent | always present |
| unknown fields silently ignored on auth/onboarding | rejected with `400` |
