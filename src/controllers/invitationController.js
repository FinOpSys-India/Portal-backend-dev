'use strict';

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const asyncHandler = require('../middlewares/asyncHandler');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { sendInvitationEmail } = require('../services/emailService');

const INVITATION_TTL_DAYS = 30;

// Deliberately permissive: real validation is the confirmation email landing.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors the column widths in schema.prisma, so oversized input is a 400 here
 *  rather than an opaque write error from Postgres. */
const MAX_LENGTH = { email: 255, firstName: 100, lastName: 100 };

/** Fields safe to echo back. `token` is excluded: it is the invitation secret. */
const INVITATION_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  roleId: true,
  specificRoleId: true,
  invitedById: true,
  status: true,
  expiresAt: true,
  createdAt: true,
};

function requireFields(body) {
  const missing = ['email', 'firstName', 'lastName', 'roleId', 'invitedBy'].filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === ''
  );
  if (missing.length) {
    throw new ApiError(400, 'Required fields are missing.', { details: { missing } });
  }
}

function toId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ApiError(400, `${field} must be a positive integer.`);
  }
  return id;
}

function toName(value, field) {
  const name = String(value).trim();
  if (!name) {
    throw new ApiError(400, `${field} cannot be blank.`);
  }
  if (name.length > MAX_LENGTH[field]) {
    throw new ApiError(400, `${field} cannot exceed ${MAX_LENGTH[field]} characters.`);
  }
  return name;
}

/**
 * POST /invitations
 *
 * Creates an invitation and emails the invitee a tokenised accept link.
 *
 * Re-inviting the same address replaces the old invitation outright: the stale
 * rows are deleted and a fresh token is issued. The one exception is an
 * invitation that was already delivered and is still valid — that is a 409, so
 * a mis-click cannot spam the invitee with a second email.
 */
const createInvitation = asyncHandler(async (req, res) => {
  requireFields(req.body);

  const email = String(req.body.email).toLowerCase().trim();
  const firstName = toName(req.body.firstName, 'firstName');
  const lastName = toName(req.body.lastName, 'lastName');
  const roleId = toId(req.body.roleId, 'roleId');
  const invitedById = toId(req.body.invitedBy, 'invitedBy');
  const specificRoleId =
    req.body.specificRoleId === undefined || req.body.specificRoleId === null
      ? null
      : toId(req.body.specificRoleId, 'specificRoleId');

  if (!EMAIL_PATTERN.test(email) || email.length > MAX_LENGTH.email) {
    throw new ApiError(400, 'A valid email address is required.');
  }

  // The database enforces all of the rules below via foreign keys, but it can
  // only answer with an opaque constraint violation. Checking up front lets us
  // return something the caller can act on.
  const [inviter, role, specificRole, existingUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: invitedById },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    }),
    prisma.role.findUnique({
      where: { id: roleId },
      // The subdivisions decide whether specificRoleId is required below.
      select: { id: true, code: true, name: true, specificRoles: { select: { id: true } } },
    }),
    specificRoleId
      ? prisma.specificRole.findUnique({ where: { id: specificRoleId }, select: { id: true, roleId: true, name: true } })
      : Promise.resolve(null),
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  ]);

  if (!inviter) throw new ApiError(400, `No user exists with id ${invitedById} to invite on behalf of.`);
  if (!role) throw new ApiError(400, `No role exists with id ${roleId}.`);
  if (existingUser) throw new ApiError(409, `${email} already has an account.`);

  // Only a fully onboarded user may invite: an INVITED user has not accepted
  // their own invitation yet, and a HIBERNATED one is deactivated.
  if (inviter.status !== 'ACTIVE') {
    throw new ApiError(403, `Only an active user can send invitations (inviter is ${inviter.status}).`);
  }

  // Roles that have subdivisions require one; roles that have none must not be
  // given one. Driven by the role's own data rather than hardcoded role codes.
  const roleIsSubdivided = role.specificRoles.length > 0;

  if (roleIsSubdivided && !specificRoleId) {
    throw new ApiError(400, `Role "${role.code}" requires a specificRoleId.`);
  }
  if (!roleIsSubdivided && specificRoleId) {
    throw new ApiError(400, `Role "${role.code}" has no subdivisions, so specificRoleId must be omitted.`);
  }

  if (specificRoleId) {
    if (!specificRole) {
      throw new ApiError(400, `No specific role exists with id ${specificRoleId}.`);
    }
    // Mirrors the composite foreign key on invitations.
    if (specificRole.roleId !== roleId) {
      throw new ApiError(
        400,
        `Specific role "${specificRole.name}" does not belong to role "${role.code}".`
      );
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  /*
   * Replace-in-place, inside a transaction so a failure cannot leave the
   * address with no invitation at all. The delivered-and-still-valid check is
   * repeated in here (rather than only before the transaction) so two
   * concurrent requests cannot both decide to send.
   *
   * deleteMany covers every other case in one sweep: a PENDING row whose email
   * failed, and rows past their 30 days. Those are exactly the rows that would
   * otherwise pile up, which is why no scheduled cleanup is needed.
   */
  let invitation = await prisma.$transaction(async (tx) => {
    const delivered = await tx.invitation.findFirst({
      where: { email, status: 'SENT', expiresAt: { gt: new Date() } },
      select: { id: true, expiresAt: true },
    });
    if (delivered) {
      throw new ApiError(409, `${email} has already been sent an invitation.`, {
        details: { invitationId: delivered.id, expiresAt: delivered.expiresAt },
      });
    }

    const { count } = await tx.invitation.deleteMany({ where: { email } });
    if (count) {
      logger.info(`Replacing ${count} stale invitation(s) for ${email}.`);
    }

    // Created PENDING (the schema default) so that a mail failure below leaves
    // the row in a state that says "this one never reached the invitee".
    return tx.invitation.create({
      data: { email, firstName, lastName, roleId, specificRoleId, invitedById, token, expiresAt },
      select: INVITATION_FIELDS,
    });
  });

  // A mail failure must not fail the request: the invitation is already
  // persisted, and re-inviting the address will replace it and try again.
  let emailSent = false;
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
    emailSent = true;
  } catch (err) {
    logger.error(`Invitation ${invitation.id}: failed to email ${invitation.email}:`, err.message);
  }

  if (emailSent) {
    invitation = await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'SENT' },
      select: INVITATION_FIELDS,
    });
  }

  return res.status(201).json({
    success: true,
    message: emailSent
      ? 'Invitation created and email sent successfully.'
      : 'Invitation created, but the email could not be sent. Re-invite to try again.',
    emailSent,
    data: invitation,
  });
});

module.exports = { createInvitation };
