'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { invitationLimiter } = require('../middlewares/rateLimiter');
const {
  createInvitation,
  createTeammateInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
} = require('../controllers/invitationController');

/*
 * Invitations.
 *
 * EVERY route here is authenticated. This endpoint used to have no auth at all
 * while taking an `invitedBy` user id in the body, which meant anyone who could
 * reach the server could send mail from this system on behalf of any active
 * user — the invitee saw the impersonated person's name and reply-to address.
 * The inviter is now the verified token subject and cannot be supplied by the
 * caller.
 *
 * Issuing an invitation grants someone a role in the portal, so creating one is
 * restricted to ADMIN. Reading and managing are open to any authenticated user,
 * scoped in the service: an ADMIN sees everything, anyone else sees only the
 * invitations they sent.
 *
 *   POST   /invitations                    -> create + email
 *   POST   /invitations/teammates          -> invite a teammate onto the caller's
 *                                             own companies (OWNER only)
 *   GET    /invitations                    -> paginated list (own, or all for ADMIN)
 *   DELETE /invitations/:invitationId      -> revoke (status REVOKED, row kept)
 *   POST   /invitations/:invitationId/resend -> re-send the SAME token
 *
 * The teammate route is the one exception to the ADMIN-only rule on creating
 * invitations, and it is narrow by construction: it can only add a customer-side
 * teammate, only to companies the CALLER OWNS, and never another OWNER. An owner
 * populating their own account is not the same decision as granting someone a
 * role in the portal, which is why the two are separate endpoints rather than a
 * relaxed gate on the first.
 *
 * The exclusion runs both ways, and that is the point: an ADMIN cannot use the
 * teammate route (they own no company), and an OWNER cannot use POST /invitations.
 * Neither role can quietly do the other's job.
 *
 * The limiter stays on the two routes that send mail. An unthrottled invitation
 * endpoint is a way to use this server to spam arbitrary inboxes and to burn the
 * SMTP provider's quota; authentication raises the bar but does not remove that.
 */
const router = express.Router();

router.use(requireAuth);

const canInvite = requireRole('ADMIN');
// OWNER only — deliberately NOT 'ADMIN'. Populating a customer's team is the
// customer's decision, not an internal one.
//
// A coarse claim gate all the same: WHICH companies this caller may invite onto
// is decided in the service against the database, per company id. An OWNER claim
// says the caller owns something, not that they own the ids in this body.
const canInviteTeammate = requireRole('OWNER');

router.post('/', invitationLimiter, canInvite, createInvitation);
router.post('/teammates', invitationLimiter, canInviteTeammate, createTeammateInvitation);
router.get('/', listInvitations);
router.delete('/:invitationId', revokeInvitation);
router.post('/:invitationId/resend', invitationLimiter, resendInvitation);

module.exports = router;
