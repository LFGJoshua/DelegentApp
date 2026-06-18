import nodemailer from 'nodemailer'

// Email is sent over SMTP, configured by env vars so it works with any provider
// (Gmail App Password, SendGrid, Resend, Mailgun, …):
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env

export const mailReady = !!(SMTP_HOST && SMTP_USER && SMTP_PASS)

if (!mailReady) {
  console.error('\n⚠ Email (SMTP) is not configured — password reset emails will not send. Set SMTP_HOST, SMTP_USER, SMTP_PASS in server/.env (see .env.example).\n')
}

const port = Number(SMTP_PORT) || 587
const transporter = mailReady
  ? nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null

export async function sendMail({ to, subject, html, text }) {
  if (!transporter) throw new Error('email not configured')
  await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, html, text })
}
