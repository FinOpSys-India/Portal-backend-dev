'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { signAccessToken } = require('../utils/tokens');

/**
 * Post-signup onboarding.
 *
 * The user has already authenticated (they hold a valid access token) and their
 * `users` row already exists from sign-up, so onboarding here PROVISIONS that
 * user rather than creating them from scratch: it assigns the default owner
 * role, creates the customer account, links the two, and later accepts the
 * profile form. Every entry point takes the user id from the verified token —
 * never from the request body.
 *
 * "OWNER" is modelled with the existing role hierarchy, not a new top-level
 * role: the seed already defines the SpecificRole `OWNER` under the top-level
 * `CUSTOMER` role, and that pairing is exactly "the owner of a customer
 * account". Assigning it keeps the composite-FK guarantee (specificRole belongs
 * to role) intact.
 */

const OWNER_ROLE_CODE = 'CUSTOMER'; // top-level Role
const OWNER_SPECIFIC_ROLE_CODE = 'OWNER'; // SpecificRole under CUSTOMER

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
};

/**
 * Shape a fetched user (with role and specificRole) into the onboarding status
 * returned to the frontend. `onboarding.complete` is the one flag the client can
 * gate the app on; the sub-flags let it drive which step to show.
 */
function buildStatus(user) {
  // Provisioned == holds the owner role pair. There is no separate account row
  // to look for: a company is owned by its user directly.
  const accountProvisioned =
    user.role?.code === OWNER_ROLE_CODE && user.specificRole?.code === OWNER_SPECIFIC_ROLE_CODE;
  const profileComplete = Boolean(user.firstName && user.lastName && user.phone && user.jobTitle);
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
      accountProvisioned,
      profileComplete,
      complete: accountProvisioned && profileComplete,
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
 * @param {{ userId: number, profile: { firstName: string, lastName: string, phone: string, jobTitle: string } }} params
 */
async function submitProfile({ userId, profile }) {
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
    return buildStatus(user);
  } catch (err) {
    // update on a missing row throws P2025 — the token's subject is gone.
    if (err.code === 'P2025') throw userNotFound();
    throw err;
  }
}

module.exports = { getStatus, provision, submitProfile };
