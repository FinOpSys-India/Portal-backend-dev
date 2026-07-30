'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

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
  ownedCustomer: { select: { id: true, name: true, createdAt: true } },
};

/**
 * Shape a fetched user (with role, specificRole, ownedCustomer) into the
 * onboarding status returned to the frontend. `onboarding.complete` is the one
 * flag the client can gate the app on; the sub-flags let it drive which step to
 * show.
 */
function buildStatus(user) {
  const accountProvisioned = Boolean(user.ownedCustomer);
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
    customer: user.ownedCustomer
      ? { id: user.ownedCustomer.id, name: user.ownedCustomer.name }
      : null,
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
 * Pick a display name for the new customer account. A client-supplied company
 * name wins; otherwise fall back to the user's name, then the email local part,
 * so the account always has a sensible label even before the profile form.
 */
function deriveCustomerName({ companyName, user, email }) {
  if (companyName) return companyName.slice(0, 255);
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (fullName) return `${fullName}'s Account`.slice(0, 255);
  const local = String(email || '').split('@')[0] || 'New';
  return `${local}'s Account`.slice(0, 255);
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
 * Provision the authenticated user as the OWNER of a new customer account
 * (onboarding steps 2–6):
 *   - assign the default role (CUSTOMER / OWNER),
 *   - create the customer account,
 *   - link the user as its owner and member.
 *
 * All three writes run in one transaction so the user is never left half
 * provisioned. Idempotent: a user who already owns a customer gets their current
 * status back unchanged (created: false), and the unique constraint on
 * owner_user_id is the hard guard against two concurrent provisions both
 * creating an account.
 *
 * @param {{ userId: number, email: string|null, companyName: string|null }} params
 * @returns {Promise<{ status: object, created: boolean }>}
 */
async function provision({ userId, email, companyName }) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
  if (!existing) throw userNotFound();

  if (existing.ownedCustomer) {
    logger.info(
      `Onboarding: user ${userId} already provisioned (customer ${existing.ownedCustomer.id}); returning status.`
    );
    return { status: buildStatus(existing), created: false };
  }

  const { roleId, specificRoleId } = await resolveOwnerRole();
  const customerName = deriveCustomerName({ companyName, user: existing, email });

  try {
    const status = await prisma.$transaction(async (tx) => {
      // Step 3: assign the default OWNER role.
      await tx.user.update({ where: { id: userId }, data: { roleId, specificRoleId } });

      // Step 4 + 5: create the customer account owned by this user...
      const customer = await tx.customer.create({
        data: { name: customerName, ownerUserId: userId },
        select: { id: true },
      });

      // ...and make the user a member of it (the owner is also a member).
      const user = await tx.user.update({
        where: { id: userId },
        data: { customerId: customer.id },
        select: STATUS_SELECT,
      });

      return buildStatus(user);
    });

    logger.info(`Onboarding: provisioned user ${userId} as OWNER of customer "${customerName}".`);
    return { status, created: true };
  } catch (err) {
    // A racing second provision loses the unique(owner_user_id) race with P2002.
    // Re-read and hand back the winner's result rather than surfacing an error.
    if (err.code === 'P2002') {
      const after = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
      if (after?.ownedCustomer) {
        logger.info(`Onboarding: concurrent provision for user ${userId} resolved to existing customer.`);
        return { status: buildStatus(after), created: false };
      }
    }
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
