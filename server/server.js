import express from 'express'
import cors from 'cors'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import db from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = join(__dirname, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

const PORT = process.env.PORT || 4000
const app = express()
app.use(cors())
app.use(express.json({ limit: '30mb' })) // base64 PNGs can be large

// Serve stored screenshots and the dashboard viewer.
app.use('/uploads', express.static(UPLOAD_DIR))

// Desktop-app downloads + auto-update feed (built by `cd agent && npm run dist`).
const RELEASE_DIR = join(__dirname, '..', 'agent', 'release')
app.use('/updates', express.static(RELEASE_DIR)) // electron-updater reads latest.yml here

// Stable download link for the landing page (serves the latest built installer).
app.get('/download/app', (_req, res) => {
  try {
    const exe = existsSync(RELEASE_DIR) && readdirSync(RELEASE_DIR).find((f) => f.endsWith('.exe'))
    if (!exe) return res.status(404).send('No installer built yet. Run: cd agent && npm run dist')
    res.download(join(RELEASE_DIR, exe), exe)
  } catch { res.status(404).send('No installer available') }
})

// Landing page.
app.get('/download', (_req, res) => res.sendFile(join(__dirname, 'public', 'download.html')))

app.use('/', express.static(join(__dirname, 'public')))

const upsertAgent = db.prepare(`
  INSERT INTO agents (id, name, last_seen) VALUES (@id, @name, @last_seen)
  ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), last_seen = excluded.last_seen
`)
const insertShot = db.prepare(`
  INSERT INTO screenshots (id, agent_id, captured_at, received_at, active_app, file, width, height, activity_pct)
  VALUES (@id, @agent_id, @captured_at, @received_at, @active_app, @file, @width, @height, @activity_pct)
`)

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'delegent-server' }))

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
  ON CONFLICT(key) DO UPDATE SET value = @v`)
function readByType() {
  const row = getSetting.get('signalsByType')
  let stored = {}
  try { stored = row ? JSON.parse(row.value) : {} } catch {}
  const out = {}
  for (const t of USER_TYPES) out[t] = { ...defaultsFor(t), ...(stored[t] || {}) }
  return out
}

// ?type=X → just that type's signals (used by the agent). No type → full map (UI).
app.get('/api/settings', (req, res) => {
  const byType = readByType()
  if (req.query.type) {
    const t = USER_TYPES.includes(req.query.type) ? req.query.type : 'Default'
    return res.json({ type: t, signals: byType[t] })
  }
  res.json({ types: USER_TYPES, signalsByType: byType })
})
app.post('/api/settings', (req, res) => {
  const { type, signals } = req.body || {}
  const t = USER_TYPES.includes(type) ? type : 'Default'
  const byType = readByType()
  const next = { ...byType[t], ...(signals || {}) }
  for (const k of Object.keys(DEFAULT_SIGNALS)) next[k] = !!next[k]
  byType[t] = next
  setSetting.run({ k: 'signalsByType', v: JSON.stringify(byType) })
  res.json({ ok: true, type: t, signals: next })
})

// Agent uploads a screenshot (base64 PNG + metadata).
app.post('/api/screenshots', (req, res) => {
  const { agentId, agentName, capturedAt, activeApp, image, width, height } = req.body || {}
  if (!agentId || !image) return res.status(400).json({ error: 'agentId and image are required' })

  const now = Date.now()
  const id = randomUUID()
  const base64 = String(image).replace(/^data:image\/\w+;base64,/, '')
  const file = `${id}.png`

  try {
    writeFileSync(join(UPLOAD_DIR, file), Buffer.from(base64, 'base64'))
    upsertAgent.run({ id: agentId, name: agentName || null, last_seen: now })
    insertShot.run({
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
    res.json({ ok: true, id, url: `/uploads/${file}` })
  } catch (err) {
    console.error('Failed to store screenshot:', err)
    res.status(500).json({ error: 'storage failed' })
  }
})

// List recent screenshots (metadata only; image served from /uploads).
app.get('/api/screenshots', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 500)
  const rows = db.prepare(`
    SELECT s.id, s.agent_id AS agentId, a.name AS agentName, s.captured_at AS capturedAt,
           s.received_at AS receivedAt, s.active_app AS activeApp, s.width, s.height,
           '/uploads/' || s.file AS url
    FROM screenshots s LEFT JOIN agents a ON a.id = s.agent_id
    ORDER BY s.captured_at DESC LIMIT ?
  `).all(limit)
  res.json(rows)
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
function recordTrust(segmentId, trustScore, trustFlags) {
  if (segmentId == null || trustScore == null) return
  const row = getTrust.get(segmentId)
  if (!row) return
  const minScore = row.trust_score == null ? trustScore : Math.min(row.trust_score, Number(trustScore))
  let existing = []
  try { existing = JSON.parse(row.trust_flags || '[]') } catch {}
  const merged = [...new Set([...existing, ...(trustFlags || [])])]
  setTrust.run({ id: segmentId, ts: minScore, flags: JSON.stringify(merged) })
}

// Timer pressed Play (or resumed): open a new work segment.
app.post('/api/time/start', (req, res) => {
  const { agentId, agentName, startedAt } = req.body || {}
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const now = Date.now()
  const id = randomUUID()
  upsertAgent.run({ id: agentId, name: agentName || null, last_seen: now })
  insertSegment.run({ id, agent_id: agentId, started_at: Number(startedAt) || now, note: req.body.note || null })
  res.json({ ok: true, segmentId: id })
})

// Update the "what are you working on?" note for a segment.
app.post('/api/time/note', (req, res) => {
  const { segmentId, note } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  updateNote.run({ id: segmentId, note: note || null })
  res.json({ ok: true })
})

// Periodic keep-alive while running, so the dashboard shows live progress and a
// crash loses at most one interval.
app.post('/api/time/heartbeat', (req, res) => {
  const { segmentId, seconds, agentId, agentName } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  if (agentId) upsertAgent.run({ id: agentId, name: agentName || null, last_seen: Date.now() })
  beatSegment.run({ id: segmentId, ended_at: Date.now(), seconds: Number(seconds) || 0 })
  recordTrust(segmentId, req.body.trustScore, req.body.trustFlags)
  res.json({ ok: true })
})

// Timer pressed Pause/Stop: finalize the segment.
app.post('/api/time/stop', (req, res) => {
  const { segmentId, seconds, endedAt } = req.body || {}
  if (!segmentId) return res.status(400).json({ error: 'segmentId required' })
  closeSegment.run({ id: segmentId, ended_at: Number(endedAt) || Date.now(), seconds: Number(seconds) || 0 })
  res.json({ ok: true })
})

// Worked-time summary per agent: total today, all-time, and whether running now.
app.get('/api/time/summary', (_req, res) => {
  const now = Date.now()
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()

  const STALE_MS = 90_000 // an open segment with no heartbeat for this long = crashed agent
  const segs = db.prepare(`SELECT agent_id, started_at, ended_at, seconds, open FROM work_segments`).all()
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

  const agents = db.prepare(`SELECT id, name FROM agents`).all()
  const result = agents.map((ag) => {
    const t = byAgent.get(ag.id) || { todaySeconds: 0, totalSeconds: 0, running: false, currentStartedAt: null }
    return { agentId: ag.id, agentName: ag.name, ...t }
  })
  res.json(result)
})

// Apps & URLs report: time share per active app over a date range, plus total
// worked time and average activity. App time is approximated from the share of
// screenshots on each app (screenshots are sampled at the capture interval).
app.get('/api/report/apps', (req, res) => {
  const agentId = req.query.agentId
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const [fy, fm, fd] = String(req.query.from || '').split('-').map(Number)
  const [ty, tm, td] = String(req.query.to || '').split('-').map(Number)
  const fromStart = new Date(fy, fm - 1, fd).getTime()
  const toEnd = new Date(ty, tm - 1, td).getTime() + 86400000 // inclusive end day
  const now = Date.now()

  // Total worked time from segments overlapping the range.
  const segs = db.prepare(`SELECT started_at, ended_at, seconds, open FROM work_segments WHERE agent_id = ?`).all(agentId)
  let totalWorked = 0
  for (const s of segs) { const [st, en] = segInterval(s, now); totalWorked += overlap(st, en, fromStart, toEnd) }
  totalWorked = Math.round(totalWorked / 1000)

  // App share + average activity from screenshots in range.
  const shots = db.prepare(`SELECT active_app AS app, activity_pct AS act FROM screenshots
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

