import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import db from './db.js'
import { putImage, imageUrl, getImage, storageReady } from './storage.js'
import { sendMail, mailReady } from './mailer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 4000
const app = express()
app.set('trust proxy', 1) // behind Render's TLS proxy
app.use(cors())
app.use(express.json({ limit: '30mb' })) // base64 PNGs can be large

// Minimal cookie parser (avoids a dependency): populates req.cookies.
app.use((req, _res, next) => {
  req.cookies = {}
  const raw = req.headers.cookie
  if (raw) for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  next()
})

// Desktop-app downloads + auto-update feed (built by `cd agent && npm run dist`).
const RELEASE_DIR = join(__dirname, '..', 'agent', 'release')
app.use('/updates', express.static(RELEASE_DIR)) // electron-updater reads latest.yml here

// Installer downloads. Installers are published as GitHub Release assets by CI
// (.github/workflows/build-desktop.yml), so this redirects there — works even on
// a host with an ephemeral filesystem (e.g. Render). ?platform=mac&arch=x64|arm64.
const GH_RELEASE = 'https://github.com/LFGJoshua/DelegentApp/releases/latest/download'
app.get('/download/app', (req, res) => {
  const p = String(req.query.platform || '').toLowerCase()
  const arch = String(req.query.arch || '').toLowerCase()
  let file = 'Delegent-Setup.exe' // default: Windows
  if (p === 'mac' || p === 'darwin') file = (arch === 'x64' || arch === 'intel') ? 'Delegent-mac-x64.dmg' : 'Delegent-mac-arm64.dmg'
  res.redirect(302, `${GH_RELEASE}/${file}`)
})

// Clean URLs (no .html). Serve the pages at extension-less paths and 301 the
// .html versions to them.
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'public', 'landing.html')))      // public marketing page
app.get('/dashboard', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html'))) // the app (auth-gated client-side)
app.get('/login', (_req, res) => res.sendFile(join(__dirname, 'public', 'login.html')))
app.get('/download', (_req, res) => res.sendFile(join(__dirname, 'public', 'download.html')))
app.get('/reset', (_req, res) => res.sendFile(join(__dirname, 'public', 'reset.html')))
app.get('/login.html', (_req, res) => res.redirect(301, '/login'))
app.get('/download.html', (_req, res) => res.redirect(301, '/download'))

// index:false so static doesn't auto-serve index.html (the dashboard) at "/".
app.use('/', express.static(join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache') },
}))

const upsertAgent = db.prepare(`
  INSERT INTO agents (id, name, last_seen, user_id) VALUES (@id, @name, @last_seen, @user_id)
  ON CONFLICT (id) DO UPDATE SET
    name = COALESCE(excluded.name, agents.name),
    last_seen = excluded.last_seen,
    user_id = COALESCE(excluded.user_id, agents.user_id)
`)
const insertShot = db.prepare(`
  INSERT INTO screenshots (id, agent_id, captured_at, received_at, active_app, file, width, height, activity_pct)
  VALUES (@id, @agent_id, @captured_at, @received_at, @active_app, @file, @width, @height, @activity_pct)
`)

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'delegent-server', storage: storageReady, mail: mailReady }))

// ---- Authentication (accounts, sessions) ----
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const COOKIE = 'delegent_session'

const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?')
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?')
const insertUser = db.prepare(`INSERT INTO users (id, email, name, pass_hash, pass_salt, role, user_type, created_at)
  VALUES (@id, @email, @name, @pass_hash, @pass_salt, @role, @user_type, @created_at)`)
const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users')
const countAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
const listUsers = db.prepare('SELECT id, email, name, role, user_type, created_at FROM users ORDER BY created_at ASC')
const updateUserRoleType = db.prepare('UPDATE users SET role = @role, user_type = @user_type WHERE id = @id')

const insertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (@token, @user_id, @created_at, @expires_at)')
const getSession = db.prepare('SELECT * FROM sessions WHERE token = ?')
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?')
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?')

const insertReset = db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (@token, @user_id, @expires_at)')
const getReset = db.prepare('SELECT * FROM password_resets WHERE token = ?')
const markResetUsed = db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?')
const updatePassword = db.prepare('UPDATE users SET pass_hash = @hash, pass_salt = @salt WHERE id = @id')

// Password policy: min 8 chars, at least one uppercase, one number, one special
// character. Returns an error string, or null if valid.
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter'
  if (!/[0-9]/.test(pw)) return 'Password must include a number'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a special character'
  return null
}

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(pw), salt, 64).toString('hex')
  return { salt, hash }
}
function verifyPassword(pw, salt, hash) {
  const h = scryptSync(String(pw), salt, 64).toString('hex')
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
async function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  await insertSession.run({ token, user_id: userId, created_at: now, expires_at: now + SESSION_TTL_MS })
  return token
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, userType: u.user_type })

