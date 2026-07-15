const express = require("express");
const { createInvitation } = require("../controllers/invitationController");

const router = express.Router();

router.post("/", createInvitation);

module.exports = router;