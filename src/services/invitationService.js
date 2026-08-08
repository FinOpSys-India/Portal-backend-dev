'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const { generateInvitationToken } = require('../utils/tokens');
const { sendInvitationEmail } = require('./emailService');
const companyRepo = require('../repositories/companyRepository');

/**
 * The customer-side role codes this file needs by NAME rather than by id.
 *
 * Only two, and both only ever used to REFUSE something — never to decide what
 * an invitation grants, which always comes from the ids the client sends and is
 * resolved against the `roles` table in resolveRolePair.
 */
const CUSTOMER_ROLE_CODE = 'CUSTOMER';
const OWNER_SPECIFIC_ROLE_CODE = 'OWNER';

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

/**
 * The teammate-invitation shape: the fields above PLUS the two the teammate form
 * collects and nothing else does.
 *
 * Kept separate rather than folded into INVITATION_FIELDS so the existing
 * invitation endpoints keep exactly the response they have always had. A staff
 * invitation has no job title and targets no company, so returning
 * `"jobTitle": null, "companies": []` on every one of them would be two fields
 * that are permanently empty — noise that a client then has to learn to ignore.
 *
 * `companies` is named, not just id'd, so the screen can print "Acme Ltd, Beta
 * Inc" without a second round trip.
 */
const TEAMMATE_INVITATION_FIELDS = {
  ...INVITATION_FIELDS,
  jobTitle: true,
  companies: {
    select: { company: { select: { id: true, companyName: true, status: true } } },
    orderBy: { company: { companyName: 'asc' } },
  },
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
async function deliver({ invitation, inviter, token, requestId, fields = INVITATION_FIELDS }) {
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
    select: fields,
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
async function createInvitation({ inviterUserId, requestId, input, fields = INVITATION_FIELDS }) {
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
        jobTitle: input.jobTitle ?? null,
        roleId: role.id,
        specificRoleId: specificRole?.id ?? null,
        invitedById: inviter.id,
        // Only the digest is persisted; rawToken goes into the email below and
        // is then unrecoverable.
        tokenHash,
        expiresAt,
        // Written in the SAME statement as the invitation, so an invitation can
        // never exist with its target companies missing. The ids were checked
        // against the caller's ownership before the transaction opened.
        ...(input.companyIds?.length
          ? { companies: { create: input.companyIds.map((companyId) => ({ companyId })) } }
          : {}),
      },
      select: fields,
    });
  });

  logEvent({
    event: 'invitation.created',
    status: 'success',
    requestId,
    userId: inviter.id,
    detail: role.code,
  });

  const result = await deliver({ invitation, inviter, token: rawToken, requestId, fields });
  return { ...result, statusCode: 201 };
}

/* -------------------------------------------------------------------------- */
/* create — teammate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `companyIds` to the ones the caller may actually invite onto, or throw
 * naming the ones they may not.
 *
 * OWNERSHIP, with no exception — not even for an ADMIN. Adding people to a
 * customer's account is the customer's decision, not an internal one, and the
 * portal already splits authority that way elsewhere: an admin appoints the
 * accounting manager, the manager staffs the specialists, the owner runs their
 * own team. An admin who could invite teammates would be creating customer-side
 * users on an account nobody asked them to touch.
 *
 * This runs BEFORE the invitation is created rather than as a filter afterwards.
 * An invitation that quietly covered fewer companies than the form submitted
 * would be worse than a rejection, because nothing would tell the owner.
 *
 * A soft-deleted or ARCHIVED company is reported the same way as one the caller
 * does not own. Not an oversight: to someone who does not own it, "archived" and
 * "not yours" must be indistinguishable, or the error becomes a way to probe
 * which company ids exist.
 */
async function resolveInvitableCompanies({ caller, companyIds }) {
  const allowed = await companyRepo.listOwnedCompanyIds(prisma, {
    ownerUserId: caller.id,
    companyIds,
  });

  const allowedSet = new Set(allowed);
  const rejected = companyIds.filter((id) => !allowedSet.has(id));

  if (rejected.length) {
    throw new ApiError(403, `You cannot invite anyone to ${rejected.length === 1 ? 'this company' : 'these companies'}.`, {
      code: 'COMPANY_ACCESS_DENIED',
      fields: { companyIds: 'Select companies you own.' },
      details: { rejectedCompanyIds: rejected },
    });
  }

  // Returned in the caller's order rather than the database's, so the response
  // lists the companies in the order the form submitted them.
  return companyIds;
}

/**
 * Invite a teammate onto one or more of the caller's OWN companies.
 *
 * The difference from `createInvitation` is entirely about scope, not mechanism:
 * the token, the replace-in-place rules, the email and the audit trail are the
 * same code below. What this adds is
 *
 *   - the companies must be the caller's own — see resolveInvitableCompanies,
 *   - the role pair is constrained to a customer-side, non-owner role, and
 *   - a job title is carried on the invitation.
 *
 * On the role pair: the ids come from the client, as they do everywhere else,
 * but two things are enforced here that the generic endpoint does not. The role
 * must be CUSTOMER — this form adds people to a customer account, not staff to
 * the portal — and the specific role must NOT be OWNER. Without that second
 * check, an owner could use their own invite form to mint another OWNER, which
 * is a privilege escalation dressed as a teammate: ownership carries write
 * access to the company and the right to invite further people.
 *
 * Note there is no admin path. An ADMIN reaching this endpoint owns no company
 * and so can invite onto none — the ownership check refuses them by the same
 * rule that refuses one owner reaching into another's account, rather than by a
 * separate role test that could drift away from it.
 */
async function createTeammateInvitation({ inviterUserId, requestId, input }) {
  const caller = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { id: true, status: true },
  });
  if (!caller) {
    throw new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
  }

  const companyIds = await resolveInvitableCompanies({ caller, companyIds: input.companyIds });

  const { role, specificRole } = await resolveRolePair(input);

  if (role.code !== CUSTOMER_ROLE_CODE) {
    throw new ApiError(400, 'A teammate must be invited with the customer role.', {
      code: 'VALIDATION_ERROR',
      fields: { roleId: 'Select the customer role.' },
    });
  }
  if (specificRole?.code === OWNER_SPECIFIC_ROLE_CODE) {
    throw new ApiError(403, 'An owner cannot be added through the teammate form.', {
      code: 'SPECIFIC_ROLE_NOT_ALLOWED',
      fields: { specificRoleId: 'Select a teammate role.' },
    });
  }

  // Everything above is a precondition; the invitation itself, its token, its
  // email and its audit entry are the shared path. `createInvitation` re-resolves
  // the role pair — cheap, and it keeps that function correct on its own terms
  // rather than depending on a caller having done it first.
  return createInvitation({
    inviterUserId,
    requestId,
    input: { ...input, companyIds },
    // The only place the wider shape is used: a teammate invitation is the only
    // one that HAS a job title and companies to report.
    fields: TEAMMATE_INVITATION_FIELDS,
  });
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
  createTeammateInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
  expireStaleInvitations,
  INVITATION_FIELDS,
  INVITATION_TTL_DAYS,
};
