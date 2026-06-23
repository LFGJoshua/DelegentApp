const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, Menu, nativeImage, powerMonitor } = require('electron')
const { join } = require('node:path')
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { autoUpdater } = require('electron-updater')
const trust = require('./trust.cjs')

// Check the update feed (configured via package.json "publish") and install new
// versions automatically. Only runs in the packaged/installed app, not in dev.
function setupAutoUpdate() {
  if (!app.isPackaged) return
  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', () => { autoUpdater.autoInstallOnAppQuit = true })
    autoUpdater.on('error', () => {})
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    // Re-check every 6 hours while running.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000)
  } catch {}
}

// Get the foreground window's app name. Used to label screenshots.
// Windows: Win32 GetForegroundWindow via PowerShell. macOS: AppleScript asks
// System Events for the frontmost app (needs Accessibility permission).
function getActiveApp() {
  if (process.platform === 'win32') {
    const ps = `Add-Type -Name U -Namespace Win -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);'
$h=[Win.U]::GetForegroundWindow(); $procId=0; [Win.U]::GetWindowThreadProcessId($h,[ref]$procId) | Out-Null
try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }`
    return new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const name = stdout.trim()
        resolve(name ? name.charAt(0).toUpperCase() + name.slice(1) : null)
      })
    })
  }
  if (process.platform === 'darwin') {
    const script = 'tell application "System Events" to get name of first application process whose frontmost is true'
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const name = stdout.trim()
        resolve(name || null)
      })
    })
  }
  return Promise.resolve(null)
}

let win = null
let tray = null
let captureTimer = null
let heartbeatTimer = null
let activityTimer = null
const ACTIVITY_SAMPLE_SEC = 8 // how often to check for input
const ACTIVITY_WINDOW = 8     // samples kept (~last 64s) for the rolling %

// Sample whether the user gave keyboard/mouse input recently, and keep a rolling
// activity percentage. powerMonitor.getSystemIdleTime() = seconds since last input.
function sampleActivity() {
  const idleSec = powerMonitor.getSystemIdleTime()
  state.activitySamples.push(idleSec < ACTIVITY_SAMPLE_SEC)
  while (state.activitySamples.length > ACTIVITY_WINDOW) state.activitySamples.shift()
  const active = state.activitySamples.filter(Boolean).length
  state.activityPct = Math.round((active / state.activitySamples.length) * 100)
  try {
    const t = trust.score(state.activityPct, state.enabledSignals)
    state.trustScore = t.trustScore; state.trustFlags = t.flags; state.trustLabel = t.label
    // Signal 6: on a NEW manipulation-app detection, alert the server (which emails admins).
    const fresh = (t.detectedApps || []).filter((a) => !state.reportedApps.has(a))
    if (fresh.length) { fresh.forEach((a) => state.reportedApps.add(a)); reportManipulation(fresh) }
  } catch {}
  pushStatus()
}

// Tell the server a manipulation app was detected so it can email an alert.
async function reportManipulation(apps) {
  try {
    await authFetch('/api/alert/manipulation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apps }),
    })
  } catch {}
}

// Timer / work-session state.
const state = {
  authed: false,      // is a user signed in?
  user: null,         // { id, email, name, role, userType }
  working: false,
  accumulatedMs: 0,   // completed run-time this session (sums across pauses)
  lastResumeAt: null, // when the current running stretch began
  segmentId: null,    // server segment for the current running stretch
  currentNote: '',    // "what are you working on?"
  shotCount: 0,
  recentShots: [],    // capture timestamps in the last hour (rolling cap guard)
  lastCaptureAt: null,
  lastError: null,
  activitySamples: [], // rolling window of recent active/idle samples
  activityPct: 0,      // % of recent samples with keyboard/mouse input
  trustScore: 100,     // 0-100 behavioral trust (jiggler etc.)
  trustFlags: [],      // flagged suspicious events
  trustLabel: 'Trusted',
  lastHash: null,      // previous screenshot perceptual hash (Signal 4)
  enabledSignals: { jiggler: true, fakeTyping: true, cycling: true, stale: true, mismatch: true, appDetect: true },
  screenshotPreview: false, // show a preview popup on each capture (admin setting)
  watchlist: [],            // manipulation-app process names to detect (Signal 6)
  reportedApps: new Set(),  // apps already alerted this session (avoid duplicate emails)
}

