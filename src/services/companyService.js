'use strict';

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { logEvent } = require('../utils/auditLog');
const catalog = require('../config/serviceCatalog');
const repo = require('../repositories/companyRepository');
// The specialist profile carries that person's task table, so it reads the tasks
// directly rather than through projectTaskService — that service's entry points
// apply the TASK access rule, and this endpoint has already applied the stricter
// staffing one.
const taskRepo = require('../repositories/projectTaskRepository');
const dto = require('../dto/companyDto');
const taskDto = require('../dto/projectTaskDto');
const adminEvents = require('./adminEventService');
// One-way dependency: projectService reaches for repositories, never for this
// file, so requiring it here cannot close a cycle.
const projectService = require('./projectService');
// Likewise one-way, and required for the same reason the paywall middleware
// requires it: `profileComplete` must have exactly one definition, and that
// definition lives with the endpoint that publishes it.
const onboardingService = require('./onboardingService');

/**
 * Company onboarding and team management.
 *
 * The caller is always identified by the verified access token (userId passed in
 * from req.user) — never from the request body. All multi-write operations run in
 * a single Prisma transaction so a failure leaves nothing half-created.
 *
 * Role model (mapped onto the existing role hierarchy — no new roles are needed):
 *   - OWNER              -> top-level role CUSTOMER + specific role OWNER
 *   - ACCOUNTING_MANAGER -> top-level role ACCOUNTING_MANAGER
 *   - SPECIALIST         -> top-level role SPECIALIST
 *   - ADMIN              -> top-level role ADMIN (may act on any company)
 */

/* ------------------------------ role helpers ----------------------------- */

function isAdmin(user) {
  return user?.role?.code === 'ADMIN';
}
function hasOwnerRole(user) {
  return user?.role?.code === 'CUSTOMER' && user?.specificRole?.code === 'OWNER';
}
function hasAccountingManagerRole(user) {
  return user?.role?.code === repo.ACCOUNTING_MANAGER_ROLE_CODE;
}
function hasSpecialistRole(user) {
  return user?.role?.code === 'SPECIALIST';
}

/* ------------------------------ error helpers ---------------------------- */

// The token authenticated but its subject is gone.
function callerNotFound() {
  return new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
}
// A user named in the request body/params does not exist.
function targetUserNotFound() {
  return new ApiError(404, 'The specified user could not be found.', { code: 'USER_NOT_FOUND' });
}
function ownerRoleRequired() {
  return new ApiError(403, 'Only an account owner can perform company onboarding.', {
    code: 'OWNER_ROLE_REQUIRED',
  });
}
function companyNotFound() {
  return new ApiError(404, 'Company not found.', { code: 'COMPANY_NOT_FOUND' });
}
function companyAccessDenied() {
  return new ApiError(403, 'You do not have access to this company.', { code: 'COMPANY_ACCESS_DENIED' });
}

/**
 * The gate on every specialist write: only the company's OWN accounting manager
 * may staff it.
 *
 * Not an admin, and not the company owner. Deciding which specialist works an
 * account is the accounting manager's job — they are the person responsible for
 * that company's books and the one who knows who has capacity. An admin assigns
 * the ACCOUNTING MANAGER (see assertAdminForManagerWrite) and stops there; the
 * manager then staffs their own accounts. The two writes are deliberately held
 * by different people, so neither can quietly do the other's job.
 *
 * Scoped to the company, not to the role at large: holding ACCOUNTING_MANAGER
 * makes you eligible to be assigned, it does not make you responsible for every
 * company in the system. A manager who is not on this account has no more
 * business staffing it than a stranger.
 *
 * Checked against the database — `caller` is loaded by role, and
 * `company.accountingManagerUserId` is the current column value — so a stale
 * token or a hidden frontend route changes nothing.
 */
function assertCompanyAccountingManager(caller, company) {
  if (!hasAccountingManagerRole(caller) || caller.status !== 'ACTIVE') {
    throw new ApiError(403, 'Only an accounting manager can assign specialists.', {
      code: 'ACCOUNTING_MANAGER_ROLE_REQUIRED',
    });
  }
  if (company.accountingManagerUserId !== caller.id) {
    throw new ApiError(403, 'You are not the accounting manager for this company.', {
      code: 'NOT_COMPANY_ACCOUNTING_MANAGER',
    });
  }
}

/**
 * Reading the staffing picker: the company's accounting manager (who is about to
 * use it) or an admin (who can already see the team on the company table, and
 * for whom this is view-only — the write above still refuses them).
 */
function assertCanReadSpecialistOptions(caller, company) {
  if (isAdmin(caller)) return;
  assertCompanyAccountingManager(caller, company);
}

/**
 * The admin company table is ADMIN-only.
 *
 * The admin's job on it is appointing an accounting manager to a company, which
 * is why it lists every company and carries the eligible-manager collection. A
 * manager's own working view of their accounts is a different, richer endpoint —
 * GET /accounting-manager/companies — so this one does not need to serve both.
 *
 * Checked against the DATABASE rather than a token claim. The route carries
 * requireRole as well, but that is an early filter on whatever the token happens
 * to be carrying; this is the decision, so a hidden frontend route, a stale
 * token, or a hand-written request all end at the same answer.
 */
function assertAdminForCompanyAccounts(caller) {
  if (isAdmin(caller)) return;
  throw new ApiError(403, 'Only an administrator can view the company accounts table.', {
    code: 'ADMIN_ROLE_REQUIRED',
  });
}

/**
 * The manager's own accounts. Holding the role is the whole test — WHICH
 * companies they get is decided by the query, which narrows to the ones they are
 * the accounting manager of.
 */
function assertAccountingManager(caller) {
  if (hasAccountingManagerRole(caller) && caller.status === 'ACTIVE') return;
  throw new ApiError(403, 'Only an accounting manager can view managed accounts.', {
    code: 'ACCOUNTING_MANAGER_ROLE_REQUIRED',
  });
}

/**
 * 409, not 422: the request is well-formed, it conflicts with what already
 * exists. `reason` distinguishes the two collisions for the UI without telling
 * an unauthenticated-ish caller WHICH company or user holds the address — the
 * message stays the same either way, so this endpoint cannot be used to probe
 * for registered emails.
 */
function companyEmailInUse(reason) {
  return new ApiError(409, 'This email address is already in use.', {
    code: 'COMPANY_EMAIL_IN_USE',
    fields: { company_email: 'This email is already registered. Use a different one.' },
    details: { reason },
  });
}

/* --------------------------- authorization -------------------------------- */

/** Load the caller (with role) or 401. */
async function loadCaller(userId) {
  const caller = await repo.findUserWithRole(prisma, userId);
  if (!caller) throw callerNotFound();
  return caller;
}

/** Load a non-deleted company or 404. */
async function loadCompany(companyId, { withPeople = false } = {}) {
  const company = withPeople
    ? await repo.findCompanyWithPeople(prisma, companyId)
    : await repo.findCompanyById(prisma, companyId);
  if (!company) throw companyNotFound();
  return company;
}

/** Write access: the owner of the company or an admin. */
function assertManageAccess(caller, company) {
  if (isAdmin(caller) || company.ownerUserId === caller.id) return;
  throw companyAccessDenied();
}

/** Read access: owner, admin, the company's accounting manager, or an active specialist. */
async function assertReadAccess(caller, company) {
  if (isAdmin(caller) || company.ownerUserId === caller.id) return;
  if (company.accountingManagerUserId && company.accountingManagerUserId === caller.id) return;
  const assignment = await repo.findActiveAssignmentForUser(prisma, {
    companyId: company.id,
    userId: caller.id,
  });
  if (assignment) return;
  throw companyAccessDenied();
}

/* ------------------------------ idempotency ------------------------------ */

/** Stable SHA-256 of the canonical request input, to pin a key to one payload. */
function fingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/* --------------------------- company email rules ------------------------- */

/**
 * A company email must be free, and must not be a person's login address.
 *
 * Two separate collisions, both a 409:
 *
 *   company — another live company already bills to it. company_email is what
 *             Stripe invoices and what receipts are sent to, so sharing one
 *             means two businesses' billing lands in the same inbox.
 *   user    — it is somebody's account email. Login identity and company
 *             identity are deliberately different things here (one user owns
 *             many companies); letting them share an address collapses that,
 *             and makes "who is this mail for?" unanswerable.
 *
 * A pre-check, not the guarantee. Two simultaneous requests can both pass it —
 * the unique index in db/schema/09 is what actually holds the line, and
 * onboardCompany maps its P2002 back to this same error. Checking first is worth
 * it anyway: it produces a field-level message instead of a raw constraint
 * violation, and it fails before the transaction creates an address row.
 */
async function assertCompanyEmailAvailable(companyEmail) {
  const [company, user] = await Promise.all([
    repo.findCompanyByEmail(prisma, companyEmail),
    repo.findUserByEmail(prisma, companyEmail),
  ]);
  if (company) throw companyEmailInUse('company');
  if (user) throw companyEmailInUse('user');
}

/**
 * Did this write fail on the company-email unique index?
 *
 * Where P2002 names the offending column depends on the driver, and this app
 * runs Prisma 7 over the pg adapter — which leaves `meta.target` UNDEFINED for a
 * functional index and reports 'lower(company_email::text' under
 * `meta.driverAdapterError.cause.constraint.fields` instead. A matcher that knew
 * only the classic `meta.target` shape would silently never fire, turning what
 * should be a clean 409 into a raw 500 on the exact race this exists to catch.
 *
 * So every shape is searched, plus the driver's own message as a last resort.
 * Broad on purpose: the only other unique index on this table is
 * stripe_customer_id, which cannot mention company_email.
 */
