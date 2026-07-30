'use strict';

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const { logEvent } = require('../utils/auditLog');
const repo = require('../repositories/companyRepository');
const dto = require('../dto/companyDto');

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
  return user?.role?.code === 'ACCOUNTING_MANAGER';
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
        ownerUserId: userId,
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

      // Step 10: mark onboarding complete and activate the company.
      const finalized = await repo.updateCompany(tx, created.id, {
        onboardingCompleted: true,
        status: 'ACTIVE',
      });

      // Step 11: build the response now that all ids exist.
      const body = {
        success: true,
        message: 'Company onboarding completed.',
        data: dto.toCompanyOnboardingResponse({ company: finalized, address: createdAddress }),
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

      return { companyId: finalized.id, body };
    });

    logEvent({ event: 'company.onboarding.completed', status: 'success', requestId, userId, companyId: result.companyId });
    logEvent({ event: 'transaction.committed', status: 'success', requestId, userId, companyId: result.companyId });
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

/* ----------------------- accounting manager assignment ------------------- */

/**
 * PUT /companies/:companyId/accounting-manager — set (or replace) the company's
 * single accounting manager. Requires the caller to own the company or be an
 * admin, and the target user to hold the ACCOUNTING_MANAGER role.
 */
async function assignAccountingManager({ userId, requestId, companyId, managerUserId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  assertManageAccess(caller, company);

  const manager = await repo.findUserWithRole(prisma, managerUserId);
  if (!manager) throw targetUserNotFound();
  if (!hasAccountingManagerRole(manager)) {
    throw new ApiError(422, 'The selected user is not an accounting manager.', {
      code: 'INVALID_ACCOUNTING_MANAGER_ROLE',
    });
  }

  const previous = company.accountingManagerUserId;
  const updated = await repo.updateCompany(prisma, companyId, { accountingManagerUserId: managerUserId });

  const replaced = previous && previous !== managerUserId;
  logEvent({
    event: replaced ? 'company.accounting_manager.replaced' : 'company.accounting_manager.assigned',
    status: 'success',
    requestId,
    userId,
    companyId,
    accountingManagerUserId: managerUserId,
  });

  return { company: dto.toCompany(updated) };
}

/* -------------------------- specialist assignment ------------------------ */

/**
 * POST /companies/:companyId/specialists — assign a specialist to the company for
 * one or more specializations. Requires manage access, the target to hold the
 * SPECIALIST role, and every specialization code to exist. Duplicate (already
 * active) assignments are skipped, not errored. Runs in a transaction.
 */
async function assignSpecialists({ userId, requestId, companyId, specialistUserId, specializationCodes }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  assertManageAccess(caller, company);

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

/** GET /companies/:companyId/specialists — flat list of active assignments. */
async function listSpecialists({ userId, companyId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId, { withPeople: true });
  await assertReadAccess(caller, company);

  const assignments = await repo.listActiveAssignments(prisma, companyId);
  return { company_id: company.id, specialists: assignments.map(dto.toAssignment) };
}

/** DELETE /companies/:companyId/specialists/:assignmentId — soft-remove one. */
async function removeSpecialist({ userId, requestId, companyId, assignmentId }) {
  const caller = await loadCaller(userId);
  const company = await loadCompany(companyId);
  assertManageAccess(caller, company);

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

  return { assignment: dto.toAssignment(updated), alreadyRemoved: false };
}

module.exports = {
  onboardCompany,
  assignAccountingManager,
  assignSpecialists,
  getTeam,
  listSpecialists,
  removeSpecialist,
  // exported for unit testing
  _internals: {
    hasOwnerRole,
    hasAccountingManagerRole,
    hasSpecialistRole,
    isAdmin,
    fingerprint,
    assertCompanyEmailAvailable,
    isCompanyEmailConflict,
  },
};