// Pull the signed-in user's signal profile from the server. The server resolves
// it from the account's admin-assigned user_type, so role/type changes apply
// without reconfiguring the agent.
async function fetchSettings() {
  if (!config.token) return
  try {
    const res = await authFetch('/api/my-signals')
    if (res.ok) {
      const j = await res.json()
      if (j.signals) state.enabledSignals = j.signals
      if (j.userType) config.userType = j.userType
      state.screenshotPreview = !!j.screenshotPreview
      if (Array.isArray(j.watchlist)) state.watchlist = j.watchlist
    }
  } catch {}
}

// Perceptual hash (dHash) of a screenshot, computed on-device for stale-screen
// detection — the raw frame is never sent anywhere for comparison.
function frameHash(img) {
  const small = img.resize({ width: 9, height: 8, quality: 'good' })
  const bmp = small.toBitmap() // BGRA
  const w = 9, h = 8, bits = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4, j = (y * w + x + 1) * 4
      const g1 = 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i]
      const g2 = 0.299 * bmp[j + 2] + 0.587 * bmp[j + 1] + 0.114 * bmp[j]
      bits.push(g1 < g2 ? 1 : 0)
    }
  }
  return bits
}
function hammingBits(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d }

function sessionMs() {
  return state.accumulatedMs + (state.working && state.lastResumeAt ? Date.now() - state.lastResumeAt : 0)
}

// ---- Config persistence ----
function configPath() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'delegent-agent.json')
}
function loadConfig() {
  try { if (existsSync(configPath())) return JSON.parse(readFileSync(configPath(), 'utf-8')) } catch {}
  return {}
}
function saveConfig() { writeFileSync(configPath(), JSON.stringify(config, null, 2)) }

let config = {
  agentId: null,
  agentName: '',
  serverUrl: 'https://delegent-server.onrender.com',
  intervalSec: 60,       // legacy; capture timing is now randomized (see shotsPerHour)
  shotsPerHour: 30,      // target captures/hour, randomly spread; hard-capped at 30
  autoStart: true,  // start capturing automatically on launch
  userType: 'Default', // which signal profile applies (Developer, Virtual Assistant, …)
  token: null,         // login session token (Bearer) for the signed-in account
  ...loadConfig(),
}

const serverBase = () => config.serverUrl.replace(/\/$/, '')

// Authenticated fetch: attaches the Bearer token and, on a 401, treats the
// session as gone — stops tracking and drops the user back to the login screen.
async function authFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (config.token) headers.Authorization = 'Bearer ' + config.token
  const res = await fetch(serverBase() + path, { ...opts, headers })
  if (res.status === 401) { await handleAuthFailure(); throw new Error('unauthorized') }
  return res
}

async function handleAuthFailure() {
  if (state.working) await pause()
  config.token = null; saveConfig()
  state.authed = false; state.user = null
  if (win && !win.isDestroyed()) { win.show(); win.focus() }
  pushStatus()
}

// ---- Authentication ----
// On successful login/register: persist the token, adopt the account's identity
// (the agent's agentId IS the user id) and start tracking.
async function applyAuth(user, token) {
  config.token = token
  config.agentId = user.id
  config.agentName = user.name || config.agentName
  config.userType = user.userType || 'Default'
  saveConfig()
  state.authed = true
  state.user = user
  state.lastError = null
  await fetchSettings()
  if (config.autoStart && !state.working) play()
  pushStatus()
}

async function doLogin(email, password) {
  try {
    const res = await fetch(serverBase() + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'login failed' }
    await applyAuth(data.user, data.token)
    return { ok: true, user: data.user }
  } catch { return { ok: false, error: 'cannot reach server at ' + config.serverUrl } }
}

async function doRegister(name, email, password, company) {
  try {
    const res = await fetch(serverBase() + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, company }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'registration failed' }
    await applyAuth(data.user, data.token)
    return { ok: true, user: data.user }
  } catch { return { ok: false, error: 'cannot reach server at ' + config.serverUrl } }
}