function isCompanyEmailConflict(err) {
  if (err?.code !== 'P2002') return false;

  const cause = err.meta?.driverAdapterError?.cause;
  return [
    err.meta?.target, // classic engine: string or array of column names
    cause?.constraint?.fields, // pg adapter: array, functional expression included
    cause?.constraint?.index, // pg adapter: the index name, when it reports one
    cause?.originalMessage, // '…violates unique constraint "companies_company_email_key"'
  ]
    .flat()
    .filter(Boolean)
    .join(' ')
    .includes('company_email');
}

/* --------------------------- company onboarding -------------------------- */

/**
 * POST /onboarding/company — provision a new company owned by the authenticated
 * user. Creates the address, the company, and the company-address mapping, then
 * marks onboarding complete — all in one transaction. Idempotent when an
 * Idempotency-Key is supplied: a retry replays the stored response instead of
 * creating a second company.
 *
 * @returns {Promise<{ statusCode: number, body: object, idempotent: boolean }>}
 */
async function onboardCompany({ userId, requestId, idempotencyKey, input }) {
  const caller = await loadCaller(userId);
  if (!hasOwnerRole(caller)) {
    logEvent({ event: 'company.onboarding.denied', status: 'failure', requestId, userId, detail: 'owner_role_missing' });
    throw ownerRoleRequired();
  }

  /*
   * The steps are in an order, and the order is enforced here rather than only
   * in the client's router.
   *
   * Onboarding is profile -> company -> payment, but nothing on this endpoint
   * ever said so: the role gate above asks who the caller is, not how far
   * through they are, so a caller skipping the UI could create a company while
   * their own name was still blank. Every screen that lists companies shows the
   * owner beside them, so that is a nameless row on an admin's table.
   *
   * `getStatus` is what GET /onboarding returns, and asking it rather than
   * re-deriving the four fields keeps one definition of "profile complete" —
   * the same reason requirePaidAccount goes through it.
   */
  const { profileComplete } = (await onboardingService.getStatus(userId)).onboarding;
  if (!profileComplete) {
    logEvent({
      event: 'company.onboarding.denied',
      status: 'failure',
      requestId,
      userId,
      errorCode: 'PROFILE_INCOMPLETE',
      detail: 'profile_incomplete',
    });
    throw new ApiError(409, 'Complete your profile before adding a company.', {
      code: 'PROFILE_INCOMPLETE',
    });
  }

  /*
   * One unpaid company at a time. Finishing this form and walking away from the
   * bill used to leave a live, fully-formed company that nothing was charging
   * for, and the owner was free to do it again — so an account could accumulate
   * any number of shells with no services attached.
   *
   * Checked BEFORE the idempotency lookup, so a client replaying a key it never
   * paid for is refused rather than handed back a stored 201. The rule is about
   * the state of the account, not about this particular request.
   */
  const unpaid = await repo.findUnpaidCompanyForOwner(prisma, userId);
  if (unpaid) {
    logEvent({
      event: 'company.onboarding.denied',
      status: 'failure',
      requestId,
      userId,
      companyId: unpaid.id,
      errorCode: 'COMPANY_PAYMENT_REQUIRED',
      detail: 'unpaid_company_exists',
    });
    throw new ApiError(402, `Complete payment for ${unpaid.companyName} before adding another company.`, {
      code: 'COMPANY_PAYMENT_REQUIRED',
      details: { companyId: unpaid.id, companyName: unpaid.companyName },
    });
  }

  const requestHash = fingerprint(input);

  // Idempotency pre-check: a completed key replays; a reused key with a different
  // payload is rejected.
  if (idempotencyKey) {
    const existing = await repo.findIdempotencyKey(prisma, { userId, idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(422, 'This Idempotency-Key was already used with a different request.', {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      logEvent({ event: 'company.onboarding.replayed', status: 'success', requestId, userId, companyId: existing.companyId, idempotent: true });
      return { statusCode: existing.responseStatus, body: existing.responseBody, idempotent: true };
    }
  }

  logEvent({ event: 'company.onboarding.started', status: 'started', requestId, userId });

  // Before the transaction: a rejected email must leave no address row behind.
  try {
    await assertCompanyEmailAvailable(input.companyEmail);
  } catch (err) {
    logEvent({
      event: 'company.onboarding.denied',
      status: 'failure',
      requestId,
      userId,
      errorCode: 'COMPANY_EMAIL_IN_USE',
      detail: err.details?.reason,
    });
    throw err;
  }

  const { address } = input;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Step 8: create the address in the shared addresses table.
      const createdAddress = await repo.createAddress(tx, {
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
        countryCode: address.countryCode,
      });
      logEvent({ event: 'company.address.created', status: 'success', requestId, userId });

      // Step 6 + 7: create the company owned by the authenticated user.
      const created = await repo.createCompany(tx, {
        companyName: input.companyName,
        companyType: input.companyType,
        companyEmail: input.companyEmail,
        companyPhone: input.companyPhone,
        employeeCount: input.employeeCount,
        lastYearRevenue: input.lastYearRevenue,
        revenueCurrency: input.revenueCurrency,
        // Ownership comes from the verified token, never from the request.
        ownerUserId: userId,
        /*
         * No accounting manager here, ever. Every company is staffed by an
         * admin through PUT /companies/:companyId/accounting-manager — a new
         * company is created unassigned even when the same owner already has
         * companies with a manager, because who works an account is a staffing
         * decision that belongs to the admin, not something a customer can set
         * in motion by filling in the onboarding form. The column keeps its
         * NULL default.
         */
        status: 'ONBOARDING',
      });
      logEvent({ event: 'company.created', status: 'success', requestId, userId, companyId: created.id });

      // Step 9: link the address to the company as its primary business address.
      await repo.createCompanyAddress(tx, {
        companyId: created.id,
        addressId: createdAddress.id,
        addressType: 'BUSINESS',
        isPrimary: true,
      });
      logEvent({ event: 'company.address.linked', status: 'success', requestId, userId, companyId: created.id });

      /*
       * Step 10: mark the FORM complete — and nothing more.
       *
       * The company deliberately stays ONBOARDING. Activating it here said a
       * company was live the moment its details were typed in, before a single
       * service had been selected or a penny charged, which made an unpaid shell
       * indistinguishable from a paying customer everywhere `status` is read —
       * the admin table, the pickers, every filter.
       *
       * Payment is what activates a company, so the flip to ACTIVE belongs to
       * the Stripe webhook that sees the subscription go live
       * (stripeWebhookService.syncCompanyOnSubscriptionStatus, which also
       * suspends it again if that subscription later lapses).
       * `onboardingCompleted` still goes true here, because it is a fact about
       * this form and it is genuinely finished.
       */
      const finalized = await repo.updateCompany(tx, created.id, {
        onboardingCompleted: true,
      });

      // Step 11: build the response now that all ids exist.
      const body = {
        success: true,
        message: 'Company onboarding completed.',
        data: dto.toCompanyOnboardingResponse({
          company: finalized,
          address: createdAddress,
        }),
      };

      // Persist the idempotency record inside the SAME transaction, so the company
      // and its idempotency key commit atomically. A concurrent request under the
      // same key loses the unique(user_id, key) race here with P2002.
      if (idempotencyKey) {
        await repo.createIdempotencyKey(tx, {
          idempotencyKey,
          userId,
          method: 'POST',
          path: '/onboarding/company',
          requestHash,
          responseStatus: 201,
          responseBody: body,
          companyId: finalized.id,
        });
      }

      return {
        companyId: finalized.id,
        body,
        // Carried out of the transaction for the post-commit broadcast below.
        company: {
          ...finalized,
          owner: { id: caller.id, firstName: caller.firstName, lastName: caller.lastName, email: caller.email },
          accountingManager: null,
        },
      };
    });

    logEvent({ event: 'company.onboarding.completed', status: 'success', requestId, userId, companyId: result.companyId });
    logEvent({ event: 'transaction.committed', status: 'success', requestId, userId, companyId: result.companyId });

    // AFTER the commit, never inside it: an event announcing a company that a
    // rollback then erased would leave every open admin screen holding a row the
    // database does not have.
    adminEvents.companyCreated(result.company);

    return { statusCode: 201, body: result.body, idempotent: false };
  } catch (err) {
    /*
     * Checked BEFORE the idempotency replay below, because both surface as P2002
     * and only this one names the company-email index. Getting the order wrong
     * would answer a genuine email collision with some earlier request's stored
     * 201 — reporting a company created that the transaction just rolled back.
     *
     * Reached when the pre-check passed and a concurrent request committed the
     * same address in between. The index is the real guarantee; this only
     * translates it back into the same 409 the pre-check would have raised.
     */
    if (isCompanyEmailConflict(err)) {
      logEvent({
        event: 'company.onboarding.denied',
        status: 'failure',
        requestId,
        userId,
        errorCode: 'COMPANY_EMAIL_IN_USE',
        detail: 'race',
      });
      throw companyEmailInUse('company');
    }

    // A concurrent onboarding under the same Idempotency-Key committed first: our
    // transaction rolled back, so return the winner's stored response.
    if (idempotencyKey && err.code === 'P2002') {
      const winner = await repo.findIdempotencyKey(prisma, { userId, idempotencyKey });
      if (winner) {
        logEvent({ event: 'company.onboarding.replayed', status: 'success', requestId, userId, companyId: winner.companyId, idempotent: true });
        return { statusCode: winner.responseStatus, body: winner.responseBody, idempotent: true };
      }
    }

    logEvent({ event: 'transaction.rolled_back', status: 'error', requestId, userId, detail: 'onboarding_failed' });

    // Known ApiErrors and Prisma known-request errors carry a precise status/code
    // for the central handler; anything else becomes the documented generic
    // onboarding failure rather than leaking internals.
    if (err instanceof ApiError || err.name === 'PrismaClientKnownRequestError') throw err;
    throw new ApiError(500, 'Unable to complete company onboarding.', { code: 'COMPANY_ONBOARDING_FAILED' });
  }
}

