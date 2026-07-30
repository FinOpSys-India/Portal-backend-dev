const express = require("express");
const { createInvitation } = require("../controllers/invitationController");
const { invitationLimiter } = require("../middlewares/rateLimiter");

const router = express.Router();

router.post("/", invitationLimiter, createInvitation);

module.exports = router;