// Home overview: one row per agent with last-active + Today/Yesterday/Week/Month
// totals and the latest screenshot thumbnail.
app.get('/api/overview', (_req, res) => {
  const now = Date.now()
  const d0 = new Date(); d0.setHours(0, 0, 0, 0)
  const todayStart = d0.getTime(), todayEnd = todayStart + 86400000
  const yStart = todayStart - 86400000
  const dow = (d0.getDay() + 6) % 7
  const weekStart = todayStart - dow * 86400000, weekEnd = weekStart + 7 * 86400000
  const monStart = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime()
  const monEnd = new Date(d0.getFullYear(), d0.getMonth() + 1, 1).getTime()

  const agents = db.prepare(`SELECT id, name, last_seen FROM agents`).all()
  const lastShotStmt = db.prepare(`SELECT '/uploads/' || file AS url, captured_at AS ts
    FROM screenshots WHERE agent_id = ? ORDER BY captured_at DESC LIMIT 1`)

  const rows = agents.map((a) => {
    const segs = db.prepare(`SELECT started_at, ended_at, seconds, open, trust_score, trust_flags FROM work_segments WHERE agent_id = ?`).all(a.id)
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
    const shot = lastShotStmt.get(a.id)
    if (shot && shot.ts > lastActive) lastActive = shot.ts
    return {
      agentId: a.id, name: a.name || a.id.slice(0, 8), lastActive,
      lastShotUrl: shot ? shot.url : null,
      today: Math.round(today / 1000), yesterday: Math.round(yest / 1000),
      week: Math.round(week / 1000), month: Math.round(month / 1000),
      trustScore: trustScore == null ? 100 : trustScore,
      trustFlags: [...trustFlags],
    }
  }).sort((a, b) => b.lastActive - a.lastActive)
  res.json(rows)
})