/* ------------------------------ company reads ---------------------------- */

/**
 * Describe the caller's relationship to a company, so the frontend can decide
 * which actions to render without re-deriving the authorization rules. Those
 * rules live here; a client that reimplements them is a client that will
 * eventually disagree with the server about what a user may do.
 */
async function accessRoleFor(caller, company) {
  if (isAdmin(caller)) return 'ADMIN';
  if (company.ownerUserId === caller.id) return 'OWNER';
  if (company.accountingManagerUserId === caller.id) return 'ACCOUNTING_MANAGER';
  const assignment = await repo.findActiveAssignmentForUser(prisma, {
    companyId: company.id,
    userId: caller.id,
  });
  return assignment ? 'SPECIALIST' : null;
}

/**
 * Load the active subscription and the team for a page of companies, in two
 * queries rather than two per company.
 *
 * Every company read returns the same enriched row — active services, billing
 * date, team — so this is shared by the caller's own list, the single-company
 * read, and the admin table. Asking per company would make a 25-row page fifty
 * round trips.
 *
 * @returns {{ subscriptionFor: (id: number) => object|null, assignmentsFor: (id: number) => object[] }}
 */
async function loadCompanyContext(companyIds) {
  if (!companyIds.length) {
    return { subscriptionFor: () => null, assignmentsFor: () => [] };
  }

  const [subscriptions, assignments] = await Promise.all([
    repo.listActiveSubscriptionsForCompanies(prisma, companyIds),
    repo.listActiveAssignmentsForCompanies(prisma, companyIds),
  ]);

  const subscriptionByCompany = new Map(subscriptions.map((s) => [s.companyId, s]));
  const assignmentsByCompany = new Map();
  for (const assignment of assignments) {
    if (!assignmentsByCompany.has(assignment.companyId)) assignmentsByCompany.set(assignment.companyId, []);
    assignmentsByCompany.get(assignment.companyId).push(assignment);
  }

  return {
    subscriptionFor: (id) => subscriptionByCompany.get(id) ?? null,
    assignmentsFor: (id) => assignmentsByCompany.get(id) ?? [],
  };
}

/**
 * GET /companies — every live company the caller can reach.
 *
 * This endpoint is what makes the rest of the company and billing API usable at
 * all. `companyId` was previously returned exactly once, by the onboarding call
 * that created it, and there was no way to look it up again — so after a page
 * refresh the frontend could not address a company it had just created, and a
 * user who owns several had no way to enumerate them.
 */
