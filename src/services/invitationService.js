'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const { generateInvitationToken } = require('../utils/tokens');
const { sendInvitationEmail } = require('./emailService');

/**
 * Invitation lifecycle: create, list, revoke, resend.
 *
 * The inviter is ALWAYS the authenticated caller, passed in as `inviterUserId`
 * from `req.user`. It is never read from the request body — that was the shape
 * of the original bug, where an unauthenticated endpoint took an `invitedBy` id
 * and used it to address mail as that person.
 *
 * Two statuses that the enum defined but nothing ever wrote are now reachable:
 * REVOKED (an explicit revoke) and EXPIRED (the sweep below, and the lazy check
 * when an invitation is listed or redeemed). Before this, a cancelled invitation
 * could only be handled by deleting the row, which destroyed the audit trail.
 */

const INVITATION_TTL_DAYS = parseInt(process.env.INVITATION_TTL_DAYS, 10) || 30;

/** Fields safe to echo back. `token` is excluded: it is the invitation secret. */
const INVITATION_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  roleId: true,
  specificRoleId: true,
  invitedById: true,
  acceptedUserId: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  role: { select: { code: true, name: true } },
  specificRole: { select: { code: true, name: true } },
  invitedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
};

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function invitationNotFound() {
  return new ApiError(404, 'Invitation not found.', { code: 'INVITATION_NOT_FOUND' });
}

/**
 * Load the caller and confirm they may issue invitations at all.
 *
 * Only a fully onboarded, ACTIVE user may invite: an INVITED user has not
 * accepted their own invitation yet, and a HIBERNATED one is deactivated.
 */
async function loadInviter(inviterUserId) {
  const inviter = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { id: true, email: true, firstName: true, lastName: true, status: true, role: { select: { code: true } } },
  });
  if (!inviter) {
    throw new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
  }
  if (inviter.status !== 'ACTIVE') {
    throw new ApiError(403, 'Only an active user can send invitations.', {
      code: 'INVITER_NOT_ACTIVE',
    });
  }
  return inviter;
}

/**
 * Resolve and cross-check the role pair.
 *
 * Roles that have subdivisions require one; roles that have none must not be
 * given one. Driven by the role's own data rather than hardcoded role codes, so
 * adding a subdivision to a role does not require touching this file.
 */
async function resolveRolePair({ roleId, specificRoleId }) {
  const [role, specificRole] = await Promise.all([
    prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, code: true, name: true, specificRoles: { select: { id: true } } },
    }),
    specificRoleId
      ? prisma.specificRole.findUnique({
          where: { id: specificRoleId },
          select: { id: true, roleId: true, name: true, code: true },
        })
      : Promise.resolve(null),
  ]);

  if (!role) {
    throw new ApiError(400, `No role exists with id ${roleId}.`, {
      code: 'VALIDATION_ERROR',
      fields: { roleId: 'Select a valid role.' },
    });
  }

  const roleIsSubdivided = role.specificRoles.length > 0;

  if (roleIsSubdivided && !specificRoleId) {
    throw new ApiError(400, `Role "${role.code}" requires a specificRoleId.`, {
      code: 'VALIDATION_ERROR',
      fields: { specificRoleId: 'Select a specific role.' },
    });
  }
  if (!roleIsSubdivided && specificRoleId) {
    throw new ApiError(400, `Role "${role.code}" has no subdivisions, so specificRoleId must be omitted.`, {
      code: 'VALIDATION_ERROR',
      fields: { specificRoleId: 'This role has no sub-roles.' },
    });
  }
  if (specificRoleId) {
    if (!specificRole) {
      throw new ApiError(400, `No specific role exists with id ${specificRoleId}.`, {
        code: 'VALIDATION_ERROR',
        fields: { specificRoleId: 'Select a valid specific role.' },
      });
    }
    // Mirrors the composite foreign key on invitations.
    if (specificRole.roleId !== roleId) {
      throw new ApiError(400, `Specific role "${specificRole.name}" does not belong to role "${role.code}".`, {
        code: 'VALIDATION_ERROR',
        fields: { specificRoleId: 'This sub-role belongs to a different role.' },
      });
    }
  }

  return { role, specificRole };
}

/**
 * A fresh invitation token plus its expiry.
 *
 * `rawToken` goes into the email and is never stored; `tokenHash` is what the
 * row keeps and what sign-up matches against.
 */
