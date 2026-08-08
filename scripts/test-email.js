/**
 * Standalone email smoke test — isolates SMTP from the DB and API.
 *
 * Usage:
 *   node scripts/test-email.js you@example.com
 *
 * It (1) verifies the SMTP connection, then (2) sends one real invitation
 * email to the address you pass on the command line.
 */
require("dotenv").config();

const {
  sendInvitationEmail,
  verifyEmailConnection
} = require("../src/services/emailService");

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error("Usage: node scripts/test-email.js <recipient-email>");
    process.exit(1);
  }

  console.log("1) Verifying SMTP connection...");
  await verifyEmailConnection();
  console.log("   ✔ SMTP connection OK");

  console.log(`2) Sending test invitation email to ${to}...`);
  const info = await sendInvitationEmail({
    recipientEmail: to,
    recipientFirstName: "Tester",
    senderEmail: process.env.SMTP_FROM,
    senderName: "Admin",
    invitationUrl: `${process.env.FRONTEND_URL}/accept-invitation?token=TEST_TOKEN`,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000)
  });
  console.log("   ✔ Email accepted by server. messageId:", info.messageId);
}

main().catch((err) => {
  console.error("�‼ FAILED:", err);
  process.exit(1);
});
