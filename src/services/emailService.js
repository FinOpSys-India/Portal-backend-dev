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

/**
 * Send a login OTP. The code is always sent to the account's registered
 * address, which the caller passes in — never an address taken from the
 * request body — so a login attempt cannot redirect someone else's code.
 *
 * The OTP appears only in the message body: never in the subject, a link, a
 * header, or any logged field. Nothing sensitive (password, tokens, internal
 * ids) is included.
 */
const sendOtpEmail = async ({
  recipientEmail,
  recipientFirstName,
  otp,
  expiresInMinutes = 5,
  requestedAt
}) => {
  const safeName = escapeHtml(recipientFirstName || "there");
  const safeOtp = escapeHtml(otp);

  const requestedText = requestedAt
    ? new Date(requestedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
      })
    : null;

  return transporter.sendMail({
    from: {
      name: process.env.SMTP_FROM_NAME || "FinOpSys Portal",
      address: process.env.SMTP_FROM || process.env.SMTP_USER
    },
    to: recipientEmail,
    subject: "Your FinOpSys Portal verification code",

    text: [
      `Hello ${recipientFirstName || "there"},`,
      "",
      `Your verification code is: ${otp}`,
      "",
      `This code expires in ${expiresInMinutes} minutes and can be used only once.`,
      "Do not share this code with anyone.",
      "",
      requestedText ? `Login requested on ${requestedText} UTC.` : "",
      "",
      "If you did not try to sign in, you can safely ignore this email."
    ]
      .filter(Boolean)
      .join("\n"),

    html: `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Verification Code</title>
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
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f7;">
            <tr>
              <td align="center" style="padding: 40px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 10px;">
                  <tr>
                    <td style="padding: 40px;">
                      <h1 style="margin: 0 0 24px; font-size: 25px; line-height: 1.3;">
                        Verify your sign-in
                      </h1>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Hello ${safeName},
                      </p>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Use this code to complete your sign-in:
                      </p>

                      <p
                        style="
                          margin: 0 0 24px;
                          font-size: 34px;
                          font-weight: 700;
                          letter-spacing: 8px;
                          color: #5b35d5;
                        "
                      >
                        ${safeOtp}
                      </p>

                      <p style="margin: 0 0 8px; line-height: 1.6;">
                        This code expires in <strong>${expiresInMinutes} minutes</strong> and can be used only once.
                      </p>
                      <p style="margin: 0 0 24px; line-height: 1.6;">
                        Do not share this code with anyone.
                      </p>

                      ${
                        requestedText
                          ? `<p style="margin: 0 0 16px; color: #666666; font-size: 13px; line-height: 1.5;">Login requested on <strong>${requestedText} UTC</strong>.</p>`
                          : ""
                      }

                      <p style="margin: 30px 0 0; color: #777777; font-size: 13px; line-height: 1.5;">
                        If you did not try to sign in, you can safely ignore this email.
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

/**
 * Send a password-reset OTP.
 *
 * Kept separate from sendOtpEmail rather than parameterised: the wording is the
 * whole security value of this message. A recipient who did not ask to reset
 * needs to understand immediately that someone is trying to take over their
 * account, and "verify your sign-in" would not tell them that.
 *
 * Like the login code, this goes only to the address stored on the account,
 * which the caller reads from the database — never one taken from the request
 * body — so a reset attempt cannot redirect someone else's code. The OTP appears
 * only in the message body: never in the subject, a link, a header, or any
 * logged field. There is deliberately no link and no account detail beyond the
 * first name.
 */
const sendPasswordResetOtpEmail = async ({
  recipientEmail,
  recipientFirstName,
  otp,
  expiresInMinutes = 5,
  requestedAt
}) => {
  const safeName = escapeHtml(recipientFirstName || "there");
  const safeOtp = escapeHtml(otp);

  const requestedText = requestedAt
    ? new Date(requestedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
      })
    : null;

  return transporter.sendMail({
    from: {
      name: process.env.SMTP_FROM_NAME || "FinOpSys Portal",
      address: process.env.SMTP_FROM || process.env.SMTP_USER
    },
    to: recipientEmail,
    subject: "Reset your FinOpSys Portal password",

    text: [
      `Hello ${recipientFirstName || "there"},`,
      "",
      "We received a request to reset the password on your FinOpSys Portal account.",
      "",
      `Your password reset code is: ${otp}`,
      "",
      `This code expires in ${expiresInMinutes} minutes and can be used only once.`,
      "Do not share this code with anyone. FinOpSys staff will never ask you for it.",
      "",
      requestedText ? `Reset requested on ${requestedText} UTC.` : "",
      "",
      "If you did not request a password reset, you can safely ignore this email —",
      "your password has not been changed and your account is unaffected."
    ]
      .filter(Boolean)
      .join("\n"),

    html: `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Password Reset Code</title>
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
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f7;">
            <tr>
              <td align="center" style="padding: 40px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 10px;">
                  <tr>
                    <td style="padding: 40px;">
                      <h1 style="margin: 0 0 24px; font-size: 25px; line-height: 1.3;">
                        Reset your password
                      </h1>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Hello ${safeName},
                      </p>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        We received a request to reset the password on your
                        FinOpSys Portal account. Use this code to continue:
                      </p>

                      <p
                        style="
                          margin: 0 0 24px;
                          font-size: 34px;
                          font-weight: 700;
                          letter-spacing: 8px;
                          color: #5b35d5;
                        "
                      >
                        ${safeOtp}
                      </p>

                      <p style="margin: 0 0 8px; line-height: 1.6;">
                        This code expires in <strong>${expiresInMinutes} minutes</strong> and can be used only once.
                      </p>
                      <p style="margin: 0 0 24px; line-height: 1.6;">
                        Do not share this code with anyone. FinOpSys staff will never ask you for it.
                      </p>

                      ${
                        requestedText
                          ? `<p style="margin: 0 0 16px; color: #666666; font-size: 13px; line-height: 1.5;">Reset requested on <strong>${requestedText} UTC</strong>.</p>`
                          : ""
                      }

                      <p style="margin: 30px 0 0; color: #777777; font-size: 13px; line-height: 1.5;">
                        If you did not request a password reset, you can safely
                        ignore this email — your password has not been changed
                        and your account is unaffected.
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

/**
 * Notify the account holder that their password has just been changed.
 *
 * This is the safety net on the whole reset flow: if an attacker ever completes
 * a reset, this message is what tells the real owner it happened, while the
 * attacker still has to get past the OTP on their next login. It is sent
 * best-effort after the change has already been committed, so a mail failure
 * must never roll back or fail the reset.
 *
 * Contains no code, no link, and no token — there is nothing here worth
 * intercepting.
 */
const sendPasswordChangedEmail = async ({
  recipientEmail,
  recipientFirstName,
  changedAt
}) => {
  const safeName = escapeHtml(recipientFirstName || "there");

  const changedText = new Date(changedAt || Date.now()).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  });

  return transporter.sendMail({
    from: {
      name: process.env.SMTP_FROM_NAME || "FinOpSys Portal",
      address: process.env.SMTP_FROM || process.env.SMTP_USER
    },
    to: recipientEmail,
    subject: "Your FinOpSys Portal password was changed",

    text: [
      `Hello ${recipientFirstName || "there"},`,
      "",
      `Your FinOpSys Portal password was changed on ${changedText} UTC.`,
      "",
      "You have been signed out on every device and will need to sign in again",
      "with your new password.",
      "",
      "If you did not make this change, contact your portal administrator",
      "immediately — someone else may have access to your email account."
    ].join("\n"),

    html: `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Password Changed</title>
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
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f7;">
            <tr>
              <td align="center" style="padding: 40px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 10px;">
                  <tr>
                    <td style="padding: 40px;">
                      <h1 style="margin: 0 0 24px; font-size: 25px; line-height: 1.3;">
                        Your password was changed
                      </h1>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Hello ${safeName},
                      </p>

                      <p style="margin: 0 0 16px; line-height: 1.6;">
                        Your FinOpSys Portal password was changed on
                        <strong>${changedText} UTC</strong>.
                      </p>

                      <p style="margin: 0 0 24px; line-height: 1.6;">
                        You have been signed out on every device and will need to
                        sign in again with your new password.
                      </p>

                      <p
                        style="
                          margin: 24px 0 0;
                          padding: 16px;
                          background-color: #fdf1f1;
                          border-radius: 6px;
                          line-height: 1.6;
                        "
                      >
                        <strong>Did not make this change?</strong><br />
                        Contact your portal administrator immediately — someone
                        else may have access to your email account.
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

/**
 * Strip HTML down to the plain-text alternative part.
 *
 * The database stores only `body_html` — the text version is DERIVED here, at
 * send time, rather than stored beside it, because a stored copy would drift the
 * first time a draft was edited and only one of the two was rewritten.
 *
 * Deliberately crude, and adequate for what it is: `<br>` and block ends become
 * newlines, remaining tags are dropped, the five named entities a rich-text
 * editor actually emits are decoded, and runs of blank lines collapse. This is
 * the fallback part, shown only by a client that refuses the HTML one — it needs
 * to be readable, not to be a faithful rendering. Anything cleverer belongs in a
 * library, and pulling one in for a fallback nobody sees would be the wrong
 * trade.
 *
 * `<script>` and `<style>` bodies are removed WITH their contents rather than
 * just untagged, or the text part would carry a wall of CSS.
 */
function htmlToText(html = "") {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Send one composed message from the email screen.
 *
 * THE FROM IS RECORDED, NOT OBEYED — the same split every other function in this
 * file makes, and the reason it is made here too. The envelope sender stays
 * SMTP_FROM, because the provider will not relay mail claiming an address it
 * does not authorize; the composer's real address goes in `replyTo`, so a reply
 * reaches the person who wrote it rather than the service mailbox. A frontend
 * that let the user type a From would be typing something this function ignores.
 *
 * `attachments` arrive as { filename, content, contentType } with `content` a
 * Buffer — the caller has already fetched the bytes out of the bucket, because
 * only it knows which keys the message owns and whether the caller may read
 * them. This function does no storage access and no authorization; it is the
 * transport and nothing else.
 *
 * IT DOES NOT CATCH. A refused send has to reach the caller so the row can be
 * marked FAILED with the reason on it; swallowing the error here would leave a
 * message that claims to be sent and never was.
 */
const sendComposedEmail = async ({
  senderEmail,
  senderName,
  to = [],
  cc = [],
  bcc = [],
  subject,
  bodyHtml,
  attachments = []
}) => {
  return transporter.sendMail({
    from: {
      name: senderName || process.env.SMTP_FROM_NAME || "FinOpSys Portal",
      address: process.env.SMTP_FROM || senderEmail
    },

    replyTo: senderEmail,
    to,
    // Omitted entirely when empty. Passing [] makes some transports emit a bare
    // "Cc:" header, which several spam filters score against.
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),

    subject,
    html: bodyHtml,
    text: htmlToText(bodyHtml),
    attachments
  });
};

module.exports = {
  sendInvitationEmail,
  sendOtpEmail,
  sendPasswordResetOtpEmail,
  sendPasswordChangedEmail,
  sendComposedEmail,
  htmlToText,
  verifyEmailConnection
};