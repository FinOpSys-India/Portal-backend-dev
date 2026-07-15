const nodemailer = require("nodemailer");

const smtpPort = Number(process.env.SMTP_PORT || 465);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: process.env.SMTP_SECURE === "true" || smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

/**
 * Prevent user-controlled values from being inserted directly into HTML.
 */
const escapeHtml = (value = "") => {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
};

const sendInvitationEmail = async ({
  recipientEmail,
  recipientFirstName,
  senderEmail,
  senderName,
  invitationUrl,
  expiresAt
}) => {
  const safeRecipientName = escapeHtml(recipientFirstName);
  const safeSenderName = escapeHtml(senderName);
  const safeInvitationUrl = escapeHtml(invitationUrl);

  const expirationText = new Date(expiresAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  });

  return transporter.sendMail({
    /*
     * Send from the SMTP-authorized mailbox (SMTP_FROM) with a fixed display
     * name, so the provider accepts the message. Replies still go to the
     * inviter's real address.
     */
    from: {
      name: process.env.SMTP_FROM_NAME || "Admin",
      address: process.env.SMTP_FROM || senderEmail
    },

    replyTo: senderEmail,
    to: recipientEmail,
    subject: `${senderName} invited you to the FinOpSys Portal`,

    text: [
      `Hello ${recipientFirstName},`,
      "",
      `${senderName} has invited you to join the FinOpSys Portal.`,
      "",
      `Accept your invitation: ${invitationUrl}`,
      "",
      `This invitation expires on ${expirationText} UTC.`,
      "",
      "If you were not expecting this invitation, you can ignore this email."
    ].join("\n"),

    html: `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Portal Invitation</title>
        </head>

        <body
          style="
            margin: 0;
            padding: 0;
            background-color: #f5f5f7;
            font-family: Arial, Helvetica, sans-serif;
            color: #222222;
          "
        >
          <table
            role="presentation"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            style="background-color: #f5f5f7;"
          >
            <tr>
              <td align="center" style="padding: 40px 16px;">
                <table
                  role="presentation"
                  width="100%"
                  cellpadding="0"
                  cellspacing="0"
                  style="
                    max-width: 600px;
                    background-color: #ffffff;
                    border-radius: 10px;
                  "
                >
                  <tr>
                    <td style="padding: 40px;">
                      <h1
                        style="
                          margin: 0 0 24px;
                          font-size: 25px;
                          line-height: 1.3;
                        "
                      >
                        You have been invited
                      </h1>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Hello ${safeRecipientName},
                      </p>

                      <p style="margin: 0 0 24px; line-height: 1.6;">
                        <strong>${safeSenderName}</strong> has invited you to
                        join the FinOpSys Portal.
                      </p>

                      <p style="margin: 0 0 30px;">
                        <a
                          href="${safeInvitationUrl}"
                          style="
                            display: inline-block;
                            padding: 13px 24px;
                            background-color: #5b35d5;
                            color: #ffffff;
                            text-decoration: none;
                            border-radius: 6px;
                            font-weight: 600;
                          "
                        >
                          Accept Invitation
                        </a>
                      </p>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        This invitation expires on
                        <strong>${expirationText} UTC</strong>.
                      </p>

                      <p
                        style="
                          margin: 24px 0 8px;
                          color: #666666;
                          font-size: 13px;
                          line-height: 1.5;
                        "
                      >
                        If the button does not work, copy and paste this link:
                      </p>

                      <p
                        style="
                          margin: 0;
                          font-size: 13px;
                          line-height: 1.5;
                          word-break: break-all;
                        "
                      >
                        ${safeInvitationUrl}
                      </p>

                      <p
                        style="
                          margin: 30px 0 0;
                          color: #777777;
                          font-size: 13px;
                          line-height: 1.5;
                        "
                      >
                        If you were not expecting this invitation, you can
                        safely ignore this email.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `
  });
};

const verifyEmailConnection = async () => {
  await transporter.verify();
};

module.exports = {
  sendInvitationEmail,
  verifyEmailConnection
};