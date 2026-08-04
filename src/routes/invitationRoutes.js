'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { invitationLimiter } = require('../middlewares/rateLimiter');
const {
  createInvitation,
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
 *   GET    /invitations                    -> paginated list (own, or all for ADMIN)
 *   DELETE /invitations/:invitationId      -> revoke (status REVOKED, row kept)
 *   POST   /invitations/:invitationId/resend -> re-send the SAME token
 *
 * The limiter stays on the two routes that send mail. An unthrottled invitation
 * endpoint is a way to use this server to spam arbitrary inboxes and to burn the
 * SMTP provider's quota; authentication raises the bar but does not remove that.
 */
const router = express.Router();

router.use(requireAuth);

const canInvite = requireRole('ADMIN');

router.post('/', invitationLimiter, canInvite, createInvitation);
router.get('/', listInvitations);
router.delete('/:invitationId', revokeInvitation);
router.post('/:invitationId/resend', invitationLimiter, resendInvitation);

module.exports = router;