async function doLogout() {
  try { await authFetch('/api/auth/logout', { method: 'POST' }) } catch {}
  if (state.working) await pause()
  config.token = null; saveConfig()
  state.authed = false; state.user = null
  pushStatus()
  return { ok: true }
}

// On launch, validate any stored token so we either resume the session or show login.
async function checkAuth() {
  if (!config.token) { state.authed = false; return }
  try {
    const res = await fetch(serverBase() + '/api/auth/me', { headers: { Authorization: 'Bearer ' + config.token } })
    if (res.ok) {
      const { user } = await res.json()
      state.authed = true; state.user = user
      config.agentId = user.id
      config.agentName = user.name || config.agentName
      config.userType = user.userType || config.userType
      saveConfig()
      await fetchSettings()
    } else {
      config.token = null; saveConfig(); state.authed = false
    }
  } catch { state.authed = false } // server unreachable — show login, keep token
}

function pushStatus() {
  const payload = { ...state, sessionMs: sessionMs(), config, appVersion: app.getVersion() }
  if (win && !win.isDestroyed()) win.webContents.send('status', payload)
  updateTray()
}

// ---- Screen capture (only runs while the timer is working) ----
const MAX_SHOTS_PER_HOUR = 30

// Number of captures to spread across each hour. Honors config but never
// exceeds the hard cap of 30/hour per user.
function shotsPerHour() {
  const v = Number(config.shotsPerHour) || MAX_SHOTS_PER_HOUR
  return Math.min(MAX_SHOTS_PER_HOUR, Math.max(1, Math.round(v)))
}

// ---- Randomized capture scheduler ----
// The hour is divided into N equal slots (N = shotsPerHour). Exactly one capture
// fires per slot, at a uniformly random instant within it. This guarantees:
//   • at most N (≤30) captures in any rolling hour      (max-per-hour cap)
//   • one per slot -> evenly distributed across the hour (no clustering)
//   • a random offset each slot -> no fixed cadence      (unpredictable timing)
// The random instant is kept off the slot edges so captures in adjacent slots
// can't bunch back-to-back (protects performance/storage).
let captureAnchor = 0 // slot-grid origin (set when tracking starts)
let nextSlot = 0      // index of the next slot to fire

function armCaptureSchedule() {
  if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
  captureAnchor = Date.now()
  nextSlot = 0
  scheduleNextCapture()
}

function scheduleNextCapture() {
  if (!state.working) return
  const slotMs = 3600000 / shotsPerHour()
  const lo = slotMs * 0.1, hi = slotMs * 0.9 // jitter window inside the slot
  let delay
  do {
    const slotStart = captureAnchor + nextSlot * slotMs
    delay = (slotStart + lo + Math.random() * (hi - lo)) - Date.now()
    nextSlot++
  } while (delay < 0) // skip past any slots already elapsed (e.g. sleep/wake)
  captureTimer = setTimeout(() => { captureAndUpload(); scheduleNextCapture() }, delay)
}

async function captureAndUpload() {
  if (!state.working) return
  // Hard guard: never exceed MAX_SHOTS_PER_HOUR in any rolling 60-minute window,
  // regardless of play/pause churn or schedule drift.
  const hourAgo = Date.now() - 3600000
  state.recentShots = state.recentShots.filter(t => t > hourAgo)
  if (state.recentShots.length >= MAX_SHOTS_PER_HOUR) { pushStatus(); return }
  try {
    const display = screen.getPrimaryDisplay()
    const sf = display.scaleFactor || 1
    const width = Math.round(display.size.width * sf)
    const height = Math.round(display.size.height * sf)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    if (!sources.length) throw new Error('no screen source')
    const dataUrl = 'data:image/png;base64,' + sources[0].thumbnail.toPNG().toString('base64')
    // Signal 4: compare this frame to the previous one (perceptual hash).
    try {
      const h = frameHash(sources[0].thumbnail)
      if (state.lastHash) trust.noteFrame(hammingBits(state.lastHash, h))
      state.lastHash = h
    } catch {}
    const activeApp = await getActiveApp()

    const res = await authFetch('/api/screenshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capturedAt: Date.now(), image: dataUrl, width, height, activeApp,
        activityPct: state.activityPct,
      }),
    })
    if (!res.ok) throw new Error('upload ' + res.status)
    state.shotCount++
    state.recentShots.push(Date.now())
    state.lastCaptureAt = Date.now()
    state.lastError = null
    if (state.screenshotPreview) showScreenshotPreview(dataUrl)
  } catch (err) {
    state.lastError = String(err.message || err)
  }
  pushStatus()
}