// Resolve the current user from a Bearer token (desktop) or session cookie (web).
app.use(async (req, _res, next) => {
  let token = null
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim()
  else if (req.cookies[COOKIE]) token = req.cookies[COOKIE]
  req.user = null
  req.token = token
  try {
    if (token) {
      const s = await getSession.get(token)
      if (s && s.expires_at > Date.now()) req.user = (await getUserById.get(s.user_id)) || null
      else if (s) await deleteSession.run(token) // expired
    }
  } catch (err) { return next(err) }
  next()
})

const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'auth required' })
// Which agentId an employee may query: admins may pass any (or none = all);
// employees are always forced to their own. Used to scope read endpoints.
const scopedAgentId = (req) => req.user.role === 'admin' ? (req.query.agentId || null) : req.user.id
const isAdmin = (req) => req.user.role === 'admin'
const requireAdmin = (req, res, next) =>
  req.user ? (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' })) : res.status(401).json({ error: 'auth required' })

// --- Timezone-aware day bucketing ---
// Clients pass ?tz=<minutes east of UTC> (e.g. UTC+8 → 480). Day boundaries are
// then computed in the viewer's local time, not the server's, so screenshots and
// tracked time land on the day the user actually sees. Defaults to 0 (UTC).
const tzMin = (req) => { const v = Number(req.query.tz); return Number.isFinite(v) ? v : 0 }
// UTC ms of local-midnight for the local calendar day containing `ms`.
const startOfLocalDay = (ms, tz) => { const d = new Date(ms + tz * 60000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tz * 60000 }
// UTC ms of local-midnight for an explicit local Y/M(0-based)/D.
const localDayMs = (y, m0, d, tz) => Date.UTC(y, m0, d) - tz * 60000
// Day-of-week (0=Sun) of a local day given its local-midnight UTC ms.
const localDow = (dayStartUtc, tz) => new Date(dayStartUtc + tz * 60000).getUTCDay()

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`)
}

// Register. The very first account becomes the admin; everyone after is an employee.
app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const name = String(req.body?.name || '').trim()
  const password = req.body?.password || ''
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' })
  if (!name) return res.status(400).json({ error: 'name is required' })
  const pwErr = validatePassword(password)
  if (pwErr) return res.status(400).json({ error: pwErr })
  if (await getUserByEmail.get(email)) return res.status(409).json({ error: 'an account with that email already exists' })

  const role = (await countUsers.get()).n === 0 ? 'admin' : 'employee'
  const { salt, hash } = hashPassword(password)
  const id = randomUUID()
  await insertUser.run({ id, email, name: name || email.split('@')[0], pass_hash: hash, pass_salt: salt, role, user_type: 'Default', created_at: Date.now() })
  const token = await createSession(id)
  setSessionCookie(res, token)
  res.json({ user: publicUser(await getUserById.get(id)), token })
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = req.body?.password || ''
  const u = await getUserByEmail.get(email)
  if (!u || !verifyPassword(password, u.pass_salt, u.pass_hash)) return res.status(401).json({ error: 'invalid email or password' })
  const token = await createSession(u.id)
  setSessionCookie(res, token)
  res.json({ user: publicUser(u), token })
})

app.post('/api/auth/logout', async (req, res) => {
  if (req.token) await deleteSession.run(req.token)
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
  res.json({ ok: true })
})

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }))

// ---- Password reset (email link) ----
const RESET_TTL_MS = 60 * 60 * 1000 // 1 hour

// Request a reset link. Always returns ok (don't reveal whether the email exists).
app.post('/api/auth/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const u = email ? await getUserByEmail.get(email) : null
  if (u) {
    const token = randomBytes(32).toString('hex')
    await insertReset.run({ token, user_id: u.id, expires_at: Date.now() + RESET_TTL_MS })
    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
    const link = `${base}/reset?token=${token}`
    try {
      await sendMail({
        to: u.email,
        subject: 'Reset your Delegent password',
        text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
        html: `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#0f2a20;max-width:480px">
          <h2 style="color:#15803d;margin:0 0 12px">Reset your Delegent password</h2>
          <p>We received a request to reset your password. Click below to choose a new one:</p>
          <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#15803d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700">Reset password</a></p>
          <p style="color:#5f6f67;font-size:13px">Or paste this link into your browser:<br>${link}</p>
          <p style="color:#5f6f67;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        </div>`,
      })
    } catch (e) { console.error('reset email failed:', e.message) }
  }
  res.json({ ok: true })
})

// Complete a reset with the token from the email link.
app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body || {}
  const row = token ? await getReset.get(token) : null
  if (!row || row.used || row.expires_at < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  const pwErr = validatePassword(password)
  if (pwErr) return res.status(400).json({ error: pwErr })
  const { salt, hash } = hashPassword(password)
  await updatePassword.run({ id: row.user_id, hash, salt })
  await markResetUsed.run(token)
  await deleteUserSessions.run(row.user_id) // sign out all existing sessions
  res.json({ ok: true })
})