function mintToken() {
  const { rawToken, tokenHash } = generateInvitationToken();
  return {
    rawToken,
    tokenHash,
    expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Send the invitation email and flip the row to SENT on success.
 *
 * A mail failure must not fail the request: the invitation is already persisted,
 * and it can be resent. The row stays PENDING, which is precisely the marker for
 * "this one never reached the invitee".
 */
async function deliver({ invitation, inviter, token, requestId }) {
  try {
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    await sendInvitationEmail({
      recipientEmail: invitation.email,
      recipientFirstName: invitation.firstName,
      senderEmail: inviter.email,
      senderName: `${inviter.firstName} ${inviter.lastName}`.trim(),
      invitationUrl: `${frontendUrl}/accept-invitation?token=${token}`,
      expiresAt: invitation.expiresAt,
    });
  } catch (err) {
    logger.error(`Invitation ${invitation.id}: failed to email ${invitation.email}: ${err.message}`);
    logEvent({
      event: 'invitation.email.failed',
      status: 'failure',
      requestId,
      userId: inviter.id,
      errorCode: 'INVITATION_EMAIL_FAILED',
    });
    return { emailSent: false, invitation };
  }

  const updated = await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: 'SENT' },
    select: INVITATION_FIELDS,
  });
  return { emailSent: true, invitation: updated };
}

/* -------------------------------------------------------------------------- */
/* create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create an invitation and email the invitee a tokenised accept link.
 *
 * Re-inviting the same address replaces the old invitation outright: the stale
 * rows are deleted and a fresh token is issued. The one exception is an
 * invitation that was already delivered and is still valid — that is a 409, so a
 * mis-click cannot spam the invitee with a second email. Use the explicit resend
 * endpoint for that, which reuses the SAME token rather than minting a new one.
 */
async function createInvitation({ inviterUserId, requestId, input }) {
  const inviter = await loadInviter(inviterUserId);
  const { role, specificRole } = await resolveRolePair(input);

  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: input.email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existingUser) {
    throw new ApiError(409, `${input.email} already has an account.`, {
      code: 'USER_ALREADY_EXISTS',
      fields: { email: 'This address already has an account.' },
    });
  }

  const { rawToken, tokenHash, expiresAt } = mintToken();

  /*
   * Replace-in-place, inside a transaction so a failure cannot leave the address
   * with no invitation at all. The delivered-and-still-valid check is repeated in
   * here (rather than only before the transaction) so two concurrent requests
   * cannot both decide to send.
   *
   * deleteMany covers every other case in one sweep: a PENDING row whose email
   * failed, and rows past their TTL. Those are exactly the rows that would
   * otherwise pile up, which is why no scheduled cleanup is needed for them.
   */
  const invitation = await prisma.$transaction(async (tx) => {
    const delivered = await tx.invitation.findFirst({
      where: { email: input.email, status: 'SENT', expiresAt: { gt: new Date() } },
      select: { id: true, expiresAt: true },
    });
    if (delivered) {
      throw new ApiError(409, `${input.email} has already been sent an invitation.`, {
        code: 'INVITATION_ALREADY_SENT',
        details: { invitationId: delivered.id, expiresAt: delivered.expiresAt },
      });
    }

    const { count } = await tx.invitation.deleteMany({
      where: { email: input.email, status: { in: ['PENDING', 'EXPIRED', 'REVOKED'] } },
    });
    if (count) logger.info(`Replacing ${count} stale invitation(s) for ${input.email}.`);

    // Created PENDING (the schema default) so that a mail failure below leaves
    // the row in a state that says "this one never reached the invitee".
    return tx.invitation.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        roleId: role.id,
        specificRoleId: specificRole?.id ?? null,
        invitedById: inviter.id,
        // Only the digest is persisted; rawToken goes into the email below and
        // is then unrecoverable.
        tokenHash,
        expiresAt,
      },
      select: INVITATION_FIELDS,
    });
  });

  logEvent({
    event: 'invitation.created',
    status: 'success',
    requestId,
    userId: inviter.id,
    detail: role.code,
  });

  const result = await deliver({ invitation, inviter, token: rawToken, requestId });
  return { ...result, statusCode: 201 };
}

/* -------------------------------------------------------------------------- */
/* list                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * List invitations, newest first by default.
 *
 * An ADMIN sees every invitation; anyone else sees only the ones they sent. That
 * is the narrowest rule that still makes the endpoint useful — an invitation
 * carries the invitee's name and address, so it is not something to expose
 * across tenants.
 */
