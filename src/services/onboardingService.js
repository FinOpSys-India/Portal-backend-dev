'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { signAccessToken } = require('../utils/tokens');
const adminEvents = require('./adminEventService');

/**
 * Post-signup onboarding.
 *
 * The user has already authenticated (they hold a valid access token) and their
 * `users` row already exists from sign-up, so onboarding here finishes off that
 * user rather than creating them from scratch: it accepts the profile form and
 * reports how far through the flow they are. Every entry point takes the user id
 * from the verified token — never from the request body.
 *
 * The `customers` table this once created is gone (db/schema/13_drop_customers);
 * a company belongs directly to its owner, so there is no account row to make.
 *
 * "OWNER" is modelled with the existing role hierarchy, not a new top-level
 * role: the seed already defines the SpecificRole `OWNER` under the top-level
 * `CUSTOMER` role, and that pairing is exactly "the owner of a customer
 * account". Assigning it keeps the composite-FK guarantee (specificRole belongs
 * to role) intact.
 */

const OWNER_ROLE_CODE = 'CUSTOMER'; // top-level Role
const OWNER_SPECIFIC_ROLE_CODE = 'OWNER'; // SpecificRole under CUSTOMER

/*
 * The one subscription state that counts as paid for onboarding purposes.
 *
 * Deliberately just ACTIVE. INCOMPLETE is a checkout that was started and never
 * finished, which is precisely the state the payment step exists to move them
 * out of. PAST_DUE, UNPAID and CANCELED all describe a subscription that once
 * worked and has since lapsed — a billing problem for an established account to
 * resolve, not an onboarding step to repeat, but also not something to call paid.
 */
const PAID_SUBSCRIPTION_STATUS = 'ACTIVE';

/** Columns needed to build an onboarding-status view of a user. */
const STATUS_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  jobTitle: true,
  status: true,
  role: { select: { code: true } },
  specificRole: { select: { code: true } },
  /*
   * The owner's last two steps, answered by one relation rather than two extra
   * queries, so the status cannot report a user, their companies and their
   * billing from three different moments.
   *
   * Soft-deleted companies are excluded: an owner whose only company was deleted
   * has the company step to do again. `take: 1` on the subscriptions makes this
   * an existence check — nothing here needs the row, only whether one is there.
   */
  ownedCompanies: {
    where: { deletedAt: null },
    select: {
      id: true,
      subscriptions: {
        where: { status: PAID_SUBSCRIPTION_STATUS },
        select: { id: true },
        take: 1,
      },
    },
  },
};

/**
 * Shape a fetched user (with role and specificRole) into the onboarding status
 * returned to the frontend. `onboarding.complete` is the one flag the client can
 * gate the app on; the sub-flags let it drive which step to show.
 *
 * WHAT THE FLAGS MEAN, and why they differ by role:
 *
 * Sign-up is invitation-only (authService.signup requires an invitationToken),
 * so every user arrives already holding the role their invitation named. That
 * makes the onboarding path depend on who they are:
 *
 *   owner (CUSTOMER/OWNER) — invited to run an account. Three steps: fill in the
 *     profile, create the first company, and pay for it. All three, because
 *     everything an owner sees hangs off a company and every company hangs off a
 *     subscription — an unpaid company is a shell with no services attached.
 *   everyone else (CUSTOMER/TEAM, SPECIALIST/*, ACCOUNTING_MANAGER, ADMIN) —
 *     joins an account that already exists, paid for by whoever owns it. They
 *     have no company to create and no bill to settle; the profile is their only
 *     step.
 *
 * So `companyCreated` and `paymentComplete` are reported for everyone (they are
 * facts, and false is truthful for a teammate) but only GATE the owner. Folding
 * them into `complete` unconditionally would strand every non-owner outside the
 * portal forever, since they have no endpoint that would ever make them true.
 */
