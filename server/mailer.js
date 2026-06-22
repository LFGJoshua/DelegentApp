import nodemailer from 'nodemailer'

// Email config (env). Resend is used via its HTTPS API (port 443) rather than
// SMTP, because many hosts (e.g. Render) block outbound SMTP ports, which makes
// nodemailer hang. Any other provider still works via SMTP as a fallback.
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, RESEND_API_KEY } = process.env

// Use the Resend HTTP API when we have a Resend key (either RESEND_API_KEY, or
// SMTP_USER=resend with the key in SMTP_PASS).
const resendKey = RESEND_API_KEY || (SMTP_USER === 'resend' ? SMTP_PASS : null)
const from = SMTP_FROM || SMTP_USER

export const mailReady = !!resendKey || !!(SMTP_HOST && SMTP_USER && SMTP_PASS)

if (!mailReady) {
  console.error('\n⚠ Email is not configured — password reset emails will not send. Set RESEND_API_KEY + SMTP_FROM (or SMTP_* for another provider).\n')
}

const smtpTransport = (!resendKey && SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: (Number(SMTP_PORT) || 587) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null

export async function sendMail({ to, subject, html, text }) {
  if (resendKey) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, text }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error('resend ' + res.status + ': ' + (await res.text()).slice(0, 200))
    } finally { clearTimeout(timer) }
    return
  }
  if (!smtpTransport) throw new Error('email not configured')
  await smtpTransport.sendMail({ from, to, subject, html, text })
}
