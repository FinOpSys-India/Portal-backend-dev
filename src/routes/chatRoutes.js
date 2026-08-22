'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { chatLimiter, documentLimiter } = require('../middlewares/rateLimiter');
const {
  listCustomerContacts,
  listSpecialistContacts,
  listConversations,
  openConversation,
  listMessages,
  sendMessage,
  markRead,
  deleteMessage,
  unreadCount,
  requestUploadUrls,
  requestDownloadUrl,
  issueRealtimeToken,
} = require('../controllers/chatController');

/*
 * Company-scoped chat between an accounting manager and the people on that
 * company's account.
 *
 *   GET    /chat/contacts/customers?companyId=      the manager's section one
 *   GET    /chat/contacts/specialists?companyId=    the manager's section two
 *   GET    /chat/conversations?companyId=           my threads on that company
 *   POST   /chat/conversations                      open one, or reuse it
 *   GET    /chat/conversations/:id/messages         one page of a thread
 *   POST   /chat/conversations/:id/messages         say something
 *   POST   /chat/conversations/:id/read             clear the badge
 *   DELETE /chat/messages/:id                       remove one of your own
 *   GET    /chat/unread-count?companyId=            the nav badge
 *   POST   /chat/attachments/upload-url             where to send the files
 *   GET    /chat/attachments/:id/download-url       a short-lived signed link
 *   GET    /chat/realtime-token                     open the live connection
 *
 * THREE PORTALS, TWELVE ROUTES, AND THE DIFFERENCE IS TWO OF THEM. The
 * accounting manager gets all twelve; a customer and a specialist get ten — they
 * never call the two `contacts` lists, because they have nobody to choose
 * between. Their counterpart is the company's assigned accounting manager, and
 * `POST /chat/conversations` resolves it from `companyId` alone.
 *
 * An ADMIN gets NOTHING here, and not by a role gate: an admin is never one of a
 * thread's two sides, and being a side is the whole authorization (see
 * chatService.assertParticipant). It is the same position projectService takes —
 * a client's working material follows from being ON the account, not from
 * administering the platform — and a private conversation is the clearest case
 * of it.
 *
 * SCOPE, NOT ROLE GATES, on everything except the two contact lists. Any
 * authenticated caller may ask, and the service decides against the database
 * whether they may reach THAT company and THAT thread. A coarse role check could
 * only tell that the caller holds a role somewhere, which is not the question.
 *
 * `companyId` is REQUIRED wherever a company is named, with no admin exemption:
 * a chat list merged across companies would put two clients' conversations on
 * one screen.
 */
const router = express.Router();

router.use(requireAuth);

/*
 * THE ONE ROLE GATE ON THIS FEATURE, and it is on the two lists that answer "who
 * could I start a chat with". Only an accounting manager has that choice to
 * make; for everyone else the answer is a single person the server already
 * knows, so offering them a roster of the company's staff would be a directory
 * with no use behind it.
 *
 * This is the COARSE filter, matching how requireRole is used everywhere else in
 * this API: it turns away a clearly-wrong actor before any database work. The
 * service then re-checks against the database that the caller is THIS company's
 * manager (chatService.assertCurrentManager) — holding the role says what kind
 * of actor someone is, not whose account it is.
 */
router.get('/contacts/customers', requireRole('ACCOUNTING_MANAGER'), chatLimiter, listCustomerContacts);
router.get('/contacts/specialists', requireRole('ACCOUNTING_MANAGER'), chatLimiter, listSpecialistContacts);

/*
 * The live connection's credential. Cheap, read-only, and deliberately ahead of
 * the `/conversations` routes so `realtime-token` can never be read as a
 * conversation id.
 */
router.get('/realtime-token', chatLimiter, issueRealtimeToken);

router.get('/unread-count', chatLimiter, unreadCount);

router.get('/conversations', chatLimiter, listConversations);
router.post('/conversations', chatLimiter, openConversation);

router.get('/conversations/:conversationId/messages', chatLimiter, listMessages);
router.post('/conversations/:conversationId/messages', chatLimiter, sendMessage);
router.post('/conversations/:conversationId/read', chatLimiter, markRead);

router.delete('/messages/:messageId', chatLimiter, deleteMessage);

/*
 * The attachment routes carry `documentLimiter` rather than `chatLimiter`, the
 * same way the email upload route does: what they bound is bytes written to and
 * read out of the bucket, and that is the same work and the same risk wherever
 * it is issued from. `chatLimiter` is sized for typing, which is far too loose
 * for this.
 */
router.post('/attachments/upload-url', documentLimiter, requestUploadUrls);
router.get('/attachments/:attachmentId/download-url', documentLimiter, requestDownloadUrl);

module.exports = router;
