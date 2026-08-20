'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const { emailLimiter, documentLimiter } = require('../middlewares/rateLimiter');
const {
  listCustomerRecipients,
  listSpecialistRecipients,
  listAccountingManagerRecipients,
  requestUploadUrls,
  sendNewMessage,
} = require('../controllers/emailController');

/*
 * The compose-and-send email screen.
 *
 *   GET    /emails/recipients/customers?companyId=    -> the owner and the teammates
 *   GET    /emails/recipients/specialists?companyId=  -> all three service lines
 *   GET    /emails/recipients/accounting-managers?companyId= -> the account manager
 *   POST   /emails/attachments/upload-url             -> where to send the files
 *   POST   /emails                                    -> compose AND send
 *
 * FIVE ENDPOINTS, AND THE SCREEN IS COMPOSE-ONLY. There is no draft and no sent
 * folder: one Send button means one write endpoint, and `POST /emails` creates
 * the row, attaches the uploaded files and hands the message to SMTP in a single
 * request. With no attachments it is the only call the screen makes.
 *
 * WHAT USED TO BE HERE AND IS NOT:
 *
 *   GET    /emails?companyId=                the outbox — no screen lists sent mail
 *   GET    /emails/:id                       nothing links to one message
 *   POST   /emails/:id/send                  the retry that hung off the outbox
 *   PATCH  /emails/:id                       nothing to edit before sending
 *   DELETE /emails/:id                       nothing half-written to discard
 *   POST   /emails/:id/attachments/confirm   folded into POST /emails
 *   DELETE /emails/:id/attachments/:id       the file is removed in the browser,
 *                                            before it is ever sent
 *
 * The rows are still WRITTEN — every send records what went out, to whom, and
 * whether it failed — so the history exists in the database whenever a screen is
 * built to read it. What was removed is the reading, not the recording.
 *
 * The upload endpoint survives, because it answers a constraint rather than a
 * workflow: a file larger than the host's request ceiling cannot travel through
 * this API at all, so the browser must PUT it to the bucket itself and needs a
 * signed URL to do that. It moved OFF the message path — there is no message id
 * when a file is uploaded — and now takes `companyId` in its body, which is what
 * the access check runs against.
 *
 * `companyId` is REQUIRED on every call, with no admin exemption: a merged
 * recipient picker is how a message reaches the wrong account.
 *
 * SCOPE, NOT A ROLE GATE, matching /documents and /teammates. Any authenticated
 * caller may ask, and the service decides against the database whether they may
 * reach THAT company — its owner, an ADMIN, its accounting manager, or a
 * specialist assigned to it. A coarse role check could only tell that the caller
 * holds a role somewhere, which is not the question.
 *
 * THREE RECIPIENT ENDPOINTS, one per group the picker renders, and each one is a
 * different way of being attached to a company:
 *
 *   customers            the owner (companies.owner_user_id) AND the teammates
 *                        (company_members). No pre-existing endpoint returned
 *                        both — /customers resolves ownership, /teammates
 *                        resolves membership — which is why this one exists.
 *   specialists          all three service lines, read from the standing columns
 *                        on `companies` unioned with the live assignment rows,
 *                        because neither source is complete alone.
 *   accounting-managers  companies.accounting_manager_user_id — a single column,
 *                        so a list of at most one, returned as an array anyway so
 *                        all three answer in the same shape.
 */
const router = express.Router();

router.use(requireAuth);

/*
 * THREE ENDPOINTS, NOT ONE ANSWER CARRYING ALL THREE GROUPS. They are separate
 * sections of the picker, opened independently — a caller after specialists should
 * not pay for the customer query, and a caller that wants all three fires them in
 * parallel.
 */
router.get('/recipients/customers', listCustomerRecipients);
router.get('/recipients/specialists', listSpecialistRecipients);

/*
 * THE ONE ROLE GATE ON THIS FEATURE, and the only endpoint here that has one.
 *
 * Writing TO the accounting manager is what a customer or a specialist does; an
 * accounting manager has no use for a list whose only entry is themselves, and
 * offering it would put "email the accounting manager" on the manager's own
 * screen. So the two groups who actually address them are the two allowed to ask.
 *
 * ADMIN is excluded by omission rather than by decision here — it is already
 * excluded from every email endpoint by the company-scope rule, which follows
 * from being ON a company rather than from administering the platform.
 *
 * This gate is the COARSE filter, matching how requireRole is used everywhere
 * else in this API: it turns away a clearly-wrong actor before any database work.
 * The service re-checks the role against the database afterwards, because a token
 * claim is a snapshot and the authoritative answer lives in `users`.
 */
router.get(
  '/recipients/accounting-managers',
  requireRole('CUSTOMER', 'SPECIALIST'),
  listAccountingManagerRecipients
);

/*
 * Carries `documentLimiter` rather than `emailLimiter`: this is the same
 * bucket-writing work the project-document routes do, capped by the same counter,
 * because the thing being bounded is bytes written per IP and it makes no
 * difference which screen wrote them.
 */
router.post('/attachments/upload-url', documentLimiter, requestUploadUrls);

/*
 * The send. Capped tighter than the rest by `emailLimiter` for the reason the
 * limiter exists: this is the only endpoint in the API that puts mail in a third
 * party's inbox, and a loop here is a loop that spams a real client.
 */
router.post('/', emailLimiter, sendNewMessage);

module.exports = router;
