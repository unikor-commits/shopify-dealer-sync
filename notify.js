// Sends emails (daily summary and alerts). If email isn't set up yet,
// messages are printed to the server logs instead.

const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendEmail(subject, text) {
  if (!transporter || !process.env.ALERT_EMAIL_TO) {
    console.log(`\n=== ${subject} ===\n${text}\n`);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.ALERT_EMAIL_TO,
    subject,
    text,
  });
  console.log(`Email sent: ${subject}`);
}

module.exports = { sendEmail };
