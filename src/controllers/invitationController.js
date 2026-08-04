'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const {
  validateCreateInvitation,
  validateInvitationListQuery,
} = require('../validators/invitationValidator');
const { parseId } = require('../validators/common');
const invitationService = require('../services/invitationService');
const dto = require('../dto/invitationDto');

/**
 * HTTP layer for the invitation flows. Thin by design: read the caller identity
 * from req.user (set by requireAuth — NEVER from the body), validate, delegate,
 * shape the response.
 */

/**
 * POST /invitations
 *
 * Creates an invitation and emails the invitee a tokenised accept link. The
 * inviter is the authenticated caller.
 */
const createInvitation = asyncHandler(async (req, res) => {
  const input = validateCreateInvitation(req.body);

  const { invitation, emailSent, statusCode } = await invitationService.createInvitation({
    inviterUserId: req.user.id,
    requestId: req.id,
    input,
  });

  return res.status(statusCode).json({
    success: true,
    message: emailSent
      ? 'Invitation created and email sent successfully.'
      : 'Invitation created, but the email could not be sent. Use resend to try again.',
    // `emailSent` lives INSIDE data now. It used to sit at the top level beside
    // `success`, so any client modelling the envelope as {success, message, data}
    // dropped it — and it is the only way to tell that a 201 did not actually
    // reach the invitee.
    data: { invitation: dto.toInvitation(invitation), emailSent },
  });
});

/**
 * GET /invitations
 *
 * Paginated list. An ADMIN sees every invitation; anyone else sees only their own.
 */
const listInvitations = asyncHandler(async (req, res) => {
  const query = validateInvitationListQuery(req.query);

  const { rows, total } = await invitationService.listInvitations({
    callerUserId: req.user.id,
    requestId: req.id,
    query,
  });

  return res.status(200).json({
    success: true,
    message: 'Invitations retrieved.',
    data: dto.toInvitationList({ rows, total, ...query }),
  });
});

/**
 * DELETE /invitations/:invitationId
 *
 * Revoke an invitation. A state change, not a delete — the audit trail survives.
 */
const revokeInvitation = asyncHandler(async (req, res) => {
  const invitationId = parseId(req.params.invitationId, 'invitationId');

  const { invitation, alreadyRevoked } = await invitationService.revokeInvitation({
    callerUserId: req.user.id,
    requestId: req.id,
    invitationId,
  });

  return res.status(200).json({
    success: true,
    message: alreadyRevoked ? 'Invitation was already revoked.' : 'Invitation revoked.',
    data: { invitation: dto.toInvitation(invitation) },
  });
});

/**
 * POST /invitations/:invitationId/resend
 *
 * Re-send the same invitation, reusing its token and extending its expiry, so a
 * link already in the invitee's inbox keeps working.
 */
const resendInvitation = asyncHandler(async (req, res) => {
  const invitationId = parseId(req.params.invitationId, 'invitationId');

  const { invitation, emailSent } = await invitationService.resendInvitation({
    callerUserId: req.user.id,
    requestId: req.id,
    invitationId,
  });

  return res.status(200).json({
    success: true,
    message: emailSent
      ? 'Invitation email resent.'
      : 'The invitation email could not be sent. Please try again.',
    data: { invitation: dto.toInvitation(invitation), emailSent },
  });
});

module.exports = { createInvitation, listInvitations, revokeInvitation, resendInvitation };