// ---- Time-tracking heartbeat (keeps the dashboard's worked-time live) ----
async function sendHeartbeat() {
  if (!state.working || !state.segmentId) return
  fetchSettings() // refresh admin toggles (~every 15s)
  try {
    await authFetch('/api/time/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segmentId: state.segmentId,
        seconds: Math.round((Date.now() - state.lastResumeAt) / 1000),
        trustScore: state.trustScore, trustFlags: state.trustFlags,
      }),
    })
  } catch {}
}

// ---- Play / Pause ----
async function play(note) {
  if (state.working) return
  if (!state.authed) { state.lastError = 'please sign in first'; pushStatus(); return }
  if (note != null) state.currentNote = note
  state.working = true
  state.lastResumeAt = Date.now()
  state.lastError = null

  // Open a server work segment.
  try {
    const res = await authFetch('/api/time/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startedAt: state.lastResumeAt, note: state.currentNote || null }),
    })
    state.segmentId = (await res.json()).segmentId
  } catch (err) { state.lastError = 'server unreachable: ' + (err.message || err) }

  captureAndUpload() // capture immediately on play
  armCaptureSchedule() // then randomized, evenly-spread captures
  heartbeatTimer = setInterval(sendHeartbeat, 15000)
  sampleActivity() // first activity reading right away
  activityTimer = setInterval(sampleActivity, ACTIVITY_SAMPLE_SEC * 1000)
  await fetchSettings() // honor admin signal toggles
  state.reportedApps = new Set()
  trust.start(getActiveApp, state.enabledSignals, state.watchlist) // behavioral detection on the desktop
  pushStatus()
}

async function pause() {
  if (!state.working) return
  const ranMs = Date.now() - state.lastResumeAt
  state.accumulatedMs += ranMs
  state.working = false

  if (captureTimer) { clearTimeout(captureTimer); captureTimer = null }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null }
  trust.stop()
  state.activitySamples = []
  state.activityPct = 0
  state.trustScore = 100
  state.trustFlags = []

  // Finalize the server segment.
  if (state.segmentId) {
    try {
      await authFetch('/api/time/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentId: state.segmentId, seconds: Math.round(ranMs / 1000), endedAt: Date.now() }),
      })
    } catch {}
    state.segmentId = null
  }
  state.lastResumeAt = null
  pushStatus()
}