function buildStatus(user) {
  const isOwner =
    user.role?.code === OWNER_ROLE_CODE && user.specificRole?.code === OWNER_SPECIFIC_ROLE_CODE;
  const profileComplete = Boolean(user.firstName && user.lastName && user.phone && user.jobTitle);

  const companies = user.ownedCompanies ?? [];
  const companyCreated = companies.length > 0;
  /*
   * EVERY owned company must be paid up, not merely one of them.
   *
   * `some` was the earlier rule and it left a hole big enough to drive the whole
   * billing model through: once the first company was paid for, an owner could
   * go on creating companies that were never billed while the portal went on
   * reporting onboarding complete — so nothing ever routed them back to service
   * selection. An unpaid company is a shell with no services attached, and a
   * flag that calls the account finished is simply wrong about it.
   *
   * `companyCreated &&` is not redundant. `every` on an empty array is true, so
   * without it a user who has created no company at all — every teammate, and
   * an owner who has just signed up — would be reported as fully paid. That flag
   * is read on its own to decide which step to show, so it has to be truthful by
   * itself and not merely in combination with the one above it.
   */
  const paymentComplete = companyCreated && companies.every((c) => c.subscriptions.length > 0);

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      jobTitle: user.jobTitle,
      role: user.role?.code ?? null,
      specificRole: user.specificRole?.code ?? null,
      status: user.status,
    },
    onboarding: {
      isOwner,
      profileComplete,
      companyCreated,
      paymentComplete,
      complete: isOwner
        ? profileComplete && companyCreated && paymentComplete
        : profileComplete,
      /*
       * Retained for clients still reading the old field name. It always meant
       * "holds the owner role pair", which is now `isOwner`; it was never a step
       * anyone could complete, since the role arrives with the invitation.
       * @deprecated read `isOwner`.
       */
      accountProvisioned: isOwner,
    },
  };
}

/** The token authenticated but its subject is gone from the database. */
function userNotFound() {
  return new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
}

/**
 * Resolve the numeric role ids for the default owner assignment from their
 * stable codes, so the seed can renumber without this breaking. A missing role
 * is a server-side misconfiguration (seed not run), not a client error.
 */
async function resolveOwnerRole() {
  const role = await prisma.role.findUnique({
    where: { code: OWNER_ROLE_CODE },
    select: { id: true },
  });
  if (!role) {
    throw new ApiError(500, 'Onboarding is not configured (missing customer role).', {
      code: 'ROLE_NOT_CONFIGURED',
    });
  }
  const specificRole = await prisma.specificRole.findUnique({
    where: { roleId_code: { roleId: role.id, code: OWNER_SPECIFIC_ROLE_CODE } },
    select: { id: true },
  });
  if (!specificRole) {
    throw new ApiError(500, 'Onboarding is not configured (missing owner role).', {
      code: 'ROLE_NOT_CONFIGURED',
    });
  }
  return { roleId: role.id, specificRoleId: specificRole.id };
}

/**
 * Return the caller's current onboarding status. Read-only.
 *
 * @param {number} userId  From the verified access token.
 */
async function getStatus(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
  if (!user) throw userNotFound();
  return buildStatus(user);
}

/**
 * Provision the authenticated user as an OWNER: assign the default role pair
 * (CUSTOMER / OWNER), which is what gates POST /onboarding/company.
 *
 * There is no separate account row to create — a company belongs directly to the
 * user who owns it — so this is now a single role write. Idempotent: a user who
 * already holds the owner pair gets their current status back unchanged
 * (created: false).
 *
 * ONLY a user holding NO role can be promoted here. Sign-up is invitation-only
 * (authService.signup requires an invitationToken and copies the invitation's
 * role onto the new user), so in practice everyone already has one and this
 * endpoint is a no-op for owners and a 403 for everyone else. That is
 * deliberate: without the check, the route's sole remaining effect was to let
 * ANY authenticated user — a teammate, a specialist, an accounting manager —
 * make themselves the owner of a customer account and collect a fresh token
 * carrying the claim, since the route is guarded by requireAuth alone. The role
 * a user holds is decided by whoever invited them, and it is not theirs to
 * change by calling an endpoint.
 *
 * @param {{ userId: number }} params
 * @returns {Promise<{ status: object, created: boolean, accessToken: string|null }>}
 */
