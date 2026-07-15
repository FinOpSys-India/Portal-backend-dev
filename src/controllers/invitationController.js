const crypto = require("crypto");
const db = require("../config/db");
const logger = require("../utils/logger");
const { sendInvitationEmail } = require("../services/emailService");

const createInvitation = async (req, res, next) => {
  try {
    const {
      email,
      firstName,
      lastName,
      roleId,
      specificRoleId,
      invitedBy
    } = req.body;

    if (!email || !firstName || !lastName || !roleId || !invitedBy) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48);

    const result = await db.query(
      `
      INSERT INTO invitations (
        email,
        first_name,
        last_name,
        role_id,
        specific_role_id,
        invited_by,
        token,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        email.toLowerCase().trim(),
        firstName.trim(),
        lastName.trim(),
        roleId,
        specificRoleId || null,
        invitedBy,
        token,
        expiresAt
      ]
    );

    const invitation = result.rows[0];

    // Look up the inviter so we can use their name/email as the email sender.
    const inviterResult = await db.query(
      `SELECT email, first_name, last_name FROM users WHERE id = $1`,
      [invitedBy]
    );
    const inviter = inviterResult.rows[0];

    // Send the invitation email to the invited address. A mail failure must
    // not fail the request — the invitation is already persisted.
    let emailSent = false;
    if (!inviter) {
      logger.error(
        `Invitation ${invitation.id}: inviter ${invitedBy} not found; skipping email.`
      );
    } else {
      const senderName = `${inviter.first_name} ${inviter.last_name}`.trim();
      const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
      const invitationUrl = `${frontendUrl}/accept-invitation?token=${token}`;

      try {
        await sendInvitationEmail({
          recipientEmail: invitation.email,
          recipientFirstName: invitation.first_name,
          senderEmail: inviter.email,
          senderName,
          invitationUrl,
          expiresAt: invitation.expires_at
        });
        emailSent = true;
      } catch (emailError) {
        logger.error(
          `Invitation ${invitation.id}: failed to send email to ${invitation.email}:`,
          emailError
        );
      }
    }

    return res.status(201).json({
      success: true,
      message: emailSent
        ? "Invitation created and email sent successfully."
        : "Invitation created, but the email could not be sent.",
      emailSent,
      data: invitation
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createInvitation
};