// Per-day worked time + per-note breakdown for one agent (powers the agent's
// chart, today-total, and history list).
app.get('/api/time/daily', (req, res) => {
  const agentId = req.query.agentId
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const days = Math.min(Number(req.query.days) || 5, 31)
  const now = Date.now()
  const STALE_MS = 90_000
  const dayKey = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const segs = db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments WHERE agent_id = ?`).all(agentId)
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
    chart.push({ date: k, label: labels[new Date(k).getDay()], seconds: byDay.get(k)?.seconds || 0 })
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
app.get('/api/calendar', (req, res) => {
  const agentId = req.query.agentId
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const y = Number(req.query.year), m = Number(req.query.month) - 1 // month is 1-12
  const now = Date.now()
  const segs = db.prepare(`SELECT started_at, ended_at, seconds, open FROM work_segments WHERE agent_id = ?`).all(agentId)
  const intervals = segs.map((s) => segInterval(s, now))
  const ndays = new Date(y, m + 1, 0).getDate()
  const days = []
  let monthTotal = 0
  for (let d = 1; d <= ndays; d++) {
    const a = new Date(y, m, d).getTime(), b = a + 86400000
    let secs = 0
    for (const [st, en] of intervals) secs += overlap(st, en, a, b)
    secs = Math.round(secs / 1000)
    monthTotal += secs
    days.push({ day: d, date: a, seconds: secs })
  }
  res.json({ year: y, month: m + 1, days, monthTotal })
})

// Day detail: day/week/month totals, per-hour activity, and the day's screenshots.
app.get('/api/day', (req, res) => {
  const agentId = req.query.agentId
  if (!agentId) return res.status(400).json({ error: 'agentId required' })
  const [yy, mm, dd] = String(req.query.date || '').split('-').map(Number)
  const day = new Date(yy, mm - 1, dd)
  const dayStart = day.getTime(), dayEnd = dayStart + 86400000
  const dow = (day.getDay() + 6) % 7 // 0 = Monday
  const weekStart = dayStart - dow * 86400000, weekEnd = weekStart + 7 * 86400000
  const monStart = new Date(yy, mm - 1, 1).getTime(), monEnd = new Date(yy, mm, 1).getTime()
  const now = Date.now()

  const segs = db.prepare(`SELECT started_at, ended_at, seconds, open, note FROM work_segments WHERE agent_id = ?`).all(agentId)
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

  const shots = db.prepare(`
    SELECT id, captured_at AS capturedAt, active_app AS activeApp, activity_pct AS activityPct, '/uploads/' || file AS url
    FROM screenshots WHERE agent_id = ? AND captured_at >= ? AND captured_at < ?
    ORDER BY captured_at ASC
  `).all(agentId, dayStart, dayEnd)

  res.json({
    date: dayStart,
    dayTotal: Math.round(dayTotal / 1000),
    weekTotal: Math.round(weekTotal / 1000),
    monthTotal: Math.round(monthTotal / 1000),
    hours: hours.map((ms) => Math.round(ms / 1000)),
    notes,
    screenshots: shots,
  })
})

// List known agents with their latest activity.
app.get('/api/agents', (_req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.name, a.last_seen AS lastSeen,
           (SELECT COUNT(*) FROM screenshots s WHERE s.agent_id = a.id) AS shotCount
    FROM agents a ORDER BY a.last_seen DESC
  `).all()
  res.json(rows)
})

app.listen(PORT, () => {
  console.log(`Delegent server listening on http://localhost:${PORT}`)
})