// ---- Admin: user management (assign role + signal profile) ----
app.get('/api/users', requireAdmin, async (_req, res) => {
  const users = await listUsers.all()
  res.json(users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, userType: u.user_type, createdAt: u.created_at })))
})

app.post('/api/users/:id', requireAdmin, async (req, res) => {
  const target = await getUserById.get(req.params.id)
  if (!target) return res.status(404).json({ error: 'user not found' })
  const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'employee' ? 'employee' : target.role
  const user_type = USER_TYPES.includes(req.body?.userType) ? req.body.userType : target.user_type
  // Don't allow demoting the last remaining admin.
  if (target.role === 'admin' && role !== 'admin' && (await countAdmins.get()).n <= 1)
    return res.status(400).json({ error: 'cannot demote the last admin' })
  await updateUserRoleType.run({ id: target.id, role, user_type })
  res.json({ user: publicUser(await getUserById.get(target.id)) })
})

// --- Admin settings: which TrustScore signals are enabled, per user type ---
const DEFAULT_SIGNALS = { jiggler: true, fakeTyping: true, cycling: true, stale: true, mismatch: true }
const USER_TYPES = ['Default', 'Developer', 'Virtual Assistant', 'Data Entry', 'Designer']
// Sensible per-type starting points (the two dev-unfriendly signals start off).
const TYPE_DEFAULTS = {
  Default: { ...DEFAULT_SIGNALS },
  Developer: { ...DEFAULT_SIGNALS, cycling: false, stale: false },
  'Virtual Assistant': { ...DEFAULT_SIGNALS },
  'Data Entry': { ...DEFAULT_SIGNALS },
  Designer: { ...DEFAULT_SIGNALS, stale: false },
}
const defaultsFor = (type) => ({ ...DEFAULT_SIGNALS, ...(TYPE_DEFAULTS[type] || {}) })

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (@k, @v)
  ON CONFLICT (key) DO UPDATE SET value = @v`)
async function readByType() {
  const row = await getSetting.get('signalsByType')
  let stored = {}
  try { stored = row ? JSON.parse(row.value) : {} } catch {}
  const out = {}
  for (const t of USER_TYPES) out[t] = { ...defaultsFor(t), ...(stored[t] || {}) }
  return out
}

// ?type=X → just that type's signals (used by the agent). No type → full map (UI).
app.get('/api/settings', requireAuth, async (req, res) => {
  const byType = await readByType()
  if (req.query.type) {
    const t = USER_TYPES.includes(req.query.type) ? req.query.type : 'Default'
    return res.json({ type: t, signals: byType[t] })
  }
  res.json({ types: USER_TYPES, signalsByType: byType })
})

// The agent's own signal profile — resolved from the logged-in user's admin-
// assigned user_type, so role/type changes take effect without reconfiguring.
app.get('/api/my-signals', requireAuth, async (req, res) => {
  const byType = await readByType()
  const t = USER_TYPES.includes(req.user.user_type) ? req.user.user_type : 'Default'
  res.json({ userType: t, signals: byType[t] })
})

app.post('/api/settings', requireAdmin, async (req, res) => {
  const { type, signals } = req.body || {}
  const t = USER_TYPES.includes(type) ? type : 'Default'
  const byType = await readByType()
  const next = { ...byType[t], ...(signals || {}) }
  for (const k of Object.keys(DEFAULT_SIGNALS)) next[k] = !!next[k]
  byType[t] = next
  await setSetting.run({ k: 'signalsByType', v: JSON.stringify(byType) })
  res.json({ ok: true, type: t, signals: next })
})

// Agent uploads a screenshot (base64 PNG + metadata). Ownership comes from the
// authenticated user — the agent's identity IS the logged-in account.
app.post('/api/screenshots', requireAuth, async (req, res) => {
  const { capturedAt, activeApp, image, width, height } = req.body || {}
  const agentId = req.user.id
  const agentName = req.user.name
  if (!image) return res.status(400).json({ error: 'image is required' })

  const now = Date.now()
  const id = randomUUID()
  const base64 = String(image).replace(/^data:image\/\w+;base64,/, '')
  const file = `${id}.png`

  try {
    await putImage(file, Buffer.from(base64, 'base64'))
    await upsertAgent.run({ id: agentId, name: agentName || null, last_seen: now, user_id: req.user.id })
    await insertShot.run({
      id,
      agent_id: agentId,
      captured_at: Number(capturedAt) || now,
      received_at: now,
      active_app: activeApp || null,
      file,
      width: width || null,
      height: height || null,
      activity_pct: req.body.activityPct == null ? null : Number(req.body.activityPct),
    })
    res.json({ ok: true, id, url: await imageUrl(file) })
  } catch (err) {
    console.error('Failed to store screenshot:', err)
    res.status(500).json({ error: 'storage failed' })
  }
})

// List recent screenshots (metadata only; image URL points at object storage).
app.get('/api/screenshots', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 500)
  const own = scopedAgentId(req) // employee → own id; admin → optional filter
  const rows = own
    ? await db.prepare(`
        SELECT s.id, s.agent_id AS "agentId", a.name AS "agentName", s.captured_at AS "capturedAt",
               s.received_at AS "receivedAt", s.active_app AS "activeApp", s.width, s.height, s.file
        FROM screenshots s LEFT JOIN agents a ON a.id = s.agent_id
        WHERE s.agent_id = ? ORDER BY s.captured_at DESC LIMIT ?
      `).all(own, limit)
    : await db.prepare(`
        SELECT s.id, s.agent_id AS "agentId", a.name AS "agentName", s.captured_at AS "capturedAt",
               s.received_at AS "receivedAt", s.active_app AS "activeApp", s.width, s.height, s.file
        FROM screenshots s LEFT JOIN agents a ON a.id = s.agent_id
        ORDER BY s.captured_at DESC LIMIT ?
      `).all(limit)
  const out = rows.map((r) => ({
    id: r.id, agentId: r.agentId, agentName: r.agentName, capturedAt: r.capturedAt,
    receivedAt: r.receivedAt, activeApp: r.activeApp, width: r.width, height: r.height,
    url: '/api/img/' + r.id,
  }))
  res.json(out)
})

// Image proxy — a STABLE, cacheable URL per screenshot. The browser caches each
// image permanently (screenshots never change), so repeated dashboard polls
// don't re-download them. Auth + ownership enforced (employees see only their own).
const getShotOwner = db.prepare('SELECT agent_id, file FROM screenshots WHERE id = ?')
app.get('/api/img/:id', requireAuth, async (req, res) => {
  try {
    const row = await getShotOwner.get(req.params.id)
    if (!row) return res.status(404).end()
    if (!isAdmin(req) && row.agent_id !== req.user.id) return res.status(403).end()
    const r = await getImage(row.file)
    if (!r || !r.ok) return res.status(502).end()
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (err) {
    console.error('img proxy failed:', err)
    res.status(500).end()
  }
})

// ---- Time tracking ----
const insertSegment = db.prepare(`
  INSERT INTO work_segments (id, agent_id, started_at, ended_at, seconds, open, note)
  VALUES (@id, @agent_id, @started_at, NULL, 0, 1, @note)