async function provision({ userId }) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
  if (!existing) throw userNotFound();

  // What the caller's token currently claims, so we can tell below whether this
  // call actually changed their role and a replacement token is warranted.
  const previousRole = existing.role?.code ?? null;
  const previousSpecificRole = existing.specificRole?.code ?? null;

  if (previousRole === OWNER_ROLE_CODE && previousSpecificRole === OWNER_SPECIFIC_ROLE_CODE) {
    logger.info(`Onboarding: user ${userId} already holds the owner role; returning status.`);
    return { status: buildStatus(existing), created: false, accessToken: null };
  }

  /*
   * Some other role is already assigned. Refuse rather than overwrite: this is a
   * privilege escalation attempt if the caller meant it, and a client bug if
   * they did not, and both deserve to be told rather than silently granted.
   * Logged at warn because a legitimate client has no reason to send this.
   */
  if (previousRole !== null) {
    logger.warn(
      `Onboarding: refused to promote user ${userId} (${previousRole}/${previousSpecificRole ?? '—'}) to owner.`
    );
    throw new ApiError(403, 'Your account role is already set and cannot be changed here.', {
      code: 'ROLE_ALREADY_ASSIGNED',
    });
  }

  const { roleId, specificRoleId } = await resolveOwnerRole();

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { roleId, specificRoleId },
      select: STATUS_SELECT,
    });
    const status = buildStatus(user);

    logger.info(`Onboarding: provisioned user ${userId} as OWNER.`);

    /*
     * A role change is exactly the transition the admin manager picker cares
     * about: whoever this user was a moment ago, they are a CUSTOMER/OWNER now
     * and are therefore no longer assignable as an accounting manager. Announced
     * after the write has committed, so an open admin screen drops the option
     * instead of offering someone the backend would now refuse.
     */
    adminEvents.userChanged(user);

    /*
     * Hand back a REPLACEMENT access token whenever this call changed the role.
     *
     * The caller's existing token was signed before the promotion, so it still
     * claims their pre-onboarding role. The very next step of the flow —
     * POST /onboarding/company — is gated on the OWNER claim, so without this the
     * user was told they had been made an owner and then refused for not being
     * one. (requireRole now also re-checks the database, so the old token would
     * no longer be turned away; this simply means the client stops carrying a
     * token it knows to be wrong.)
     */
    const roleChanged =
      status.user.role !== previousRole || status.user.specificRole !== previousSpecificRole;

    return {
      status,
      created: true,
      accessToken: roleChanged
        ? signAccessToken({
            userId,
            email: status.user.email,
            role: status.user.role,
            specificRole: status.user.specificRole,
          })
        : null,
    };
  } catch (err) {
    // update on a missing row throws P2025 — the token's subject is gone. A
    // concurrent second provision is harmless now: both write the same role pair.
    if (err.code === 'P2025') throw userNotFound();
    throw err;
  }
}

/**
 * Submit the onboarding form (step 7): first name, last name, phone, job title.
 * Identity comes from the token; the body carries profile data only.
 *
 * FIRST TIME ONLY, AND FOR OWNERS ONLY. Once an owner's four fields are set the
 * endpoint is closed to them for good, because it is the only route that can
 * write a name or a job title and leaving it open made those fields editable for
 * the life of the account — which is exactly what `PATCH /users/me` deliberately
 * refuses to allow (it accepts phone and address, nothing else). An open
 * onboarding route was therefore a way round that rule rather than a separate
 * feature.
 *
 * The lock is deliberately NOT extended to anyone else. An owner is the account
 * holder, and their name is what appears against a company on every internal
 * screen — pinning it at sign-up is the point. A teammate, specialist,
 * accounting manager or admin is a person working in the portal, and freezing a
 * colleague's own name and job title on the strength of one form submission is a
 * customer-account rule applied where no customer account is involved.
 *
 * The guard asks `buildStatus` rather than re-deriving "is it filled in?" or
 * re-checking the role pair by hand, so the condition that closes this endpoint
 * and the `isOwner`/`profileComplete` flags the client reads from GET /onboarding
 * cannot drift apart.
 *
 * The cost is that an OWNER whose name was typed wrongly at sign-up needs an
 * administrator to correct it. That is the intended trade: an owner's name is
 * set once, on purpose.
 *
 * @param {{ userId: number, profile: { firstName: string, lastName: string, phone: string, jobTitle: string } }} params
 */
async function submitProfile({ userId, profile }) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
  if (!existing) throw userNotFound();

  const { isOwner, profileComplete } = buildStatus(existing).onboarding;
  if (isOwner && profileComplete) {
    throw new ApiError(409, 'Your profile has already been submitted.', {
      code: 'PROFILE_ALREADY_SUBMITTED',
    });
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        jobTitle: profile.jobTitle,
      },
      select: STATUS_SELECT,
    });
    logger.info(`Onboarding: profile submitted for user ${userId}.`);

    // The name shown next to every company this user manages just changed.
    adminEvents.userChanged(user);

    return buildStatus(user);
  } catch (err) {
    // update on a missing row throws P2025 — the token's subject is gone.
    if (err.code === 'P2025') throw userNotFound();
    throw err;
  }
}

module.exports = { getStatus, provision, submitProfile };
