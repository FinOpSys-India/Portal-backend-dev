'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { profileLimiter } = require('../middlewares/rateLimiter');
const { uploadAvatar: parseAvatarUpload } = require('../middlewares/uploadAvatar');
const { listUsers } = require('../controllers/companyController');
const { getMe, updateMe, uploadAvatar, deleteAvatar } = require('../controllers/userController');

/*
 * The user directory, and the caller's own account.
 *
 * The directory exists to answer one question the API previously could not:
 * "which user id do I put in this field?". Assigning an accounting manager,
 * assigning a specialist, and inviting someone all needed a userId, and nothing
 * exposed one, so those screens could not be built without hardcoding ids.
 *
 * Authorization for it is enforced in the service rather than by a role gate
 * here: an ADMIN or a company OWNER may browse, and everyone else gets a 403.
 * The gate lives there because "owner" is a specific-role check that the service
 * already performs against the database.
 *
 *   GET    /users?role=SPECIALIST&search=hop&limit=25&offset=0
 *   GET    /users/me                -> the caller: profile + address + avatar URL
 *   PATCH  /users/me                -> the caller edits their own phone/address
 *   POST   /users/me/avatar         -> multipart upload, field name "avatar"
 *   DELETE /users/me/avatar         -> back to no picture
 *
 * The /me routes carry NO role gate, and that is deliberate rather than an
 * omission. Every other authorization rule in this API answers "may this caller
 * act on that record?", which needs a check because the record id arrives in the
 * request. Here there is no id to send: "me" is the token's subject, resolved in
 * requireAuth from a signed claim. There is nothing to tamper with and therefore
 * nothing to authorize — any authenticated user, of any role, may read and
 * correct their own phone number and address.
 *
 * Editing SOMEONE ELSE is a different operation and deliberately does not exist
 * here; it would need an admin gate and a different route.
 *
 * The directory returns ACTIVE users only, and only the fields a picker needs —
 * no password hash, no login-security columns, no onboarding profile beyond a
 * job title.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listUsers);

/*
 * `/me` is registered before nothing else that could shadow it — there is no
 * `/:userId` route in this file — but the ordering is kept explicit anyway, so
 * adding one later does not silently turn "me" into a user id lookup.
 */
router.get('/me', getMe);
router.patch('/me', profileLimiter, updateMe);

/*
 * The upload middleware runs BETWEEN the limiter and the controller, and that
 * position is load-bearing: it is what parses multipart/form-data (express.json
 * ignores it, so req.body and req.file are both empty without it), and it aborts
 * an oversized or wrong-typed file mid-stream rather than after it has landed on
 * disk. Putting the limiter first means a client that loops is rejected before
 * any bytes are written at all.
 */
router.post('/me/avatar', profileLimiter, parseAvatarUpload, uploadAvatar);
router.delete('/me/avatar', profileLimiter, deleteAvatar);

module.exports = router;