`)
const updateNote = db.prepare(`UPDATE work_segments SET note = @note WHERE id = @id`)
// Heartbeat: bump last-seen + progress, but keep the segment open.
const beatSegment = db.prepare(`
  UPDATE work_segments SET ended_at = @ended_at, seconds = @seconds WHERE id = @id
`)
// Stop: finalize and mark closed.
const closeSegment = db.prepare(`
  UPDATE work_segments SET ended_at = @ended_at, seconds = @seconds, open = 0 WHERE id = @id
`)
// TrustScore: keep the worst (min) score seen and the union of flagged events.
const getTrust = db.prepare(`SELECT trust_score, trust_flags FROM work_segments WHERE id = ?`)
const setTrust = db.prepare(`UPDATE work_segments SET trust_score = @ts, trust_flags = @flags WHERE id = @id`)
async function recordTrust(segmentId, trustScore, trustFlags) {
  if (segmentId == null || trustScore == null) return
  const row = await getTrust.get(segmentId)
  if (!row) return
  const minScore = row.trust_score == null ? trustScore : Math.min(row.trust_score, Number(trustScore))
  let existing = []
  try { existing = JSON.parse(row.trust_flags || '[]') } catch {}
  const merged = [...new Set([...existing, ...(trustFlags || [])])]
  await setTrust.run({ id: segmentId, ts: minScore, flags: JSON.stringify(merged) })
}

// Timer pressed Play (or resumed): open a new work segment.
app.post('/api/time/start', requireAuth, async (req, res) => {
  const { startedAt } = req.body || {}
  const agentId = req.user.id
  const now = Date.now()
  const id = randomUUID()
  await upsertAgent.run({ id: agentId, name: req.user.name || null, last_seen: now, user_id: req.user.id })
  await insertSegment.run({ id, agent_id: agentId, started_at: Number(startedAt) || now, note: req.body.note || null })
  res.json({ ok: true, segmentId: id })
})

// Update the "what are you working on?" note for a segment.
app.post('/api/time/note', requireAuth, async (req, res) => {
  const { segmentId, note } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  await updateNote.run({ id: segmentId, note: note || null })
  res.json({ ok: true })
})

// Periodic keep-alive while running, so the dashboard shows live progress and a
// crash loses at most one interval.
app.post('/api/time/heartbeat', requireAuth, async (req, res) => {
  const { segmentId, seconds } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  await upsertAgent.run({ id: req.user.id, name: req.user.name || null, last_seen: Date.now(), user_id: req.user.id })
  await beatSegment.run({ id: segmentId, ended_at: Date.now(), seconds: Number(seconds) || 0 })
  await recordTrust(segmentId, req.body.trustScore, req.body.trustFlags)
  res.json({ ok: true })
})

// Timer pressed Pause/Stop: finalize the segment.
app.post('/api/time/stop', requireAuth, async (req, res) => {
  const { segmentId, seconds, endedAt } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  await closeSegment.run({ id: segmentId, ended_at: Number(endedAt) || Date.now(), seconds: Number(seconds) || 0 })
  res.json({ ok: true })
})

// Worked-time summary per agent: total today, all-time, and whether running now.
app.get('/api/time/summary', requireAuth, async (req, res) => {
  const now = Date.now()
  const todayMs = startOfLocalDay(now, tzMin(req))

  const STALE_MS = 90_000 // an open segment with no heartbeat for this long = crashed agent
  const segs = await db.prepare(`SELECT agent_id, started_at, ended_at, seconds, open FROM work_segments`).all()
  const byAgent = new Map()
  for (const s of segs) {
    const lastSeen = s.ended_at || s.started_at
    const stale = s.open === 1 && now - lastSeen > STALE_MS
    const running = s.open === 1 && !stale

    let secs
    if (running) secs = Math.round((now - s.started_at) / 1000)        // still ticking
    else if (s.open === 1) secs = Math.round((lastSeen - s.started_at) / 1000) // crashed: count to last heartbeat
    else secs = s.seconds || 0                                          // cleanly stopped

    const a = byAgent.get(s.agent_id) || { agentId: s.agent_id, todaySeconds: 0, totalSeconds: 0, running: false, currentStartedAt: null }
    a.totalSeconds += secs
    if (s.started_at >= todayMs) a.todaySeconds += secs
    if (running) { a.running = true; a.currentStartedAt = s.started_at }
    byAgent.set(s.agent_id, a)
  }

  const agents = isAdmin(req)
    ? await db.prepare(`SELECT id, name FROM agents`).all()
    : await db.prepare(`SELECT id, name FROM agents WHERE id = ?`).all(req.user.id)
  const result = agents.map((ag) => {
    const t = byAgent.get(ag.id) || { todaySeconds: 0, totalSeconds: 0, running: false, currentStartedAt: null }
    return { agentId: ag.id, agentName: ag.name, ...t }
  })
  res.json(result)
})

// Apps & URLs report: time share per active app over a date range, plus total
// worked time and average activity. App time is approximated from the share of
// screenshots on each app (screenshots are sampled at the capture interval).
app.get('/api/report/apps', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const tz = tzMin(req)
  const [fy, fm, fd] = String(req.query.from || '').split('-').map(Number)
  const [ty, tm, td] = String(req.query.to || '').split('-').map(Number)
  const fromStart = localDayMs(fy, fm - 1, fd, tz)
  const toEnd = localDayMs(ty, tm - 1, td, tz) + 86400000 // inclusive end day
  const now = Date.now()

  // Total worked time from segments overlapping the range.
  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open FROM work_segments WHERE agent_id = ?`).all(agentId)
  let totalWorked = 0
  for (const s of segs) { const [st, en] = segInterval(s, now); totalWorked += overlap(st, en, fromStart, toEnd) }
  totalWorked = Math.round(totalWorked / 1000)

  // App share + average activity from screenshots in range.
  const shots = await db.prepare(`SELECT active_app AS app, activity_pct AS act FROM screenshots
    WHERE agent_id = ? AND captured_at >= ? AND captured_at < ?`).all(agentId, fromStart, toEnd)
  const counts = new Map()
  let actSum = 0, actN = 0
  for (const s of shots) {
    const app = s.app && s.app.trim() ? s.app.trim() : 'Unknown'
    counts.set(app, (counts.get(app) || 0) + 1)
    if (s.act != null) { actSum += s.act; actN++ }
  }
  const totalShots = shots.length || 1
  let apps = [...counts.entries()].map(([app, count]) => ({
    app, pct: Math.round((count / totalShots) * 100),
    seconds: Math.round((count / totalShots) * totalWorked),
  })).sort((a, b) => b.seconds - a.seconds)

  // Keep top 10, fold the rest into "Other".
  if (apps.length > 10) {
    const top = apps.slice(0, 10)
    const rest = apps.slice(10)
    top.push({ app: 'Other', pct: rest.reduce((a, b) => a + b.pct, 0), seconds: rest.reduce((a, b) => a + b.seconds, 0) })
    apps = top
  }

  res.json({
    from: fromStart, to: toEnd,
    totalWorked,
    activity: actN ? Math.round(actSum / actN) : 0,
    apps,
  })
})