async function listInvitations({ callerUserId, requestId, query }) {
  const caller = await loadInviter(callerUserId);
  const isAdmin = caller.role?.code === 'ADMIN';

  const where = {
    ...(isAdmin ? {} : { invitedById: caller.id }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' } },
            { firstName: { contains: query.search, mode: 'insensitive' } },
            { lastName: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.invitation.findMany({
      where,
      select: INVITATION_FIELDS,
      orderBy: { [query.sort]: query.order },
      take: query.limit,
      skip: query.offset,
    }),
    prisma.invitation.count({ where }),
  ]);

  logEvent({
    event: 'invitation.list.read',
    status: 'success',
    requestId,
    userId: caller.id,
    detail: `${rows.length}/${total}`,
  });

  return { rows, total };
}

/* -------------------------------------------------------------------------- */
/* revoke                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Revoke an invitation.
 *
 * A soft state change, not a delete: the row keeps who invited whom and when,
 * which is the whole point of having an audit trail. `REVOKED` is terminal — the
 * sign-up flow already refuses it with a 410 — so a link already in an inbox
 * stops working immediately.
 *
 * Idempotent: revoking an already-revoked invitation returns it rather than
 * erroring, because the caller's intent is satisfied either way.
 */
async function revokeInvitation({ callerUserId, requestId, invitationId }) {
  const caller = await loadInviter(callerUserId);
  const isAdmin = caller.role?.code === 'ADMIN';

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: { ...INVITATION_FIELDS, invitedById: true },
  });
  if (!invitation) throw invitationNotFound();

  if (!isAdmin && invitation.invitedById !== caller.id) {
    // Same response as "does not exist": telling a caller that an invitation
    // they may not touch nevertheless exists is an enumeration oracle.
    throw invitationNotFound();
  }

  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(409, 'This invitation has already been accepted and cannot be revoked.', {
      code: 'INVITATION_ALREADY_ACCEPTED',
    });
  }

  if (invitation.status === 'REVOKED') {
    return { invitation, alreadyRevoked: true };
  }

  const updated = await prisma.invitation.update({
    where: { id: invitationId },
    data: { status: 'REVOKED' },
    select: INVITATION_FIELDS,
  });

  logEvent({
    event: 'invitation.revoked',
    status: 'success',
    requestId,
    userId: caller.id,
  });

  return { invitation: updated, alreadyRevoked: false };
}

/* -------------------------------------------------------------------------- */
/* resend                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resend an existing invitation.
 *
 * Mints a FRESH token and supersedes the previous one, then extends the expiry.
 *
 * It used to re-send the same token so an older email kept working. That is no
 * longer possible, and the reason is the point of hashing: only the digest is
 * stored, so the server genuinely cannot reproduce the raw value it sent. The
 * alternative — keeping the raw token so it could be re-sent — is exactly the
 * weakness this replaced.
 *
 * It is also the better behaviour on its own merits, and matches how password
 * resets already work. A link that was emailed once may have been forwarded,
 * logged by a mail gateway, or left sitting in an inbox; superseding it on every
 * resend bounds how long any one copy stays usable. The invitee should always
 * use the most recent email.
 *
 * What resend still gives you over re-creating the invitation: the row keeps its
 * id, its audit trail of who invited whom and when, and its original details, so
 * nothing has to be re-entered.
 */
async function resendInvitation({ callerUserId, requestId, invitationId }) {
  const caller = await loadInviter(callerUserId);
  const isAdmin = caller.role?.code === 'ADMIN';

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: { ...INVITATION_FIELDS, invitedById: true },
  });
  if (!invitation) throw invitationNotFound();
  if (!isAdmin && invitation.invitedById !== caller.id) throw invitationNotFound();

  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(409, 'This invitation has already been used.', {
      code: 'INVITATION_ALREADY_ACCEPTED',
    });
  }
  if (invitation.status === 'REVOKED') {
    throw new ApiError(409, 'This invitation has been revoked. Create a new one instead.', {
      code: 'INVITATION_REVOKED',
    });
  }

  const { rawToken, tokenHash, expiresAt } = mintToken();

  /*
   * Reset to PENDING alongside the new token. The status tracks whether the
   * CURRENT token was delivered, so leaving it SENT while a fresh, undelivered
   * token sits in the row would misreport exactly the situation this endpoint
   * exists to fix. `deliver` moves it back to SENT once the mail goes out.
   */
  const refreshed = await prisma.invitation.update({
    where: { id: invitationId },
    data: { tokenHash, expiresAt, status: 'PENDING' },
    select: INVITATION_FIELDS,
  });

  const result = await deliver({
    invitation: refreshed,
    inviter: invitation.invitedById === caller.id ? caller : await loadInviter(invitation.invitedById),
    token: rawToken,
    requestId,
  });

  logEvent({
    event: 'invitation.resent',
    status: result.emailSent ? 'success' : 'failure',
    requestId,
    userId: caller.id,
    detail: 'token_rotated',
  });

  return result;
}

/**
 * Mark every past-its-date invitation EXPIRED.
 *
 * The sign-up flow already refuses an out-of-date invitation by comparing
 * `expiresAt`, so this changes no access decision. What it changes is that the
 * status column stops lying: a listing screen could previously show a
 * three-month-old invitation as "SENT" indefinitely, because nothing ever moved
 * it on. Safe to run repeatedly.
 */
async function expireStaleInvitations() {
  const { count } = await prisma.invitation.updateMany({
    where: { status: { in: ['PENDING', 'SENT'] }, expiresAt: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
  if (count) logger.info(`Marked ${count} invitation(s) EXPIRED.`);
  return count;
}

module.exports = {
  createInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
  expireStaleInvitations,
  INVITATION_FIELDS,
  INVITATION_TTL_DAYS,
};