// ---- Tray (background mode) ----
function fmtClock(ms) {
  const s = Math.floor(ms / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
function updateTray() {
  if (!tray) return
  const label = state.working ? `Working — ${fmtClock(sessionMs())}` : 'Paused'
  tray.setToolTip(`Delegent · ${label}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: state.working ? 'Pause' : 'Play', click: () => (state.working ? pause() : play()) },
    { label: 'Show window', click: () => { if (win) { win.show(); win.focus() } } },
    { type: 'separator' },
    { label: 'Quit Delegent', click: () => { app.isQuitting = true; app.quit() } },
  ]))
}
function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'tray.png'))
  tray = new Tray(icon)
  tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : (win.show(), win.focus()) } })
  updateTray()
}

// ---- IPC ----
ipcMain.handle('get-state', () => ({ ...state, sessionMs: sessionMs(), config, appVersion: app.getVersion() }))
ipcMain.handle('auth-login', (_e, { email, password } = {}) => doLogin(email, password))
ipcMain.handle('auth-register', (_e, { name, email, password, company } = {}) => doRegister(name, email, password, company))
ipcMain.handle('auth-logout', () => doLogout())
// Request a password-reset email (unauthenticated). The reset link in the email
// opens the web /reset page in the browser.
ipcMain.handle('auth-forgot', async (_e, { email } = {}) => {
  try {
    await fetch(serverBase() + '/api/auth/forgot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })
    return { ok: true }
  } catch { return { ok: false } }
})
// Size the window to exactly fit the rendered content (no scroll), clamped to
// the screen. The renderer measures its view and calls this on every layout change.
ipcMain.handle('fit-window', (_e, h) => {
  if (!win || win.isDestroyed()) return
  const [w] = win.getContentSize()
  const maxH = (screen.getPrimaryDisplay().workAreaSize.height || 900) - 60
  win.setContentSize(w, Math.max(140, Math.min(Math.round(h) + 2, maxH)))
})
// The renderer can't hold the token, so it asks the main process for its data.
ipcMain.handle('time-daily', async () => {
  if (!config.token) return null
  try {
    const tz = -new Date().getTimezoneOffset() // minutes east of UTC
    const res = await authFetch(`/api/time/daily?agentId=${encodeURIComponent(config.agentId)}&days=5&tz=${tz}`)
    return res.ok ? await res.json() : null
  } catch { return null }
})
ipcMain.handle('play', (_e, note) => play(note))
ipcMain.handle('pause', () => pause())
ipcMain.handle('set-note', async (_e, note) => {
  state.currentNote = note
  if (state.working && state.segmentId) {
    try {
      await authFetch('/api/time/note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentId: state.segmentId, note }),
      })
    } catch {}
  }
  pushStatus()
  return true
})
ipcMain.handle('set-config', (_e, patch) => {
  config = { ...config, ...patch }; saveConfig()
  if (state.working) armCaptureSchedule() // re-arm randomized schedule if rate changed
  pushStatus(); return config
})

const COMPACT_H = 260, EXPANDED_H = 820
// Screenshot-preview toast: a small frameless popup at the bottom-right that
// shows the just-captured screenshot for a few seconds (admin-enabled).
let previewWin = null, previewTimer = null
function showScreenshotPreview(dataUrl) {
  try {
    const W = 300, H = 196, M = 16
    const wa = screen.getPrimaryDisplay().workArea
    const x = wa.x + wa.width - W - M, y = wa.y + wa.height - H - M
    if (!previewWin || previewWin.isDestroyed()) {
      previewWin = new BrowserWindow({
        width: W, height: H, x, y, frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
        webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
      })
      previewWin.loadFile(join(__dirname, '..', 'renderer', 'preview.html'))
    } else {
      previewWin.setBounds({ x, y, width: W, height: H })
    }
    const send = () => { try { previewWin.webContents.send('preview-image', dataUrl) } catch {} }
    if (previewWin.webContents.isLoading()) previewWin.webContents.once('did-finish-load', send)
    else send()
    previewWin.showInactive()
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => { if (previewWin && !previewWin.isDestroyed()) previewWin.hide() }, 4500)
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 420, height: COMPACT_H, minWidth: 420, resizable: true,
    backgroundColor: '#08110f', title: 'Delegent', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  })
  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  // Closing the window hides to tray instead of quitting (background mode).
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide() }
  })
}

// Prevent a second instance — the agent should run once in the background.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
}

app.whenReady().then(async () => {
  createWindow()
  createTray()
  setupAutoUpdate()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

  // Resume a saved session if the token is still valid, then auto-start tracking.
  // If not signed in, surface the window so the user can log in.
  await checkAuth()
  if (state.authed) { if (config.autoStart) play() }
  else if (win) { win.show(); win.focus() }
  pushStatus()

  // Test/CI hook: play for a few seconds (capturing), then pause and quit. Off by default.
  if (process.env.DELEGENT_AUTOTEST) {
    setTimeout(async () => {
      console.log('AUTOTEST: play')
      await play()
      setTimeout(async () => {
        await captureAndUpload() // a second capture to prove the interval path
        console.log('AUTOTEST: pause, shots=', state.shotCount, 'sessionMs=', sessionMs())
        await pause()
        app.isQuitting = true
        setTimeout(() => app.quit(), 500)
      }, 4000)
    }, 1200)
  }
})

// Keep running in the tray even when all windows are closed.
app.on('window-all-closed', () => {})

// Finalize an open segment on quit.
app.on('before-quit', () => { if (state.working) pause() })