// Detailed report: one row per work session (start→end) with duration + the
// average activity over that session, for a date range.
app.get('/api/report/detailed', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const tz = tzMin(req)
  const [fy, fm, fd] = String(req.query.from || '').split('-').map(Number)
  const [ty, tm, td] = String(req.query.to || '').split('-').map(Number)
  const fromStart = localDayMs(fy, fm - 1, fd, tz)
  const toEnd = localDayMs(ty, tm - 1, td, tz) + 86400000
  const now = Date.now()

  const agent = await db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId)
  const employee = (agent && agent.name) || agentId.slice(0, 8)

  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments
    WHERE agent_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at ASC`).all(agentId, fromStart, toEnd)
  const shots = await db.prepare(`SELECT captured_at AS t, activity_pct AS a FROM screenshots
    WHERE agent_id = ? AND captured_at >= ? AND captured_at < ?`).all(agentId, fromStart - 3600000, toEnd)

  const rows = segs.map((s) => {
    const [st, en] = segInterval(s, now)
    const durationSec = Math.round((en - st) / 1000)
    const acts = shots.filter((x) => x.a != null && x.t >= st && x.t <= en).map((x) => x.a)
    const activity = acts.length ? Math.round(acts.reduce((p, c) => p + c, 0) / acts.length) : null
    return { date: st, from: st, to: en, durationSec, note: (s.note && s.note.trim()) || null, activity }
  }).filter((r) => r.durationSec > 0)

  res.json({ employee, rows })
})

// Daily-by-employee report: per-day totals (duration + avg activity) for one
// employee over a range, each day broken down by note.
app.get('/api/report/daily', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const tz = tzMin(req)
  const [fy, fm, fd] = String(req.query.from || '').split('-').map(Number)
  const [ty, tm, td] = String(req.query.to || '').split('-').map(Number)
  const fromStart = localDayMs(fy, fm - 1, fd, tz)
  const toEnd = localDayMs(ty, tm - 1, td, tz) + 86400000
  const now = Date.now()
  const agent = await db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId)
  const employee = (agent && agent.name) || agentId.slice(0, 8)

  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments
    WHERE agent_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at ASC`).all(agentId, fromStart, toEnd)
  const shots = await db.prepare(`SELECT captured_at AS t, activity_pct AS a FROM screenshots
    WHERE agent_id = ? AND captured_at >= ? AND captured_at < ?`).all(agentId, fromStart, toEnd)

  const byDay = new Map() // dayMs -> { seconds, notes:Map }
  let totalSec = 0
  for (const s of segs) {
    const [st, en] = segInterval(s, now)
    const secs = Math.round((en - st) / 1000)
    if (secs <= 0) continue
    const dk = startOfLocalDay(st, tz)
    const e = byDay.get(dk) || { seconds: 0, notes: new Map() }
    e.seconds += secs
    const note = (s.note && s.note.trim()) || 'No note'
    e.notes.set(note, (e.notes.get(note) || 0) + secs)
    byDay.set(dk, e)
    totalSec += secs
  }
  const actByDay = new Map()
  let actSum = 0, actN = 0
  for (const x of shots) {
    if (x.a == null) continue
    const dk = startOfLocalDay(x.t, tz)
    const a = actByDay.get(dk) || { sum: 0, n: 0 }
    a.sum += x.a; a.n++; actByDay.set(dk, a)
    actSum += x.a; actN++
  }
  const days = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([dk, e]) => {
    const act = actByDay.get(dk)
    return {
      date: dk, seconds: e.seconds,
      activity: act && act.n ? Math.round(act.sum / act.n) : null,
      notes: [...e.notes.entries()].map(([note, seconds]) => ({ note, seconds })).sort((x, y) => y.seconds - x.seconds),
    }
  })
  res.json({ employee, total: { seconds: totalSec, activity: actN ? Math.round(actSum / actN) : 0 }, days })
})