async function listCompanies({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  const admin = isAdmin(caller);

  const [rows, total] = await Promise.all([
    repo.listCompaniesForUser(prisma, { userId, isAdmin: admin, ...query }),
    repo.countCompaniesForUser(prisma, { userId, isAdmin: admin, ...query }),
  ]);

  /*
   * The same enriched row every other company read returns — active services,
   * billing date, team. A customer's dashboard and a specialist's account list
   * ask the same questions about a company as the admin table does, and the
   * answer should not depend on which endpoint asked. What the caller's role
   * changes is WHICH companies the filter above returned, and `accessRole`.
   */
  const context = await loadCompanyContext(rows.map((company) => company.id));

  const companies = [];
  for (const company of rows) {
    companies.push(
      dto.toCompanyAccountRow({
        company,
        address: company.addresses?.[0]?.address ?? null,
        subscription: context.subscriptionFor(company.id),
        assignments: context.assignmentsFor(company.id),
        accessRole: await accessRoleFor(caller, company),
      })
    );
  }

  logEvent({
    event: 'company.list.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return { companies, total };
}

/** GET /companies/:companyId — one company, with its primary address. */
async function getCompany({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await repo.findCompanyDetail(prisma, companyId);
  if (!company) throw companyNotFound();
  await assertReadAccess(caller, company);

  logEvent({ event: 'company.read', status: 'success', requestId, userId, companyId });

  const context = await loadCompanyContext([companyId]);

  return dto.toCompanyAccountRow({
    company,
    address: company.addresses?.[0]?.address ?? null,
    subscription: context.subscriptionFor(companyId),
    assignments: context.assignmentsFor(companyId),
    accessRole: await accessRoleFor(caller, company),
  });
}

/* ----------------------------- company update ---------------------------- */

/**
 * PATCH /companies/:companyId — correct company details after onboarding.
 *
 * Previously a company was immutable once created: a typo in the billing email,
 * a moved office, or a changed head count had no route at all. Requires manage
 * access (owner or admin), same as the team writes.
 *
 * The address is REPLACED in place rather than merged field by field. A partial
 * address update is how you end up with a new street on an old postcode, and
 * this address ends up on Stripe invoices.
 */
async function updateCompany({ userId, requestId, companyId, input }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  assertManageAccess(caller, company);

  // The email uniqueness rule spans two tables and is only checked when the
  // value actually changes — re-submitting the current address must not collide
  // with the company's own row.
  if (input.companyEmail && input.companyEmail.toLowerCase() !== company.companyEmail.toLowerCase()) {
    await assertCompanyEmailAvailable(input.companyEmail);
  }

  const { address, ...companyFields } = input;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (address) {
        const existing = await repo.findPrimaryAddress(tx, companyId);
        if (existing) {
          await repo.updateAddress(tx, existing.id, {
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
            countryCode: address.countryCode,
          });
        } else {
          // A company onboarded before the address link existed, or one whose
          // link was lost. Create and attach rather than failing the update.
          const created = await repo.createAddress(tx, {
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
            countryCode: address.countryCode,
          });
          await repo.createCompanyAddress(tx, {
            companyId,
            addressId: created.id,
            addressType: 'BUSINESS',
            isPrimary: true,
          });
        }
      }

      if (Object.keys(companyFields).length) {
        await repo.updateCompany(tx, companyId, companyFields);
      }

      return repo.findCompanyDetail(tx, companyId);
    });

    logEvent({
      event: 'company.updated',
      status: 'success',
      requestId,
      userId,
      companyId,
      detail: Object.keys(input).join(','),
    });

    adminEvents.companyUpdated(updated);

    return dto.toCompanyDetail({
      company: updated,
      address: updated.addresses?.[0]?.address ?? null,
      accessRole: await accessRoleFor(caller, updated),
    });
  } catch (err) {
    // The partial functional unique index is the real guarantee; translate it
    // back into the same 409 the pre-check would have raised.
    if (isCompanyEmailConflict(err)) throw companyEmailInUse('company');
    throw err;
  }
}

/**
 * DELETE /companies/:companyId — soft delete.
 *
 * A tombstone, not a real delete: subscriptions, payments and assignments all
 * reference this row and the billing history has to survive. Every read already
 * filters on `deletedAt`, so the company disappears from the API immediately.
 *
 * Refused while a subscription is still live. Archiving a company that is being
 * charged would leave a Stripe subscription billing a customer for something
 * they can no longer see — cancel first, deliberately, so the money stops.
 */
async function deleteCompany({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  assertManageAccess(caller, company);

  const active = await prisma.companySubscription.findFirst({
    where: { companyId, status: { in: ['ACTIVE', 'PAST_DUE', 'UNPAID'] } },
    select: { id: true, status: true },
  });
  if (active) {
    throw new ApiError(409, 'Cancel the active subscription before archiving this company.', {
      code: 'SUBSCRIPTION_STILL_ACTIVE',
      details: { companySubscriptionId: active.id, status: active.status },
    });
  }

  const deleted = await repo.softDeleteCompany(prisma, companyId, new Date());

  logEvent({ event: 'company.archived', status: 'success', requestId, userId, companyId });

  // Every read filters on deletedAt, so to a listening admin this is a removal:
  // the id is what they need to drop the row.
  adminEvents.companyArchived(deleted);

  return { company: dto.toCompany(deleted) };
}

/* ----------------------------- user directory ---------------------------- */

/**
 * GET /users — the directory behind the assignment pickers.
 *
 * Assigning an accounting manager or a specialist requires a `userId`, and until
 * now nothing exposed one, so those screens could not be built. Restricted to
 * callers who can actually act on the result: an ADMIN, or a company owner (who
 * needs it to staff their own companies). It returns names, emails and roles of
 * ACTIVE users only — never a password hash, never login-security columns.
 */
async function listUsers({ userId, requestId, query }) {
  const caller = await loadCaller(userId);

  if (!isAdmin(caller) && !hasOwnerRole(caller)) {
    throw new ApiError(403, 'You do not have permission to browse users.', { code: 'FORBIDDEN' });
  }

  const [rows, total] = await Promise.all([
    repo.listDirectoryUsers(prisma, query),
    repo.countDirectoryUsers(prisma, query),
  ]);

  logEvent({
    event: 'user.directory.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return { users: rows.map(dto.toDirectoryUser), total };
}

/* ----------------------- accounting manager assignment ------------------- */

/**
 * The ADMIN gate shared by every accounting-manager write.
 *
 * Deliberately narrower than every other company write. An accounting manager is
 * staff, not someone the customer employs: they get read access to the company's
 * team and are the internal point of contact for its books. Letting a company
 * owner attach any user holding that role to their own company would let a
 * customer grant one of your staff access on their own initiative. Who serves
 * which account is an internal staffing decision, so it is made by an admin.
 *
 * This is the authoritative check — it reads the caller's role from the database
 * — and it stands whether or not a route gate ran first. The route gate exists to
 * turn away obvious cases early; it is not what decides.
 */
function assertAdminForManagerWrite(caller, { requestId, userId, companyId }) {
  if (isAdmin(caller)) return;
  logEvent({
    event: 'company.accounting_manager.denied',
    status: 'failure',
    requestId,
    userId,
    companyId,
    errorCode: 'ADMIN_ROLE_REQUIRED',
  });
  throw new ApiError(403, 'Only an administrator can assign an accounting manager.', {
    code: 'ADMIN_ROLE_REQUIRED',
  });
}

/**
 * PUT /companies/:companyId/accounting-manager — set or replace the company's
 * single accounting manager. ADMIN only.
 *
 * Four things are verified before the write, and all four inside the same
 * transaction as the write itself: the company exists (and is not soft-deleted),
 * the named user exists, that user is ACTIVE, and that user holds the
 * ACCOUNTING_MANAGER role right now. Checking outside the transaction would make
 * every one of them advisory — a user deactivated between the check and the
 * update would still end up attached.
 *
 * The status check is the one that used to be missing: the role was verified and
 * the account state was not, so a HIBERNATED former manager could be assigned to
 * a company and would show as its point of contact.
 */
async function assignAccountingManager({ userId, requestId, companyId, managerUserId }) {
  const caller = await loadCaller(userId);
  assertAdminForManagerWrite(caller, { requestId, userId, companyId });

  // Answer an unknown company with a 404 before opening a transaction. The
  // authoritative check is the re-read inside it — this one just avoids paying
  // for a transaction to say "no such company".
  await loadCompany(companyId);

  const { updated, previous } = await prisma.$transaction(async (tx) => {
    const current = await repo.findCompanyById(tx, companyId);
    if (!current) throw companyNotFound();

    const manager = await repo.findUserWithRole(tx, managerUserId);
    if (!manager) throw targetUserNotFound();
    if (!hasAccountingManagerRole(manager)) {
      throw new ApiError(422, 'The selected user is not an accounting manager.', {
        code: 'INVALID_ACCOUNTING_MANAGER_ROLE',
      });
    }
    if (manager.status !== 'ACTIVE') {
      throw new ApiError(422, 'The selected accounting manager is not an active user.', {
        code: 'INACTIVE_ACCOUNTING_MANAGER',
      });
    }

    return {
      previous: current.accountingManagerUserId,
      updated: await repo.setAccountingManager(tx, companyId, managerUserId),
    };
  });

  const replaced = previous && previous !== managerUserId;
  logEvent({
    event: replaced ? 'company.accounting_manager.replaced' : 'company.accounting_manager.assigned',
    status: 'success',
    requestId,
    userId,
    companyId,
    accountingManagerUserId: managerUserId,
  });

  adminEvents.accountingManagerAssigned(updated, previous);

  return { company: dto.toCompanyWithPeople(updated) };
}

/**
 * DELETE /companies/:companyId/accounting-manager — leave the company with no
 * accounting manager. ADMIN only.
 *
 * Removal had no route at all: a manager could be assigned and replaced, but the
 * only way back to "unassigned" was to attach somebody else. When a manager
 * leaves and no one has taken the account over yet, "nobody" is the truthful
 * answer, and a screen that cannot express it ends up showing a stale name.
 *
 * Idempotent: removing from a company that already has none is a 200 with
 * `alreadyRemoved: true`, not a 404. The caller's intent — "this company should
 * have no manager" — is satisfied either way, and a retried request must not
 * become an error.
 */
async function removeAccountingManager({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  assertAdminForManagerWrite(caller, { requestId, userId, companyId });

  const company = await loadCompany(companyId, { withPeople: true });

  /*
   * The "already unassigned?" question is answered INSIDE the transaction, not
   * from the read above. Deciding it outside would mean a concurrent assignment
   * landing in between gets reported as "there was nothing to remove" — the one
   * answer that is both wrong and reassuring.
   */
  const { updated, previous } = await prisma.$transaction(async (tx) => {
    const current = await repo.findCompanyById(tx, companyId);
    if (!current) throw companyNotFound();
    if (!current.accountingManagerUserId) return { updated: null, previous: null };
    return {
      previous: current.accountingManagerUserId,
      updated: await repo.setAccountingManager(tx, companyId, null),
    };
  });

  if (!updated) {
    return { company: dto.toCompanyWithPeople(company), alreadyRemoved: true };
  }

  logEvent({
    event: 'company.accounting_manager.removed',
    status: 'success',
    requestId,
    userId,
    companyId,
    accountingManagerUserId: previous,
  });

  adminEvents.accountingManagerRemoved(updated, previous);

  return { company: dto.toCompanyWithPeople(updated), alreadyRemoved: false };
}

/**
 * GET /admin/company-accounts — everything the admin management screen needs, in
 * one request.
 *
 * The eligible-manager collection is returned ONCE alongside the companies
 * rather than embedded per row: it does not vary by company, and repeating it
 * on forty rows is forty copies of the same list travelling over the wire to
 * populate one dropdown.
 *
 * ADMIN only, checked here against the database. The route gate in front of this
 * is defence in depth, not the decision — a page that is merely hidden from the
 * frontend router is not access control.
 */
async function listCompanyAccounts({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  assertAdminForCompanyAccounts(caller);

  const [rows, total, managers] = await Promise.all([
    repo.listCompaniesForUser(prisma, { userId, isAdmin: true, ...query }),
    repo.countCompaniesForUser(prisma, { userId, isAdmin: true, ...query }),
    repo.listEligibleAccountingManagers(prisma),
  ]);

  // Services, billing dates and teams for the WHOLE page in two queries, not two
  // per row — the same helper the caller-scoped reads use.
  const context = await loadCompanyContext(rows.map((company) => company.id));

  logEvent({
    event: 'admin.company_accounts.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return {
    companies: rows.map((company) =>
      dto.toCompanyAccountRow({
        company,
        address: company.addresses?.[0]?.address ?? null,
        subscription: context.subscriptionFor(company.id),
        assignments: context.assignmentsFor(company.id),
        // Always ADMIN here — the caller could not have got this far otherwise.
        accessRole: 'ADMIN',
      })
    ),
    accountingManagers: managers.map(dto.toDirectoryUser),
    total,
  };
}

/**
 * GET /admin/accounting-managers — the staffing report, read the other way
 * round.
 *
 * The company table answers "who manages THIS account?", one company at a time.
 * This answers "what does EACH manager carry?", which is the question behind
 * every rebalancing decision an admin makes and which no existing endpoint could
 * answer without the client fetching every company and grouping them itself.
 *
 * ADMIN only, checked against the database for the same reason as the company
 * table: the route's role gate reads a token claim, and a claim is a snapshot
 * from whenever it was signed.
 */
async function listAccountingManagers({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  if (!isAdmin(caller)) {
    throw new ApiError(403, 'Only an administrator can view the accounting managers.', {
      code: 'ADMIN_ROLE_REQUIRED',
    });
  }

  const [managers, total] = await Promise.all([
    repo.listAccountingManagersWithCompanies(prisma, query),
    repo.countAccountingManagers(prisma, query),
  ]);

  logEvent({
    event: 'admin.accounting_managers.read',
    status: 'success',
    requestId,
    userId,
    detail: `${managers.length}/${total}`,
  });

  return {
    accountingManagers: managers.map(dto.toAccountingManagerRow),
    total,
  };
}

function specialistNotFound() {
  return new ApiError(404, 'Specialist not found.', { code: 'SPECIALIST_NOT_FOUND' });
}

/**
 * Fold both attachment mechanisms into one per-specialist view.
 *
 * A specialist can appear in BOTH sources for the same company and service —
 * assigned in the table and holding the standing service-line column — so
 * companies and specialities are de-duplicated by key rather than concatenated.
 * Without that, the most correctly-configured accounts would be the ones
 * showing duplicate rows.
 *
 * Shared by the list and the profile so the two can never drift: a specialist
 * whose companies read one way in the table and another way on their own page
 * is a bug nobody reports, because each screen looks right on its own.
 */
function foldSpecialistAttachments({ userIds, assignments, standing }) {
  const byUser = new Map(userIds.map((id) => [id, { companies: new Map(), specialities: new Map() }]));

  for (const assignment of assignments) {
    const entry = byUser.get(assignment.specialistUserId);
    if (!entry) continue;
    const { specializationCode, specializationName } = assignment.specialization;
    entry.specialities.set(specializationCode, { code: specializationCode, name: specializationName });
    const company = entry.companies.get(assignment.company.id) ?? {
      companyId: assignment.company.id,
      companyName: assignment.company.companyName,
      status: assignment.company.status,
      services: new Set(),
    };
    company.services.add(specializationCode);
    entry.companies.set(assignment.company.id, company);
  }

  for (const company of standing) {
    for (const { specializationCode, column } of repo.STANDING_SPECIALIST_COLUMNS) {
      const holderId = company[column];
      const entry = holderId ? byUser.get(holderId) : null;
      if (!entry) continue;
      entry.specialities.set(specializationCode, {
        code: specializationCode,
        // The standing columns carry a code, not a joined specialization row.
        // Reuse the name already resolved from an assignment when there is one,
        // so the two sources cannot disagree about what BOOKKEEPING is called.
        name: entry.specialities.get(specializationCode)?.name ?? specializationCode,
      });
      const existing = entry.companies.get(company.id) ?? {
        companyId: company.id,
        companyName: company.companyName,
        status: company.status,
        services: new Set(),
      };
      existing.services.add(specializationCode);
      entry.companies.set(company.id, existing);
    }
  }

  return byUser;
}

/** One folded entry turned into the sorted, plain-array shape the DTOs take. */
function presentAttachments(entry) {
  return {
    specialities: [...entry.specialities.values()].sort((a, b) => a.code.localeCompare(b.code)),
    companies: [...entry.companies.values()]
      .map((company) => ({ ...company, services: [...company.services].sort() }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName)),
  };
}

/**
 * GET /specialists — the specialist directory, scoped to who is asking.
 *
 * ONE endpoint, two audiences, and each one has exactly one legal form of the
 * request:
 *
 *   ADMIN       every specialist in the organisation, including those not yet
 *               assigned to anything — the appointment view. `companyId` is
 *               REFUSED, not merely optional.
 *   ACCOUNTING  the specialists on ONE named company, and only a company where
 *   MANAGER     this caller is the accounting manager. `companyId` is REQUIRED:
 *               there is no "all specialists" answer for a manager, not even a
 *               merged one across their own accounts.
 *
 * Nobody else at all — the route gate turns other roles away, and the check
 * below is what actually decides. A company read is deliberately NOT enough:
 * the owner and the assigned specialists can read the company, but staffing is
 * the manager's working picture, and the team a customer may see is already
 * GET /companies/:companyId/team.
 *
 * "Attached" deliberately means either mechanism: an ACTIVE row in the
 * assignment table, or one of the three standing service-line columns on the
 * company. Which one was used is an internal modelling detail, and a directory
 * that consulted only one of them would omit real people.
 */
async function listSpecialistDirectory({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  const admin = isAdmin(caller);

  /*
   * Resolve the company scope BEFORE looking at any specialist.
   *
   * `null` means "no company restriction" and is reachable only by an admin who
   * asked for no filter. Everyone else gets a concrete list of ids, and an empty
   * list is a real answer — a user with no companies sees no specialists, which
   * is why the empty case returns early instead of falling through to a query
   * whose `id: { in: [] }` would look like "unrestricted" if it were ever
   * mistranslated.
   */
  let companyIds = null;

  /*
   * The two callers ask two different questions, and each parameter belongs to
   * exactly one of them.
   *
   * An admin gets the unfiltered roll — every specialist, assigned or not. The
   * filter is REFUSED rather than honoured: the admin screen has no company
   * filter, so a `companyId` on an admin request is the frontend sending a
   * manager's query on an admin's token, and answering it would hide that
   * confusion behind a plausible-looking page.
   *
   * A manager must name the company. Refused rather than defaulted to "all the
   * companies you manage" — a manager with three accounts would otherwise get a
   * merged list with no indication of which specialist belongs to which, an
   * answer to a question no screen asks, and one that quietly widens as they
   * take on accounts. Making it explicit costs the client one parameter it
   * already has.
   */
  if (admin && query.companyId) {
    throw new ApiError(400, 'companyId is not supported for an admin.', {
      code: 'COMPANY_FILTER_NOT_SUPPORTED',
      fields: { companyId: 'Remove the company filter.' },
    });
  }

  if (!admin && !query.companyId) {
    throw new ApiError(400, 'companyId is required.', {
      code: 'COMPANY_ID_REQUIRED',
      fields: { companyId: 'Select a company.' },
    });
  }

  if (query.companyId) {
    /*
     * Same rule as the staffing picker: THIS company's accounting manager, and
     * nobody else. Scoped to the company rather than to the role at large —
     * holding ACCOUNTING_MANAGER makes you eligible to be assigned, it does not
     * make you responsible for every account in the system.
     *
     * Deliberately narrower than a company read. The owner and the assigned
     * specialists can read the company, and until now that let them read this
     * directory too; who staffs an account is the manager's working picture, not
     * the customer's, and the team the customer is entitled to see is already
     * GET /companies/:companyId/team.
     */
    const company = await loadCompany(query.companyId);
    assertCanReadSpecialistOptions(caller, company);
    companyIds = [company.id];
  }

  // Which specialists are in scope at all. Admin with no filter: everyone.
  const scopedIds = companyIds === null ? null : await repo.listSpecialistIdsForCompanies(prisma, companyIds);

  if (scopedIds !== null && scopedIds.length === 0) {
    logEvent({ event: 'specialists.read', status: 'success', requestId, userId, detail: '0/0' });
    return { specialists: [], total: 0 };
  }

  const [rows, total] = await Promise.all([
    repo.listSpecialistDirectory(prisma, { userIds: scopedIds, ...query }),
    repo.countSpecialistDirectory(prisma, { userIds: scopedIds, ...query }),
  ]);

  const pageIds = rows.map((row) => row.id);

  // The companies each specialist on THIS PAGE serves — two queries for the
  // whole page, not two per row.
  const [assignments, standing] = await Promise.all([
    repo.listAssignmentsForSpecialists(prisma, { specialistUserIds: pageIds, companyIds }),
    repo.listStandingSpecialistCompanies(prisma, { specialistUserIds: pageIds, companyIds }),
  ]);

  /*
   * Fold both attachment mechanisms into one per-specialist view.
   *
   * A specialist can appear in BOTH sources for the same company and service —
   * assigned in the table and holding the standing column — so companies and
   * specialities are de-duplicated by key rather than concatenated. Without
   * that, the most correctly-configured accounts would be the ones showing
   * duplicate rows.
   */
  const byUser = foldSpecialistAttachments({ userIds: pageIds, assignments, standing });

  logEvent({
    event: 'specialists.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return {
    specialists: rows.map((user) => dto.toSpecialistRow({ user, ...presentAttachments(byUser.get(user.id)) })),
    total,
  };
}

/**
 * GET /specialists/:userId — the profile behind a clicked directory row.
 *
 * The same two audiences and the same rule as the list, deliberately: an admin
 * reads any specialist unscoped, an accounting manager reads a specialist ON a
 * company they manage. Anything looser and the profile would become the way
 * round the list's scope — the row you may not see, fetched by id.
 *
 * A specialist the caller's company has no attachment to is a 404 rather than a
 * 403. The distinction matters: a 403 would confirm the id belongs to a real
 * specialist, which is precisely what a manager probing ids should not learn,
 * and "not on this account" is honestly a missing row from where they stand.
 */
async function getSpecialistDetail({ userId, requestId, specialistUserId, query }) {
  const caller = await loadCaller(userId);
  const admin = isAdmin(caller);

  // Same contract as the list: the filter belongs to the manager, the unscoped
  // view belongs to the admin, and neither may borrow the other's form.
  if (admin && query.companyId) {
    throw new ApiError(400, 'companyId is not supported for an admin.', {
      code: 'COMPANY_FILTER_NOT_SUPPORTED',
      fields: { companyId: 'Remove the company filter.' },
    });
  }

  if (!admin && !query.companyId) {
    throw new ApiError(400, 'companyId is required.', {
      code: 'COMPANY_ID_REQUIRED',
      fields: { companyId: 'Select a company.' },
    });
  }

  let companyIds = null;

  if (query.companyId) {
    const company = await loadCompany(query.companyId);
    assertCanReadSpecialistOptions(caller, company);
    companyIds = [company.id];
  }

  const specialist = await repo.findSpecialistProfile(prisma, specialistUserId);
  if (!specialist) throw specialistNotFound();

  /*
   * Scope check BEFORE any further read. Authorising the company is not the same
   * as authorising this person: a manager holds one account, and the profile of
   * a specialist who has never worked it is not theirs to open.
   */
  if (companyIds !== null) {
    const scopedIds = await repo.listSpecialistIdsForCompanies(prisma, companyIds);
    if (!scopedIds.includes(specialist.id)) throw specialistNotFound();
  }

  const [assignments, standing, tasks] = await Promise.all([
    repo.listAssignmentsForSpecialists(prisma, { specialistUserIds: [specialist.id], companyIds }),
    repo.listStandingSpecialistCompanies(prisma, { specialistUserIds: [specialist.id], companyIds }),
    /*
     * The whole task table for this specialist on this company — every task,
     * across the company's projects, trimmed to the four columns the profile
     * renders (see dto.toProfileTask).
     *
     * UNPAGED, and bounded by the domain rather than by a `take`: these are the
     * open and closed tasks of ONE person on ONE account, which is a working
     * caseload, not a growing archive. A silent cap here would be worse than no
     * cap — a profile quietly showing the first 50 of 80 tasks looks complete
     * and is not. If a caseload ever does grow past what one response should
     * carry, GET /tasks?companyId=&specialistUserId= already pages and filters
     * it, and the fix is to point the profile at that rather than to truncate
     * here without saying so.
     *
     * Null for an admin: tasks hang off a company, and the admin's view names
     * none.
     */
    companyIds === null
      ? null
      : taskRepo.listCompanyTasks(prisma, {
          companyId: companyIds[0],
          projectId: null,
          status: null,
          specialistUserId: specialist.id,
          search: null,
          limit: undefined,
          offset: undefined,
          sort: 'deadlineDate',
          order: 'asc',
        }),
  ]);

  const byUser = foldSpecialistAttachments({ userIds: [specialist.id], assignments, standing });

  logEvent({
    event: 'specialist.detail.read',
    status: 'success',
    requestId,
    userId,
    detail: `specialist=${specialist.id} tasks=${tasks === null ? 'n/a' : tasks.length}`,
  });

  return dto.toSpecialistDetail({
    user: specialist,
    // The companies are folded but not returned: the fold is what proves the
    // specialities, and the profile shows the person rather than the account.
    specialities: presentAttachments(byUser.get(specialist.id)).specialities,
    tasks: tasks === null ? null : tasks.map(taskDto.toProfileTask),
  });
}

/**
 * GET /customers — the customer-side users, scoped to who is asking.
 *
 *   ADMIN       every CUSTOMER user with the companies they own. `companyId`
 *               optional; without it this is the whole customer base.
 *   EVERYONE    the customer users of ONE named company, which the caller must
 *   ELSE        have read access to. `companyId` is REQUIRED — an accounting
 *               manager's question is "who are the people on THIS account", and
 *               there is no unscoped version of it.
 *
 * Attachment is ownership, because that is the only customer-to-company link the
 * schema has: `companies.owner_user_id`. A CUSTOMER/TEAM user is therefore
 * visible to an admin (with an empty company list) and to nobody else, which is
 * the honest answer until team members are linked to a company.
 */
async function listCustomerDirectory({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  const admin = isAdmin(caller);

  if (!admin && !query.companyId) {
    throw new ApiError(400, 'companyId is required.', {
      code: 'COMPANY_ID_REQUIRED',
      fields: { companyId: 'Select a company.' },
    });
  }

  let companyIds = null;
  if (query.companyId) {
    const company = await loadCompany(query.companyId);
    await assertReadAccess(caller, company);
    companyIds = [company.id];
  }

  const scopedIds = companyIds === null ? null : await repo.listCustomerIdsForCompanies(prisma, companyIds);

  if (scopedIds !== null && scopedIds.length === 0) {
    logEvent({ event: 'customers.read', status: 'success', requestId, userId, detail: '0/0' });
    return { customers: [], total: 0 };
  }

  const [rows, total] = await Promise.all([
    repo.listCustomerDirectory(prisma, { userIds: scopedIds, companyIds, ...query }),
    repo.countCustomerDirectory(prisma, { userIds: scopedIds, ...query }),
  ]);

  logEvent({
    event: 'customers.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return { customers: rows.map(dto.toCustomerRow), total };
}

// A customer the caller may not see is the same answer as one who does not
// exist. Saying "forbidden" would confirm the id belongs to a real customer,
// which is exactly what a manager walking ids must not learn — and from where
// they stand, someone who is not on their account genuinely is a missing row.
function customerNotFound() {
  return new ApiError(404, 'Customer not found.', { code: 'CUSTOMER_NOT_FOUND' });
}

/**
 * Reading a customer profile: the ACCOUNTING MANAGER OF THIS COMPANY, and nobody
 * else.
 *
 * Not assertCompanyAccountingManager, which carries the specialist-assignment
 * wording — the codes are the same because the rule is the same, but a read that
 * tells you "only an accounting manager can assign specialists" is a message
 * about a different endpoint.
 *
 * NO ADMIN, unlike the directory this profile hangs off. That is a real
 * narrowing and it is deliberate: the customer's personal contact details and
 * home address are working material for the manager who has to reach them, and
 * an admin's job on the company table — appointing a manager — never needs them.
 * The admin still sees the customer row itself on GET /customers.
 */
function assertCanReadCustomerProfile(caller, company) {
  if (!hasAccountingManagerRole(caller) || caller.status !== 'ACTIVE') {
    throw new ApiError(403, 'Only an accounting manager can view a customer profile.', {
      code: 'ACCOUNTING_MANAGER_ROLE_REQUIRED',
    });
  }
  if (company.accountingManagerUserId !== caller.id) {
    throw new ApiError(403, 'You are not the accounting manager for this company.', {
      code: 'NOT_COMPANY_ACCOUNTING_MANAGER',
    });
  }
}

/**
 * GET /customers/:userId — the profile behind a clicked customer row.
 *
 * ONE audience: the accounting manager of the company named in `?companyId=`.
 * There is no unscoped form of this request and no admin form — a manager's
 * question is "who is this person on THIS account", and `companyId` is what
 * makes the answer checkable.
 *
 * The scope check runs AFTER the person is loaded but BEFORE anything is
 * returned, and it is the same one the list uses — authorising the company is
 * not the same as authorising this person. A customer who is not attached to the
 * named company is a 404, so the profile cannot become the way round the list:
 * the row you may not see, fetched by id.
 */
async function getCustomerDetail({ userId, requestId, customerUserId, query }) {
  const caller = await loadCaller(userId);

  if (!query.companyId) {
    throw new ApiError(400, 'companyId is required.', {
      code: 'COMPANY_ID_REQUIRED',
      fields: { companyId: 'Select a company.' },
    });
  }

  const company = await loadCompany(query.companyId);
  assertCanReadCustomerProfile(caller, company);

  const customer = await repo.findCustomerProfile(prisma, customerUserId);
  if (!customer) throw customerNotFound();

  const scopedIds = await repo.listCustomerIdsForCompanies(prisma, [company.id]);
  if (!scopedIds.includes(customer.id)) throw customerNotFound();

  logEvent({
    event: 'customer.detail.read',
    status: 'success',
    requestId,
    userId,
    companyId: company.id,
    detail: `customer=${customer.id}`,
  });

  return dto.toCustomerDetail(customer);
}

/**
 * GET /companies/owned — the live companies the caller OWNS.
 *
 * Exists to populate the teammate form's company picker, which is why it is
 * separate from GET /companies rather than a flag on it. That endpoint answers
 * "which companies can I reach", which for an accounting manager or a specialist
 * includes companies they emphatically do not own and must not be able to invite
 * anyone onto. Feeding the picker from it would offer choices the write endpoint
 * then rejects.
 *
 * No pagination: this is a dropdown, and an owner has a handful of companies.
 * `total` is returned anyway so the client renders a count without calling
 * `.length` on a list it may later paginate.
 */
async function listOwnedCompanies({ userId, requestId }) {
  const caller = await loadCaller(userId);

  const companies = await repo.listOwnedCompanyOptions(prisma, caller.id);

  logEvent({
    event: 'companies.owned.read',
    status: 'success',
    requestId,
    userId,
    detail: String(companies.length),
  });

  return { companies: companies.map(dto.toOwnedCompanyOption), total: companies.length };
}

/**
 * GET /teammates?companyId= — the customer-side people on one company.
 *
 * Scoped by the global `companyId` filter, the same way GET /customers and
 * GET /specialists are, so the three directories behave identically from a
 * client's point of view. The validator has already insisted the filter is
 * present; this decides whether the caller may USE it.
 *
 * Read access is the SAME rule as every other company read (owner, admin, the
 * company's accounting manager, or an assigned specialist), deliberately: the
 * roster is company data, and inventing a narrower rule here would mean a
 * specialist could open the company but not see who they are working with.
 *
 * Membership comes from `company_members`, which is what makes this endpoint
 * possible at all — it is the only customer-to-company link besides ownership,
 * and the owner is not in it, so the result is teammates without having to
 * subtract anyone.
 */
async function listTeammates({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(query.companyId);
  await assertReadAccess(caller, company);

  const scope = { companyId: company.id, specificRoleCode: query.specificRole, ...query };

  const [rows, total] = await Promise.all([
    repo.listTeammates(prisma, scope),
    repo.countTeammates(prisma, scope),
  ]);

  logEvent({
    event: 'company.teammates.read',
    status: 'success',
    requestId,
    userId,
    detail: `${company.id}:${rows.length}/${total}`,
  });

  return { teammates: rows.map(dto.toTeammateRow), total, companyId: company.id };
}

/**
 * GET /accounting-manager/companies — a manager's working view of the accounts
 * they are responsible for.
 *
 * Deliberately RICHER than the admin table, because it answers different
 * questions. The admin screen asks "who manages this company?" across every
 * company, and needs one row per company. A manager already knows who manages
 * these — they do — and needs to work them: which plan each service is on and at
 * what price, when the period ends, and who else is on the account.
 *
 * So each entry carries `servicePlans` (priced, per line, from the amounts
 * captured at purchase), the compact `activeServices` for a list view, `billing`,
 * and `members` with job titles and assignment dates.
 *
 * Scoped by `accountingManagerUserId`, not by the general access filter: "the
 * accounts I manage" is a narrower question than "companies I can see", and this
 * screen asks the first.
 */
async function listManagedCompanies({ userId, requestId, query }) {
  const caller = await loadCaller(userId);
  assertAccountingManager(caller);

  const scope = { managedByUserId: caller.id, ...query };

  const [rows, total] = await Promise.all([
    repo.listCompaniesForUser(prisma, scope),
    repo.countCompaniesForUser(prisma, scope),
  ]);

  const context = await loadCompanyContext(rows.map((company) => company.id));

  logEvent({
    event: 'accounting_manager.companies.read',
    status: 'success',
    requestId,
    userId,
    detail: `${rows.length}/${total}`,
  });

  return {
    companies: rows.map((company) =>
      dto.toManagedCompany({
        company,
        address: company.addresses?.[0]?.address ?? null,
        subscription: context.subscriptionFor(company.id),
        assignments: context.assignmentsFor(company.id),
      })
    ),
    total,
  };
}

/* -------------------------- active services ------------------------------ */

/**
 * The services a company is currently paying for, and the specialist each one
 * needs.
 *
 * The chain is entirely the schema's own: the ACTIVE subscription's items name
 * their `service_plan`, each plan carries a `specialization_id`, and the
 * specialization is the service. Only the last hop — specialization to the
 * specific role that staffs it — comes from the service catalog, because it is
 * the one relationship the tables do not encode (see config/serviceCatalog).
 *
 * A company with no ACTIVE subscription has no active services, which is a real
 * state and not an error: it has been onboarded but has not checked out.
 */
async function loadActiveServices(client, companyId) {
  const [subscription] = await repo.listActiveSubscriptionsForCompanies(client, [companyId]);
  const services = dto.toActiveServices(subscription).map((service) => ({
    ...service,
    requiredSpecificRole: catalog.specialistRoleForSpecialization(service.specializationCode),
  }));
  return { subscription: subscription ?? null, services };
}

/**
 * GET /admin/companies/:companyId/specialist-options — everything needed to
 * render the specialist dropdowns for one company.
 *
 * The server decides three things the client must not: WHICH services are
 * active, HOW MANY specialists that requires, and WHO is eligible for each. Each
 * service gets its OWN eligible list rather than one list to be filtered
 * client-side — a Tax Specialist appearing in the bookkeeping dropdown is a bug
 * that can only be prevented on this side of the wire, and the assignment
 * endpoint enforces exactly the same rule, so the picker can never offer a
 * choice the write would refuse.
 */
async function getSpecialistOptions({ userId, requestId, companyId }) {
  const caller = await loadCaller(userId);
  // withPeople: the standing-specialist columns are joined here, and they are
  // what "who is on this line right now" means.
  const company = await loadCompany(companyId, { withPeople: true });
  assertCanReadSpecialistOptions(caller, company);

  const { services } = await loadActiveServices(prisma, companyId);

  // Services whose specialization has no specialist kind configured are reported
  // with an empty list rather than dropped: a service nobody can be assigned to
  // is something an admin should see, not something the API should hide.
  const roleCodes = [...new Set(services.map((s) => s.requiredSpecificRole).filter(Boolean))];

  const [eligible, roleNames, assignments] = await Promise.all([
    repo.listEligibleSpecialists(prisma, roleCodes),
    repo.findSpecificRolesByCodes(prisma, roleCodes),
    repo.listActiveAssignmentsForCompanies(prisma, [companyId]),
  ]);

  const eligibleByRole = new Map();
  for (const user of eligible) {
    const code = user.specificRole?.code;
    if (!code) continue;
    if (!eligibleByRole.has(code)) eligibleByRole.set(code, []);
    eligibleByRole.get(code).push(user);
  }
  const roleNameByCode = new Map(roleNames.map((r) => [r.code, r.name]));

  logEvent({
    event: 'admin.specialist_options.read',
    status: 'success',
    requestId,
    userId,
    companyId,
    detail: `${services.length} service(s)`,
  });

  return dto.toSpecialistOptions({
    companyId,
    services: services.map((service) => ({
      ...service,
      requiredSpecificRoleName: roleNameByCode.get(service.requiredSpecificRole) ?? null,
      eligible: eligibleByRole.get(service.requiredSpecificRole) ?? [],
      assigned: currentSpecialistsFor(company, service, assignments),
    })),
  });
}

/**
 * Who currently holds a service, preferring the standing column on `companies`
 * over the assignment rows.
 *
 * The two can legitimately disagree: `company_specialist_assignments` permits
 * several ACTIVE rows for one specialization (that is what makes it a record of
 * work rather than of responsibility), so reading the dropdown's current value
 * from it would mean picking a winner. The column is the answer to "exactly
 * one", and the assignment row is looked up alongside only to supply its
 * `assignmentId`.
 *
 * Falls back to the rows for a specialization with no column — FA_Q today.
 */
function currentSpecialistsFor(company, service, assignments) {
  const rows = assignments.filter((a) => a.specializationId === service.specializationId);

  const column = catalog.specialistColumnForSpecialization(service.specializationCode);
  if (!column) return rows;

  const standingUserId = company[column];
  if (!standingUserId) return [];

  // The joined person for that column, e.g. company.taxSpecialist.
  const person = company[column.replace(/UserId$/, '')] ?? null;
  const row = rows.find((a) => a.specialistUserId === standingUserId);
  return [{ id: row?.id ?? null, specialist: person ?? row?.specialist ?? null }];
}

/**
 * PUT /admin/companies/:companyId/specialists — set the company's specialist
 * team in one transactional write.
 *
 * PUT, not POST: the request states the WHOLE staffing of the company's active
 * services, which is how the screen works — every dropdown is submitted
 * together. That also makes it idempotent, so a resubmitted form cannot stack up
 * duplicate assignments.
 *
 * Every rule is re-checked here even though the options endpoint already
 * enforced them, because the options endpoint is advice and this is the
 * decision: between the two calls a specialist can be deactivated, lose the
 * role, or a service can be cancelled, and a client can simply send whatever it
 * likes.
 */
async function setCompanySpecialists({ userId, requestId, companyId, assignments }) {
  const caller = await loadCaller(userId);
  // 404 before 403 would leak which company ids exist to anyone; this order —
  // load, then authorize — is the same one every other company write uses.
  assertCompanyAccountingManager(caller, await loadCompany(companyId));

  const result = await prisma.$transaction(async (tx) => {
    const company = await repo.findCompanyById(tx, companyId);
    if (!company) throw companyNotFound();
    // Re-checked inside the transaction: an admin can reassign the accounting
    // manager at any moment, and the caller must still hold the account at the
    // instant the write lands.
    assertCompanyAccountingManager(caller, company);

    const { services } = await loadActiveServices(tx, companyId);
    const serviceByCode = new Map(services.map((s) => [s.specializationCode, s]));

    // Every submitted service must be one the company actually pays for. A
    // specialist assigned to a service that was cancelled is worse than no
    // assignment: it reads as coverage that nobody is being billed for.
    for (const entry of assignments) {
      if (!serviceByCode.has(entry.specializationCode)) {
        throw new ApiError(422, `This company has no active ${entry.specializationCode} service.`, {
          code: 'SERVICE_NOT_ACTIVE',
          details: { specializationCode: entry.specializationCode, activeServices: [...serviceByCode.keys()] },
        });
      }
    }

    // …and every active service must be covered. The count is the server's rule
    // (one specialist per active service), so it is enforced here rather than
    // trusted from the client's own arithmetic.
    if (assignments.length !== services.length) {
      throw new ApiError(422, 'Provide exactly one specialist for each active service.', {
        code: 'INCOMPLETE_SPECIALIST_ASSIGNMENTS',
        details: {
          required: services.length,
          received: assignments.length,
          activeServices: [...serviceByCode.keys()],
        },
      });
    }

    const unassignedAt = new Date();
    const saved = [];
    /*
     * The standing-specialist columns on `companies` (db/schema/14), collected as
     * we go and written in ONE update at the end of the transaction.
     *
     * They are not a duplicate of the assignment rows, they answer a different
     * question: the assignment table records specialist WORK and deliberately
     * permits two active rows for one specialization, while these columns are
     * what "exactly one bookkeeping specialist on this account right now" means —
     * which is what the admin grid renders per line. Written in the same
     * transaction as the rows, so the two can never disagree.
     */
    const standing = {};

    for (const entry of assignments) {
      const service = serviceByCode.get(entry.specializationCode);

      const specialist = await repo.findUserWithRole(tx, entry.specialistUserId);
      if (!specialist) throw targetUserNotFound();
      if (!hasSpecialistRole(specialist)) {
        throw new ApiError(422, 'The selected user is not a specialist.', {
          code: 'INVALID_SPECIALIST_ROLE',
          details: { specialistUserId: entry.specialistUserId, specializationCode: entry.specializationCode },
        });
      }
      if (specialist.status !== 'ACTIVE') {
        throw new ApiError(422, 'The selected specialist is not an active user.', {
          code: 'INACTIVE_SPECIALIST',
          details: { specialistUserId: entry.specialistUserId },
        });
      }
      /*
       * The role has to match the SERVICE, not merely be a specialist role. This
       * is the check the whole feature turns on: a Tax Specialist on a company's
       * bookkeeping is a person with access to books they are not qualified for.
       */
      if (!service.requiredSpecificRole || specialist.specificRole?.code !== service.requiredSpecificRole) {
        throw new ApiError(422, 'The selected specialist does not hold the role this service requires.', {
          code: 'SPECIALIST_ROLE_MISMATCH',
          details: {
            specialistUserId: entry.specialistUserId,
            specializationCode: entry.specializationCode,
            requiredSpecificRole: service.requiredSpecificRole,
            actualSpecificRole: specialist.specificRole?.code ?? null,
          },
        });
      }

      // Stand down whoever else held this service, then ensure the chosen one is
      // active. Both inside the transaction, so the company is never briefly
      // covered by two specialists or by none.
      await repo.deactivateOtherAssignments(tx, {
        companyId,
        specializationId: service.specializationId,
        keepSpecialistUserId: entry.specialistUserId,
        unassignedAt,
      });

      const [existing] = await repo.findActiveAssignments(tx, {
        companyId,
        specialistUserId: entry.specialistUserId,
        specializationIds: [service.specializationId],
      });

      saved.push(
        existing
          ? { ...existing, specialization: { specializationCode: service.specializationCode, specializationName: service.specializationName }, specialist }
          : await repo.createAssignment(tx, {
              companyId,
              specialistUserId: entry.specialistUserId,
              specializationId: service.specializationId,
              assignmentStatus: 'ACTIVE',
            })
      );

      // Three of the four specializations have a standing column; FA_Q has none,
      // and is recorded in the assignment table alone.
      const column = catalog.specialistColumnForSpecialization(entry.specializationCode);
      if (column) standing[column] = entry.specialistUserId;

      logEvent({
        event: 'company.specialist.assigned',
        status: 'success',
        requestId,
        userId,
        companyId,
        specialistUserId: entry.specialistUserId,
        specializationCode: entry.specializationCode,
      });
    }

    if (Object.keys(standing).length) {
      await repo.updateCompany(tx, companyId, standing);
    }

    // Read the committed team back through the same query the table uses, so the
    // response and the broadcast describe the company exactly as the next page
    // load will.
    const refreshed = await repo.findCompanyWithPeople(tx, companyId);
    const team = await repo.listActiveAssignments(tx, companyId);
    return { company: refreshed, team, count: saved.length };
  });

  adminEvents.companyTeamChanged(result.company, result.team);

  /*
   * The staffing just changed, so projects on this company that were opened
   * while nobody was on their service line can now be filled in. See
   * projectService.backfillSpecialists — it only ever fills a NULL, so a project
   * that already has a specialist is left exactly as it is.
   *
   * Awaited but never allowed to throw: the assignment above has already
   * committed, and reporting a completed staffing change as failed because a
   * follow-up sweep stumbled would make the client retry a write that already
   * succeeded.
   */
  await projectService.backfillAfterStaffingChange(companyId, { requestId });

  return {
    companyId,
    assignmentCount: result.count,
    team: dto.toTeam({ company: result.company, assignments: result.team }),
  };
}

/* -------------------------- specialist assignment ------------------------ */

/**
 * Broadcast a company's team as it now stands.
 *
 * Read back from the database after the commit rather than assembled from what
 * the caller just asked for: the two differ whenever a write was partially
 * skipped (a duplicate assignment, a lost race), and the event must describe the
 * company as the next page load will find it.
 */
async function publishTeamChange(companyId) {
  const [company, assignments] = await Promise.all([
    repo.findCompanyWithPeople(prisma, companyId),
    repo.listActiveAssignments(prisma, companyId),
  ]);
  if (company) adminEvents.companyTeamChanged(company, assignments);
}

/**
 * POST /companies/:companyId/specialists — assign a specialist to the company for
 * one or more specializations. Requires manage access, the target to hold the
 * SPECIALIST role, and every specialization code to exist. Duplicate (already
 * active) assignments are skipped, not errored. Runs in a transaction.
 */
async function assignSpecialists({ userId, requestId, companyId, specialistUserId, specializationCodes }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  // Same gate as the bulk write. This endpoint assigns specialists too, so if it
  // kept the older owner-or-admin rule it would simply be the way around the new
  // one — and a rule with a second door is not a rule.
  assertCompanyAccountingManager(caller, company);

  const specialist = await repo.findUserWithRole(prisma, specialistUserId);
  if (!specialist) throw targetUserNotFound();
  if (!hasSpecialistRole(specialist)) {
    throw new ApiError(422, 'The selected user is not a specialist.', { code: 'INVALID_SPECIALIST_ROLE' });
  }

  // Resolve codes -> rows; any unknown/inactive code is a 400.
  const specs = await repo.findSpecializationsByCodes(prisma, specializationCodes);
  const byCode = new Map(specs.map((s) => [s.specializationCode, s]));
  const unknown = specializationCodes.filter((c) => !byCode.has(c));
  if (unknown.length) {
    throw new ApiError(400, 'One or more specialization codes are invalid.', {
      code: 'INVALID_SPECIALIZATION',
      details: { unknown },
    });
  }

  const specializationIds = specs.map((s) => s.id);

  const { created, skipped } = await prisma.$transaction(async (tx) => {
    const active = await repo.findActiveAssignments(tx, { companyId, specialistUserId, specializationIds });
    const activeSpecIds = new Set(active.map((a) => a.specializationId));

    const createdRows = [];
    const skippedCodes = [];

    for (const spec of specs) {
      if (activeSpecIds.has(spec.id)) {
        skippedCodes.push(spec.specializationCode);
        logEvent({ event: 'company.specialist.duplicate_prevented', status: 'skipped', requestId, userId, companyId, specialistUserId, specializationCode: spec.specializationCode, detail: 'duplicate' });
        continue;
      }
      try {
        const row = await repo.createAssignment(tx, {
          companyId,
          specialistUserId,
          specializationId: spec.id,
          assignmentStatus: 'ACTIVE',
        });
        createdRows.push(row);
        logEvent({ event: 'company.specialist.assigned', status: 'success', requestId, userId, companyId, specialistUserId, specializationCode: spec.specializationCode });
      } catch (err) {
        // Lost a race with a concurrent identical assignment (partial unique index).
        if (err.code === 'P2002') {
          skippedCodes.push(spec.specializationCode);
          logEvent({ event: 'company.specialist.duplicate_prevented', status: 'skipped', requestId, userId, companyId, specialistUserId, specializationCode: spec.specializationCode, detail: 'race' });
          continue;
        }
        throw err;
      }
    }

    return { created: createdRows, skipped: skippedCodes };
  });

  // The team changed, so the admin table's Team Members cell is stale. Read it
  // back after the commit and broadcast the committed state, not the intent.
  // The same change may also unblock projects that were opened unstaffed on this
  // service line — see the note in setCompanySpecialists.
  if (created.length) {
    await publishTeamChange(companyId);
    await projectService.backfillAfterStaffingChange(companyId, { requestId });
  }

  return {
    statusCode: created.length ? 201 : 200,
    created: created.map(dto.toAssignment),
    skipped,
  };
}

/* -------------------------------- team ----------------------------------- */

/** GET /companies/:companyId/team — owner, accounting manager, and specialists. */
async function getTeam({ userId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId, { withPeople: true });
  await assertReadAccess(caller, company);

  const assignments = await repo.listActiveAssignments(prisma, companyId);
  return dto.toTeam({ company, assignments });
}

/** GET /companies/:companyId/specialists — paginated list of assignments. */
async function listSpecialists({ userId, companyId, query }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId, { withPeople: true });
  await assertReadAccess(caller, company);

  const [assignments, total] = await Promise.all([
    repo.listAssignmentsPage(prisma, companyId, query),
    repo.countAssignments(prisma, companyId, query),
  ]);

  return {
    companyId: company.id,
    specialists: assignments.map(dto.toAssignment),
    pagination: {
      total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + assignments.length < total,
      sort: query.sort,
      order: query.order,
    },
  };
}

/** DELETE /companies/:companyId/specialists/:assignmentId — soft-remove one. */
async function removeSpecialist({ userId, requestId, companyId, assignmentId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  // Unstaffing is a staffing decision like any other: the company's accounting
  // manager makes it. An owner who could remove a specialist could unstaff their
  // own audit.
  assertCompanyAccountingManager(caller, company);

  const assignment = await repo.findAssignmentInCompany(prisma, { companyId, assignmentId });
  if (!assignment) {
    throw new ApiError(404, 'Assignment not found.', { code: 'ASSIGNMENT_NOT_FOUND' });
  }

  // Idempotent: removing an already-removed assignment just returns it.
  if (assignment.assignmentStatus === 'INACTIVE') {
    return { assignment: dto.toAssignment(assignment), alreadyRemoved: true };
  }

  const updated = await repo.deactivateAssignment(prisma, assignmentId, new Date());
  logEvent({
    event: 'company.specialist.removed',
    status: 'success',
    requestId,
    userId,
    companyId,
    specialistUserId: updated.specialistUserId,
    specializationCode: updated.specialization?.specializationCode,
    assignmentId,
  });

  await publishTeamChange(companyId);

  return { assignment: dto.toAssignment(updated), alreadyRemoved: false };
}

module.exports = {
  onboardCompany,
  listCompanies,
  getCompany,
  updateCompany,
  deleteCompany,
  listUsers,
  listCompanyAccounts,
  listAccountingManagers,
  // NOT `listSpecialists` — that name is taken by the per-company assignment
  // list below. This one is the cross-company directory.
  listSpecialistDirectory,
  getSpecialistDetail,
  listCustomerDirectory,
  getCustomerDetail,
  listOwnedCompanies,
  listTeammates,
  listManagedCompanies,
  getSpecialistOptions,
  setCompanySpecialists,
  assignAccountingManager,
  removeAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
  // exported for unit testing
  _internals: {
    hasOwnerRole,
    hasAccountingManagerRole,
    hasSpecialistRole,
    loadActiveServices,
    isAdmin,
    fingerprint,
    assertCompanyEmailAvailable,
    isCompanyEmailConflict,
  },
};
