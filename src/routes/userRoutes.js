'use strict';

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const { listUsers } = require('../controllers/companyController');

/*
 * The user directory.
 *
 * It exists to answer one question the API previously could not: "which user id
 * do I put in this field?". Assigning an accounting manager, assigning a
 * specialist, and inviting someone all needed a userId, and nothing exposed one,
 * so those screens could not be built without hardcoding ids.
 *
 * Authorization is enforced in the service rather than by a role gate here: an
 * ADMIN or a company OWNER may browse, and everyone else gets a 403. The gate
 * lives there because "owner" is a specific-role check that the service already
 * performs against the database.
 *
 *   GET /users?role=SPECIALIST&search=hop&limit=25&offset=0
 *
 * Returns ACTIVE users only, and only the fields a picker needs — no password
 * hash, no login-security columns, no onboarding profile beyond a job title.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', listUsers);

module.exports = router;