// Home overview: one row per agent with last-active + Today/Yesterday/Week/Month
// totals and the latest screenshot thumbnail.
app.get('/api/overview', requireAuth, async (req, res) => {
  const now = Date.now()
  const tz = tzMin(req)
  const ld = new Date(now + tz * 60000) // local "now"
  const Y = ld.getUTCFullYear(), M = ld.getUTCMonth(), Dd = ld.getUTCDate()
  const todayStart = localDayMs(Y, M, Dd, tz), todayEnd = todayStart + 86400000
  const yStart = todayStart - 86400000
  const dow = (localDow(todayStart, tz) + 6) % 7 // Monday = 0
  const weekStart = todayStart - dow * 86400000, weekEnd = weekStart + 7 * 86400000
  const monStart = localDayMs(Y, M, 1, tz)
  const monEnd = localDayMs(Y, M + 1, 1, tz)

  const agents = isAdmin(req)
    ? await db.prepare(`SELECT id, name, last_seen FROM agents`).all()
    : await db.prepare(`SELECT id, name, last_seen FROM agents WHERE id = ?`).all(req.user.id)
  const lastShotStmt = db.prepare(`SELECT id, captured_at AS ts
    FROM screenshots WHERE agent_id = ? ORDER BY captured_at DESC LIMIT 1`)
  const segStmt = db.prepare(`SELECT started_at, ended_at, seconds, open, trust_score, trust_flags FROM work_segments WHERE agent_id = ?`)

  const rows = await Promise.all(agents.map(async (a) => {
    const segs = await segStmt.all(a.id)
    let today = 0, yest = 0, week = 0, month = 0, lastActive = a.last_seen || 0
    let trustScore = null
    const trustFlags = new Set()
    for (const s of segs) {
      const [st, en] = segInterval(s, now)
      today += overlap(st, en, todayStart, todayEnd)
      yest += overlap(st, en, yStart, todayStart)
      week += overlap(st, en, weekStart, weekEnd)
      month += overlap(st, en, monStart, monEnd)
      if (en > lastActive) lastActive = en
      // TrustScore reflects today's sessions (worst score + flags).
      if (overlap(st, en, todayStart, todayEnd) > 0 && s.trust_score != null) {
        trustScore = trustScore == null ? s.trust_score : Math.min(trustScore, s.trust_score)
        try { JSON.parse(s.trust_flags || '[]').forEach((f) => trustFlags.add(f)) } catch {}
      }
    }
    const shot = await lastShotStmt.get(a.id)
    if (shot && shot.ts > lastActive) lastActive = shot.ts
    return {
      agentId: a.id, name: a.name || a.id.slice(0, 8), lastActive,
      lastShotUrl: shot ? '/api/img/' + shot.id : null,
      today: Math.round(today / 1000), yesterday: Math.round(yest / 1000),
      week: Math.round(week / 1000), month: Math.round(month / 1000),
      trustScore: trustScore == null ? 100 : trustScore,
      trustFlags: [...trustFlags],
    }
  }))
  rows.sort((a, b) => b.lastActive - a.lastActive)
  res.json(rows)
})

