# Portal-backend-dev

Node.js + Express backend for the FinOpSys Portal, with PostgreSQL accessed
through Prisma.

## Requirements

- Node.js 18+
- npm
- A PostgreSQL database (Supabase in development)

## Getting started

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your local env file
cp .env.example .env      # then fill in DATABASE_URL and the SMTP_* values

# 3. Create the tables by hand, then seed the reference rows.
#    Run db/schema/*.sql in numeric order (Supabase SQL editor or psql) —
#    see db/README.md. There is no migrate step: the schema is managed
#    manually, not by the application.
npm run db:seed

# 4. Run in development (auto-reload)
npm run dev
```

The server starts on the port defined in `.env` (default `3000`).

## Database (managed by hand)

**The database is the source of truth, and its schema is changed by hand.** This
project does not use Prisma migrations: no application code, script, or npm
command creates, alters, or drops a table.

- `db/schema/*.sql` — the DDL, numbered in application order. Run these to build
  a database.
- `prisma/schema.prisma` — **describes** the tables so the Prisma Client can be
  generated. It no longer drives them.

To change the schema: run your DDL against the database yourself, save it as the
next file in `db/schema/`, then bring `schema.prisma` back in line —

```bash
npm run db:pull           # rewrite schema.prisma FROM the live database
npm run db:generate       # rebuild the Prisma Client
```

Keeping `schema.prisma` accurate is not optional: the Prisma Client is generated
from it, so if it disagrees with the real tables, queries fail at runtime against
columns that do not exist.

`prisma migrate dev`, `prisma migrate deploy`, `prisma db push`, and
`prisma migrate reset` are deliberately absent from `package.json` — the first
three would take schema control back, and `reset` drops every table. The durable
protection is the restricted `portal_app` role in `db/roles/app_user.sql`, which
has row rights but no DDL rights, so the database refuses schema changes from the
app regardless of what any code tries. See `db/README.md`.

### Data model

```
Role                 ADMIN, ACCOUNTING_MANAGER, SPECIALIST, CUSTOMER
 └── SpecificRole    SPECIALIST -> Payroll / Tax / Bookkeeping / FP&A
                     CUSTOMER   -> Owner / Team
User                 belongs to a Role, optionally a SpecificRole and an Address
Invitation           a tokenised invite to become a User
Address              postal address, shared by Users, Customers and Companies

Company              a tenant owned by one User; a User may own MANY
 ├── CompanyAddress  join to Address (BUSINESS/BILLING/MAILING/REGISTERED/OTHER)
 └── CompanySpecialistAssignment
                     specialist × specialization, per company
Specialization       BOOKKEEPING, PAYROLL, TAX, FA_Q
IdempotencyKey       replay ledger for POST /api/onboarding/company
```

**Company vs Customer.** `Customer` is the original one-account-per-owner tenant
(`owner_user_id` is `UNIQUE`). `Company` is the multi-tenant model added for
company onboarding: `owner_user_id` is indexed but **not** unique, so one owner
holds many companies. The two coexist; company onboarding does not touch the
customer flow.

**Addresses are never inlined.** A company's address lives in the shared
`addresses` table and is reached through `company_addresses`. A partial unique
index — `UNIQUE (company_id) WHERE is_primary` — makes "at most one primary
address per company" a database guarantee rather than a convention.

**Assignment uniqueness is partial too.** `UNIQUE (company_id,
specialist_user_id, specialization_id) WHERE assignment_status = 'ACTIVE'`
prevents duplicate live assignments while still allowing a specialist to be
re-assigned after removal — removal is a soft delete (`INACTIVE` +
`unassigned_at`), so history survives.

**Role mapping.** The three roles the company flows check are the existing ones:
`OWNER` is the `CUSTOMER` role + `OWNER` specific role, `ACCOUNTING_MANAGER` and
`SPECIALIST` are top-level roles. No new roles were introduced.

`ADMIN` and `ACCOUNTING_MANAGER` have no subdivisions, which is why
`User.specificRoleId` and `Invitation.specificRoleId` are nullable.

**Composite foreign key.** `User` and `Invitation` each carry a two-column
foreign key `(specificRoleId, roleId) -> SpecificRole(id, roleId)`, backed by
`@@unique([id, roleId])` on `SpecificRole`. This makes it structurally
impossible to pair a role with a specific role belonging to a different role —
a `CUSTOMER` can never hold `Tax Specialist`. Keep that `@@unique` in place:
removing it silently drops the guarantee.

### Connection

Prisma 7 ships no query engine; it runs on a driver adapter over `pg`
(`src/config/prisma.js`). The connection URL comes from `DATABASE_URL` at
runtime — for the CLI via `prisma.config.js`, for the app via `src/config/`.
This is why `schema.prisma` has no `url` in its `datasource` block.

## Project structure

```
db/
├── schema/                 # numbered DDL, applied by hand in order — the
│                           #   definition of the database (see db/README.md)
└── roles/                  # the restricted application role
prisma/
├── schema.prisma           # Prisma's view of the database, kept in step by hand
│                           #   or with `npm run db:pull`. NOT a migration source.
└── seed.js                 # roles, specializations, service plans, bootstrap
                            #   admin — all upserts, safe to re-run
src/
├── app.js                  # Express app: middleware, routes, error handling
├── server.js               # Entry point: HTTP server, graceful shutdown
├── config/                 # Env config (index.js) + Prisma client (prisma.js)
├── routes/                 # Route definitions (aggregated in index.js)
├── controllers/            # Request handlers (thin: validate -> service -> respond)
├── validators/             # Input validation + normalisation, per feature
├── dto/                    # Response shapes — the only thing services return
├── services/               # Business rules, transactions, integrations
├── repositories/           # Data access; every fn takes a prisma/tx client
├── middlewares/            # Auth, roles, rate limits, errors, async, 404
└── utils/                  # Logger, audit log, ApiError, tokens, shared helpers
tests/                      # Jest + supertest, Prisma mocked (no live database)
scripts/
└── test-email.js           # SMTP smoke test
```

Requests flow one way: **route → middleware (auth, role, limiter) → controller →
validator → service → repository**. Authorization is decided in the service
against the database; the route-level `requireRole` is only an early filter.

## Available scripts

| Script               | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `npm start`          | Run the server (production).                          |
| `npm run dev`        | Run with nodemon (auto-reload).                       |
| `npm run db:seed`    | Seed roles, specializations, plans, admin. Rows only. |
| `npm run db:pull`    | Rewrite `schema.prisma` **from** the live database.   |
| `npm run db:generate`| Regenerate the Prisma client.                         |
| `npm run db:studio`  | Browse the database in Prisma Studio.                 |
| `npm test`           | Run the Jest suite (Prisma mocked; no database needed).|

## API

Every router is mounted under `API_PREFIX` (default `/api`, see
`src/config/index.js`), so the paths below are the full public ones. Change that
one variable to version the whole surface.

### Company onboarding

Four flows, all authenticated with the `Bearer` access token minted by sign-up /
login. **The caller's user id always comes from the verified token — never from
the request body.** Sending `owner_user_id` is rejected as an unknown field.

#### `POST /api/onboarding/company`

Provision a company owned by the caller. Requires the `OWNER` role (checked
twice: a coarse token-claim gate on the route, then authoritatively against the
database in the service).

```jsonc
// request
{
  "company_name": "ABC Aerospace LLC",
  "company_type": "LIMITED_LIABILITY_COMPANY",
  "company_email": "accounts@abcaerospace.com",
  "company_phone": "+1 555 123 4567",
  "employee_count": 25,
  "last_year_revenue": 1500000.00,
  "revenue_currency": "USD",
  "address": {
    "address_line_1": "123 Main Street",
    "address_line_2": "Suite 400",       // optional
    "city": "Austin",
    "state": "Texas",
    "postal_code": "78701",
    "country": "United States",
    "country_code": "US"
  }
}
```

Responds `201` with `{ company, primary_address }`. One transaction creates the
address, the company, and the primary `BUSINESS` mapping, then sets
`onboarding_completed: true` and `status: ACTIVE`. Any failure rolls back all
four writes — there is no half-created company.

`last_year_revenue` is returned as a **string** (`"1500000.00"`): it is stored as
`DECIMAL(18,2)` and never passes through a binary float.

**Idempotency.** Send an `Idempotency-Key` header. The key and the response body
are written inside the same transaction as the company, so a retry replays the
stored `201` (with `Idempotent-Replay: true`) instead of creating a second
company — including when two identical requests race, where the loser of the
`UNIQUE (user_id, idempotency_key)` conflict returns the winner's response.
Reusing a key with a *different* payload is `422 IDEMPOTENCY_KEY_REUSED`.

Errors: `401 AUTH_REQUIRED` / `TOKEN_EXPIRED` / `INVALID_TOKEN` /
`USER_NOT_FOUND`, `403 FORBIDDEN` / `OWNER_ROLE_REQUIRED`, `400
VALIDATION_ERROR`, `500 COMPANY_ONBOARDING_FAILED`.

#### `PUT /api/companies/:companyId/accounting-manager`

```jsonc
// request
{ "accounting_manager_user_id": 7 }
```

Responds `200` with the updated company. The caller must own the company (or be
`ADMIN`) and the target must hold the `ACCOUNTING_MANAGER` role. Assignment and
replacement are the same operation: `accounting_manager_user_id` is a single
nullable column, so more than one manager per company is structurally impossible.

Errors: `403 COMPANY_ACCESS_DENIED`, `404 COMPANY_NOT_FOUND` / `USER_NOT_FOUND`,
`422 INVALID_ACCOUNTING_MANAGER_ROLE`.

#### `POST /api/companies/:companyId/specialists`

```jsonc
// request
{ "specialist_user_id": 12, "specialization_codes": ["BOOKKEEPING", "PAYROLL"] }
```

Creates one assignment per specialization in a single transaction. Codes are
trimmed, upper-cased, and de-duplicated, then verified against the
`specializations` table. Already-active assignments are **skipped, not errored** —
the response separates `assignments` (created) from `skipped`, and the status is
`201` when anything was created, `200` when everything was already active. Many
specialists may share one specialization on the same company.

Errors: `400 INVALID_SPECIALIZATION` (with the unknown codes in `details`), `403
COMPANY_ACCESS_DENIED`, `404 COMPANY_NOT_FOUND` / `USER_NOT_FOUND`, `422
INVALID_SPECIALIST_ROLE`.

#### `GET /api/companies/:companyId/team`

```jsonc
// response data
{
  "company_id": 1,
  "owner": { "user_id": 3, "first_name": "John", "last_name": "Smith" },
  "accounting_manager": { "user_id": 7, "first_name": "Sarah", "last_name": "Jones" },
  "specialists": [
    {
      "user_id": 12, "first_name": "Jane", "last_name": "Doe",
      "specializations": ["BOOKKEEPING", "PAYROLL"]
    }
  ]
}
```

`accounting_manager` is `null` when none is assigned. Read access is wider than
write access: the owner, an admin, the company's accounting manager, or any
actively assigned specialist.

#### `GET /api/companies/:companyId/specialists`

The flat form of the same data — one entry per active assignment, each with its
`assignment_id`, so a client knows what to pass to the delete route.

#### `DELETE /api/companies/:companyId/specialists/:assignmentId`

Soft-removes one assignment (`assignment_status: INACTIVE`, `unassigned_at` set),
which frees the slot under the partial unique index and keeps the history.
Idempotent: removing an already-removed assignment returns `200`. The assignment
is looked up scoped to `:companyId`, so one company can never delete another's
row — a mismatched pair is `404 ASSIGNMENT_NOT_FOUND`.

#### Validation and logging

Validation is hand-rolled in `validators/companyValidator.js`, matching the rest
of the project (no schema library). Every request body is **whitelisted**:
unknown fields are a `400`, strings are trimmed, emails lower-cased, currency and
country codes upper-cased. Column widths mirror `schema.prisma`, so oversized
input is a clean `400` rather than an opaque write error.

`utils/auditLog.js` emits one JSON line per event (`company.onboarding.started`,
`company.created`, `company.specialist.assigned`, `transaction.rolled_back`, …).
It writes an **allowlist** of fields — ids, event, status, timestamp — so tokens,
phone numbers, addresses, and revenue cannot be logged even if passed in.

### `POST /api/invitations`

```jsonc
// request
{
  "email": "person@example.com",
  "firstName": "Person",
  "lastName": "Example",
  "roleId": 3,                 // required
  "specificRoleId": 4,         // optional; must belong to roleId
  "invitedBy": 1               // id of an existing user
}
```

Responds `201` with the created invitation. The `token` is never returned — it
is the invitation secret and is only delivered in the email. Email failure does
not fail the request: the response reports `emailSent: false` and the
invitation can be resent.

Errors: `400` invalid input or mismatched role, `409` the email already has an
account or a pending invitation.

### Password reset

Three requests, all unauthenticated and all rate limited. No step of this flow
returns a session — after a successful reset the user signs in through the normal
password + OTP login.

**1. `POST /api/auth/password-reset`** — ask for a code.

```jsonc
// request
{ "email": "person@example.com" }
```

Responds `202` with `{ challengeId, maskedEmail, expiresInSeconds,
resendAvailableInSeconds }`.

The response is **identical for a registered and an unregistered address** —
same status, same message, same fields — and a throwaway `challengeId` is
returned for an address that has no account. This endpoint is unauthenticated
and takes an arbitrary email, so any observable difference would turn it into a
free "does this person have an account here?" oracle. For the same reason a mail
delivery failure here is logged (and recorded as `deliveryStatus: FAILED` on the
challenge) rather than returned. Do not "improve" this into a `404`.

Only `ACTIVE` accounts get a code. `INVITED` users have no password to reset —
they finish the invitation instead — and `HIBERNATED` accounts must not be able
to reset their way back into service.

**2. `POST /api/auth/password-reset/otp`** — verify or resend, selected by `action`.

```jsonc
// request
{ "action": "verify", "challengeId": "<uuid>", "otp": "012345" }
// or
{ "action": "resend", "challengeId": "<uuid>" }
```

`verify` responds `200` with `{ otpVerified, resetToken, expiresInSeconds,
maskedEmail }`. The `resetToken` is single-use, expires in
`PASSWORD_RESET_TICKET_TTL_SECONDS` (default 10 min), and is stored only as a
SHA-256 hash — it is returned exactly once. It is what proves to step 3 that the
OTP actually passed; without it that endpoint would have to trust a
client-supplied user id.

A `LOGIN_EMAIL_OTP` challenge is rejected here, and a reset challenge is rejected
at `/api/auth/otp` — a code minted for one flow never works in the other.

Errors: `401 INVALID_OTP`, `410 OTP_EXPIRED`, `409 CHALLENGE_NOT_ACTIVE`
(unknown, used, wrong-purpose, or a decoy id), `429
OTP_ATTEMPT_LIMIT_EXCEEDED` / `OTP_RESEND_COOLDOWN` / `OTP_RESEND_LIMIT`.

**3. `POST /api/auth/password-reset/confirm`** — set the new password.

```jsonc
// request
{
  "resetToken": "<96 hex chars>",
  "password": "BrandNewPass1",
  "confirmPassword": "BrandNewPass1"   // optional; checked when present
}
```

Responds `200` with `{ passwordUpdated, sessionsRevoked }`. In one transaction
this consumes the ticket, writes the new hash, clears any login lockout, revokes
every refresh token, and invalidates any in-flight login challenge — so anyone
still holding a session for the account is cut off, which is the point of a
recovery. A "your password was changed" email is sent afterwards, best-effort.

The password policy is the same one sign-up enforces (`validatePassword` in
`validators/authValidator.js`), and re-using the current password is refused.

Errors: `400 VALIDATION_ERROR` / `PASSWORD_UNCHANGED`, `409
RESET_TOKEN_NOT_ACTIVE` (unknown or already used — deliberately the same answer
for both), `410 RESET_TOKEN_EXPIRED`, `403 ACCOUNT_INACTIVE`.

### Billing — service selection and Stripe Checkout

A company buys any combination of **Bookkeeping**, **Payroll**, and **Taxes** in
one Stripe Checkout Session. Bookkeeping has four price tiers, Taxes three, and
Payroll is a base price plus two per-unit add-ons (W-2 employees, 1099
contractors) whose quantities come from the request.

**The client never sends a Stripe id, a unit price, or a total.** It sends an
*option id* from `config/serviceCatalog.js` and, for payroll, two integer counts.
Everything else is resolved server-side:

```
option id  ->  plan_code  ->  service_plans row  ->  Stripe Price
(client)      (serviceCatalog)  (database)          (verified live)
```

Before any price reaches a Checkout Session it is re-read from Stripe and checked
to be active, to belong to the **expected product**, to use the supported
currency, and to have the interval the catalog claims. A mismatch is a `422`, not
a silent charge. Sending `price_id`, `stripe_product_id`, `unit_amount`, or
`total_amount` in the body is a `400` naming the field.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/billing/plans` | token | Sellable options by our own ids, with amounts |
| `POST /api/billing/checkout` | token + `OWNER`/`ADMIN` | One session for every selected service |
| `GET /api/billing/checkout-status?session_id=` | token | Normalized `paid`/`processing`/`pending`/`cancelled`/`failed` |
| `GET /api/billing/subscription?company_id=` | token | Current subscription, lines, renewal date |
| `PATCH /api/billing/subscription/payroll` | token + `OWNER`/`ADMIN` | Change the billed head counts |
| `DELETE /api/billing/subscription` | token + `OWNER`/`ADMIN` | Cancel (end of period by default) |
| `GET /api/billing/payments?company_id=` | token | Payment history, paginated |
| `POST /api/billing/portal` | token + `OWNER`/`ADMIN` | Link into Stripe's hosted billing portal |
| `POST /api/billing/webhook` | **Stripe signature** | The only place a service is activated |

#### `POST /api/billing/checkout`

```jsonc
{
  "company_id": 1,
  "selected_services": {
    "bookkeeping": { "selected": true, "price_option_id": "bookkeeping_option_2" },
    "payroll":     { "selected": true, "plan_id": "payroll_standard",
                     "employee_count": 12, "contractor_count": 4 },
    "taxes":       { "selected": true, "price_option_id": "tax_option_3" }
  }
}
```

Returns `201` with `checkout_url`, `checkout_session_id`, and a `pricing_summary`
whose amounts are **integer minor units** (cents), computed server-side from the
approved prices:

```
payroll total = base + (employee_count x employee unit) + (contractor_count x contractor unit)
```

Optional `Idempotency-Key` header; without one, a key derived from the caller,
company, and exact selection still absorbs a double-clicked Pay button. A
zero-quantity payroll component is omitted from the session entirely; the base is
always billed.

#### Amounts and money

Every amount in this flow is an **integer number of minor units**, never a float
— the same unit Stripe reports, so the two never disagree by a cent.
`service_plans.amount` is a display cache; the authority is the live Stripe
Price, and what a subscriber actually pays is frozen in
`company_subscription_items.unit_amount` at purchase, so a later price rise never
rewrites an existing subscription.

#### `POST /api/billing/webhook`

Mounted in `src/app.js` **before `express.json()`** and parsed with
`express.raw`. That ordering is load-bearing: Stripe signs the exact bytes it
sent, and parsing then re-serialising produces different ones. There is no
`requireAuth` — Stripe holds no token, so the **signature is** the
authentication.

Landing on the success page is never treated as proof of payment. A subscription
becomes `ACTIVE` only here, after the signature verifies and the billed line
items are re-validated against the catalog a second time.

Delivery is idempotent (`stripe_events` claims the event id before processing and
stamps `processed_at` only on success, so a crash mid-processing is retried while
a duplicate is dropped) and safe against out-of-order delivery
(`company_subscriptions.last_stripe_event_at` is a high-water mark; cancellation
is additionally terminal).

#### Configuration

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required in production and
the app refuses to start without them. Outside production the billing routes
answer `503 STRIPE_NOT_CONFIGURED` and everything else — including the test
suite — runs with no Stripe account at all. See `.env.example` for the optional
knobs (proration behaviour, head-count ceilings, whether Stripe ids are echoed to
the client).

The plan catalog lives in `service_plans`, not in environment variables. The
`STRIPE_*_PRODUCT_ID` / `STRIPE_*_PRICE_ID` vars are optional **pins**: when set,
the catalog row must match or the request is refused. A pin can only reject an
id, never supply one, so the database stays the single source of truth.

Local webhook testing:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

## Adding a feature

1. Create any new tables by hand: run the DDL against the database, save it as
   the next file in `db/schema/`, then `npm run db:pull && npm run db:generate`
   so `prisma/schema.prisma` and the client match reality.
2. Create a controller in `src/controllers/`.
3. Create a router in `src/routes/` and wire handlers to the controller.
4. Mount the router in `src/routes/index.js`.
5. Wrap async handlers with `middlewares/asyncHandler` and throw `utils/ApiError`
   for expected error responses.