// Per-day worked time + per-note breakdown for one agent (powers the agent's
// chart, today-total, and history list).
app.get('/api/time/daily', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const days = Math.min(Number(req.query.days) || 5, 31)
  const now = Date.now()
  const tz = tzMin(req)
  const STALE_MS = 90_000
  const dayKey = (ts) => startOfLocalDay(ts, tz)
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments WHERE agent_id = ?`).all(agentId)
  const byDay = new Map() // dayTs -> { seconds, notes: Map(note -> seconds) }
  for (const s of segs) {
    const lastSeen = s.ended_at || s.started_at
    const stale = s.open === 1 && now - lastSeen > STALE_MS
    const running = s.open === 1 && !stale
    let secs
    if (running) secs = Math.round((now - s.started_at) / 1000)
    else if (s.open === 1) secs = Math.round((lastSeen - s.started_at) / 1000)
    else secs = s.seconds || 0
    if (secs <= 0) continue
    const k = dayKey(s.started_at)
    const entry = byDay.get(k) || { seconds: 0, notes: new Map() }
    entry.seconds += secs
    const note = s.note && s.note.trim() ? s.note.trim() : 'No note'
    entry.notes.set(note, (entry.notes.get(note) || 0) + secs)
    byDay.set(k, entry)
  }

  const todayKey = dayKey(now)
  const chart = []
  for (let i = days - 1; i >= 0; i--) {
    const k = todayKey - i * 86400000
    chart.push({ date: k, label: labels[localDow(k, tz)], seconds: byDay.get(k)?.seconds || 0 })
  }
  const entries = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([k, e]) => ({
    date: k,
    isToday: k === todayKey,
    seconds: e.seconds,
    notes: [...e.notes.entries()].map(([note, seconds]) => ({ note, seconds })).sort((a, b) => b.seconds - a.seconds),
  }))

  res.json({ today: byDay.get(todayKey)?.seconds || 0, days: chart, entries })
})

// --- Helpers for time-range math over work segments ---
const STALE_MS = 90_000
function segInterval(s, now) {
  const lastSeen = s.ended_at || s.started_at
  let end
  if (s.open === 1 && now - lastSeen <= STALE_MS) end = now                       // running
  else if (s.open === 1) end = lastSeen                                           // crashed
  else end = s.ended_at || s.started_at + (s.seconds || 0) * 1000                 // closed
  return [s.started_at, Math.max(s.started_at, end)]
}
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c))

// Calendar: worked seconds for each day of a month (powers the day strip bars).
app.get('/api/calendar', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const tz = tzMin(req)
  const y = Number(req.query.year), m = Number(req.query.month) - 1 // month is 1-12
  const now = Date.now()
  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open FROM work_segments WHERE agent_id = ?`).all(agentId)
  const intervals = segs.map((s) => segInterval(s, now))
  const ndays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const days = []
  let monthTotal = 0
  for (let d = 1; d <= ndays; d++) {
    const a = localDayMs(y, m, d, tz), b = a + 86400000
    let secs = 0
    for (const [st, en] of intervals) secs += overlap(st, en, a, b)
    secs = Math.round(secs / 1000)
    monthTotal += secs
    days.push({ day: d, date: a, seconds: secs })
  }
  res.json({ year: y, month: m + 1, days, monthTotal })
})

// Day detail: day/week/month totals, per-hour activity, and the day's screenshots.
app.get('/api/day', requireAuth, async (req, res) => {
  const agentId = isAdmin(req) ? req.query.agentId : req.user.id
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const tz = tzMin(req)
  const [yy, mm, dd] = String(req.query.date || '').split('-').map(Number)
  const dayStart = localDayMs(yy, mm - 1, dd, tz), dayEnd = dayStart + 86400000
  const dow = (localDow(dayStart, tz) + 6) % 7 // 0 = Monday
  const weekStart = dayStart - dow * 86400000, weekEnd = weekStart + 7 * 86400000
  const monStart = localDayMs(yy, mm - 1, 1, tz), monEnd = localDayMs(yy, mm, 1, tz)
  const now = Date.now()

  const segs = await db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments WHERE agent_id = ?`).all(agentId)
  let dayTotal = 0, weekTotal = 0, monthTotal = 0
  const hours = new Array(24).fill(0)
  const noteMap = new Map()
  for (const s of segs) {
    const [st, en] = segInterval(s, now)
    const dayOv = overlap(st, en, dayStart, dayEnd)
    dayTotal += dayOv
    weekTotal += overlap(st, en, weekStart, weekEnd)
    monthTotal += overlap(st, en, monStart, monEnd)
    for (let h = 0; h < 24; h++) hours[h] += overlap(st, en, dayStart + h * 3600000, dayStart + (h + 1) * 3600000)
    if (dayOv > 0) {
      const note = s.note && s.note.trim() ? s.note.trim() : 'No note'
      noteMap.set(note, (noteMap.get(note) || 0) + dayOv)
    }
  }
  const notes = [...noteMap.entries()].map(([note, ms]) => ({ note, seconds: Math.round(ms / 1000) })).sort((a, b) => b.seconds - a.seconds)

  const shotRows = await db.prepare(`
    SELECT id, captured_at AS "capturedAt", active_app AS "activeApp", activity_pct AS "activityPct", file
    FROM screenshots WHERE agent_id = ? AND captured_at >= ? AND captured_at < ?
    ORDER BY captured_at ASC
  `).all(agentId, dayStart, dayEnd)
  const screenshots = shotRows.map((s) => ({
    id: s.id, capturedAt: s.capturedAt, activeApp: s.activeApp, activityPct: s.activityPct,
    url: '/api/img/' + s.id,
  }))

  res.json({
    date: dayStart,
    dayTotal: Math.round(dayTotal / 1000),
    weekTotal: Math.round(weekTotal / 1000),
    monthTotal: Math.round(monthTotal / 1000),
    hours: hours.map((ms) => Math.round(ms / 1000)),
    notes,
    screenshots,
  })
})

// List known agents with their latest activity.
app.get('/api/agents', requireAuth, async (req, res) => {
  const rows = isAdmin(req)
    ? await db.prepare(`
        SELECT a.id, a.name, a.last_seen AS "lastSeen",
               (SELECT COUNT(*) FROM screenshots s WHERE s.agent_id = a.id) AS "shotCount"
        FROM agents a ORDER BY a.last_seen DESC
      `).all()
    : await db.prepare(`
        SELECT a.id, a.name, a.last_seen AS "lastSeen",
               (SELECT COUNT(*) FROM screenshots s WHERE s.agent_id = a.id) AS "shotCount"
        FROM agents a WHERE a.id = ? ORDER BY a.last_seen DESC
      `).all(req.user.id)
  res.json(rows)
})

// JSON error handler (so a thrown DB error returns JSON, not an HTML stack page).
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'server error' })
})

// Initialize the database schema, then start listening.
db.init().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Delegent server listening on http://localhost:${PORT}`)
  })
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n⚠ Port ${PORT} is already in use — a Delegent server is probably already running.`)
      console.error(`  Open http://localhost:${PORT}, or stop the other server (or set PORT=4001 npm start).\n`)
      process.exit(1)
    }
    throw err
  })
}).catch((err) => {
  console.error('\n⚠ Failed to initialize the database:', err.message)
  console.error('  Check DATABASE_URL in server/.env (Supabase connection string).\n')
  process.exit(1)
})
