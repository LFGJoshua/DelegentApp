// TrustScore engine — Signal 1: Mouse Jiggler Detection.
//
// All analysis runs HERE on the desktop. Only the resulting TrustScore (0–100)
// and flagged events are ever sent to the server — never the raw mouse track.
//
// Jiggler tells:
//   - Constant speed: real mice vary a lot; jigglers hold near-constant speed (low CV).
//   - Circular / repetitive paths: looping movement around a point.
//   - The killer tell: mouse moves continuously but ZERO clicks, ZERO keystrokes,
//     ZERO window switches.
//
// Built with Electron built-ins only (screen.getCursorScreenPoint + powerMonitor),
// so no native modules are required. Ports cleanly to a Rust native module later.

const { screen, powerMonitor } = require('electron')
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const WINDOW_MS = 60_000   // rolling analysis window (mouse/keyboard)
const WINDOW5_MS = 300_000 // 5-minute window for tab-cycling analysis
const SAMPLE_MS = 200      // cursor sample cadence

let sampleTimer = null, appTimer = null, getApp = null
let samples = []
let lastPos = null, lastMoveTime = 0
let hadNonMouseInput = false, nonMouseCount = 0
let windowSwitches = 0, lastApp = null

// Signal 3: window-switch event log (last 5 min) for tab-cycling detection.
let windowEvents = []
// Signal 4: consecutive near-identical screenshots (stale screen).
let consecutiveStale = 0

// Signal 2: keystroke timing. We store ONLY {time, isBackspace} per key — never
// which key was pressed — so no text is ever captured or transmitted.
let kbProc = null
let keystrokes = []
const VK_BACK = 8, VK_DELETE = 46

// Signal 6: third-party activity-manipulation apps running on the machine.
// We scan running PROCESS NAMES only (never command-line args / window titles)
// and match them against a watchlist. Only matched app names are ever reported.
let procTimer = null
let watchlist = []        // admin-configurable name fragments (falls back to defaults)
let detectedApps = []     // [{ name, term }] matched this scan
const DEFAULT_WATCHLIST = [
  // Mouse jigglers / movers
  'mousejiggler', 'move mouse', 'movemouse', 'jiggler', 'automousemover', 'mouse mover', 'wigglemouse', 'mousewiggle',
  // Auto-clickers
  'autoclicker', 'auto clicker', 'opautoclicker', 'gs auto clicker', 'gsautoclicker', 'clickermann', 'free auto clicker',
  // Macro / automation tools
  'autohotkey', 'autoit', 'tinytask', 'pulover', 'macro recorder', 'macrorecorder', 'jitbit', 'axife',
]
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
function matchWatch(procName, list) {
  const np = norm(procName)
  if (!np) return null
  for (const w of list) { const nw = norm(w); if (nw && np.includes(nw)) return w }
  return null
}
// Scan running processes (cross-platform), match against the watchlist, and
// update `detectedApps`. All async; score() reads the latest result synchronously.
function scanProcs() {
  const list = watchlist.length ? watchlist : DEFAULT_WATCHLIST
  const onNames = (names) => {
    const hits = new Map()
    for (const n of names) { const term = matchWatch(n, list); if (term && !hits.has(n)) hits.set(n, term) }
    detectedApps = [...hits].map(([name, term]) => ({ name, term }))
  }
  const run = (cmd, args, parse, onErr) => {
    try {
      const p = spawn(cmd, args, { windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => { out += d.toString() })
      p.on('close', () => { try { onNames(parse(out)) } catch {} })
      p.on('error', () => { if (onErr) onErr() })
    } catch { if (onErr) onErr() }
  }
  if (process.platform === 'win32') {
    // CSV: "Image Name","PID",... → first quoted field is the executable name.
    run('tasklist', ['/fo', 'csv', '/nh'], (out) =>
      out.split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean))
  } else {
    // macOS/BSD: `ps -axco comm`. Linux fallback: `ps -A -o comm=`.
    run('ps', ['-axco', 'comm'], (out) => out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      () => run('ps', ['-A', '-o', 'comm='], (out) => out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)))
  }
}

function reset() {
  samples = []; lastPos = null; lastMoveTime = Date.now()
  hadNonMouseInput = false; nonMouseCount = 0; windowSwitches = 0; lastApp = null
  keystrokes = []
  windowEvents = []; consecutiveStale = 0
  detectedApps = []
}

// Signal 4 input: main process reports the Hamming distance between consecutive
// screenshot perceptual-hashes. 5+ near-identical in a row = stale screen.
function noteFrame(distance) {
  if (distance < 5) consecutiveStale++
  else consecutiveStale = 0
}

// Detect a short repeating cycle (period 2–4) at the tail of an app sequence.
function detectRepeating(seq) {
  const n = seq.length
  for (let p = 2; p <= 4; p++) {
    if (n < p * 2) continue
    let ok = true
    for (let i = n - p; i < n; i++) if (seq[i] !== seq[i - p]) { ok = false; break }
    if (ok) return true
  }
  return false
}

function startKeyboard() {
  if (process.platform !== 'win32' || kbProc) return
  try {
    kbProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'keyhook.ps1')], { windowsHide: true })
    kbProc.stdout.on('data', (buf) => {
      for (const ln of buf.toString().split(/\r?\n/)) {
        const vk = parseInt(ln.trim(), 10)
        if (Number.isNaN(vk)) continue
        keystrokes.push({ t: Date.now(), bs: vk === VK_BACK || vk === VK_DELETE })
        const cutoff = Date.now() - WINDOW_MS
        while (keystrokes.length && keystrokes[0].t < cutoff) keystrokes.shift()
      }
    })
    kbProc.on('error', () => { kbProc = null })
  } catch { kbProc = null }
}
function stopKeyboard() {
  if (kbProc) { try { kbProc.kill() } catch {} kbProc = null }
  keystrokes = []
}

function tick() {
  let p
  try { p = screen.getCursorScreenPoint() } catch { return }
  const idle = powerMonitor.getSystemIdleTime() // seconds since last input of ANY kind
  const now = Date.now()
  const moved = lastPos ? (p.x !== lastPos.x || p.y !== lastPos.y) : false
  if (moved) lastMoveTime = now
  const stationaryFor = now - lastMoveTime
  // Non-mouse input (keyboard/click): there was input within the last second
  // (idle<=1) while the cursor has been stationary >1.5s — so it wasn't a move.
  if (!moved && idle <= 1 && stationaryFor > 1500) { hadNonMouseInput = true; nonMouseCount++ }
  samples.push({ x: p.x, y: p.y, t: now, moved })
  const cutoff = now - WINDOW_MS
  while (samples.length && samples[0].t < cutoff) samples.shift()
  lastPos = p
}

async function appTick() {
  if (!getApp) return
  try {
    const app = await getApp()
    if (app && app !== lastApp) {
      if (lastApp !== null) { windowSwitches++; windowEvents.push({ t: Date.now(), app }) }
      lastApp = app
      const cutoff = Date.now() - WINDOW5_MS
      while (windowEvents.length && windowEvents[0].t < cutoff) windowEvents.shift()
    }
  } catch {}
}

const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
const stddev = (a, m) => a.length < 2 ? 0 : Math.sqrt(avg(a.map((v) => (v - m) ** 2)))

function analyze() {
  const moves = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    const dx = b.x - a.x, dy = b.y - a.y, dt = (b.t - a.t) / 1000, dist = Math.hypot(dx, dy)
    if (dist > 0 && dt > 0) moves.push(dist / dt)
  }
  const movingFraction = samples.length ? moves.length / samples.length : 0
  const sMean = avg(moves)
  const speedCV = sMean > 0 ? stddev(moves, sMean) / sMean : 1

  // Circularity: radius coefficient-of-variation around the centroid of moving points.
  const pts = samples.filter((s) => s.moved)
  let radiusCV = 1, circular = false
  if (pts.length > 20) {
    const cx = avg(pts.map((p) => p.x)), cy = avg(pts.map((p) => p.y))
    const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy))
    const rMean = avg(radii)
    radiusCV = rMean > 0 ? stddev(radii, rMean) / rMean : 1
    circular = radiusCV < 0.20 && rMean > 12
  }

  // Signal 2: keystroke timing (intervals, variability, backspaces, pauses).
  const kbCount = keystrokes.length
  let kbCV = 1, backspaces = 0, maxPauseMs = 0
  if (kbCount >= 2) {
    const iv = []
    for (let i = 1; i < keystrokes.length; i++) iv.push(keystrokes[i].t - keystrokes[i - 1].t)
    const m = avg(iv)
    kbCV = m > 0 ? stddev(iv, m) / m : 1
    maxPauseMs = Math.max(...iv)
    backspaces = keystrokes.filter((k) => k.bs).length
  }

  // Signal 3: tab cycling over the last 5 minutes.
  const now = Date.now()
  const ev = windowEvents.filter((e) => e.t > now - WINDOW5_MS)
  const switches5min = ev.length
  const distinctApps5min = new Set(ev.map((e) => e.app)).size
  let avgDwellSec = Infinity
  if (ev.length >= 2) avgDwellSec = ((ev[ev.length - 1].t - ev[0].t) / 1000) / ev.length
  const repeatingSeq = detectRepeating(ev.map((e) => e.app))

  return {
    samples: samples.length, moves: moves.length, movingFraction,
    speedCV, radiusCV, circular, hadNonMouseInput, nonMouseCount, windowSwitches,
    kbCount, kbCV, backspaces, maxPauseMs,
    switches5min, distinctApps5min, avgDwellSec, repeatingSeq, consecutiveStale,
  }
}

const SIGNAL_THRESHOLD = 40 // a signal counts as "triggered" at/above this suspicion
const clamp100 = (v) => Math.max(0, Math.min(100, v))

function band(score) {
  if (score >= 85) return { label: 'Trusted', color: 'green' }
  if (score >= 70) return { label: 'Normal', color: 'green' }
  if (score >= 50) return { label: 'Suspicious', color: 'yellow' }
  if (score >= 25) return { label: 'Flagged', color: 'orange' }
  return { label: 'Manipulating', color: 'red' }
}

// Each signal yields a 0–100 suspicion score. TrustScore = 100 - raw_suspicion,
// where raw_suspicion = max(signals), boosted 1.3x if 2+ signals are triggered.
// @param activityPct system-reported input activity (for the Signal 5 meta-check)
function score(activityPct = 0, enabled) {
  const m = analyze()
  const flags = []
  const en = { jiggler: true, fakeTyping: true, cycling: true, stale: true, mismatch: true, appDetect: true, ...(enabled || {}) }

  // Signal 1: Mouse jiggler.
  let jiggler = 0
  if (en.jiggler && m.moves >= 25 && m.movingFraction > 0.4) {
    if (m.speedCV < 0.15) { jiggler += 50; flags.push(`Constant mouse speed (CV ${m.speedCV.toFixed(2)})`) }
    if (m.circular) { jiggler += 25; flags.push('Circular / looping mouse path') }
    if (!m.hadNonMouseInput && m.windowSwitches === 0) { jiggler += 50; flags.push('Continuous mouse movement with zero clicks, keystrokes, or window switches') }
  }
  jiggler = clamp100(jiggler)

  // Signal 2: Fake keyboard activity.
  let fakeTyping = 0
  if (en.fakeTyping && m.kbCount >= 20) {
    if (m.kbCV < 0.10) { fakeTyping += 50; flags.push(`Robotic keystroke timing (CV ${m.kbCV.toFixed(2)})`) }
    if (m.backspaces === 0) { fakeTyping += 30; flags.push(`No backspaces/corrections in ${m.kbCount} keystrokes`) }
    if (m.maxPauseMs < 2000) { fakeTyping += 30; flags.push('No natural typing pauses (> 2s)') }
  }
  fakeTyping = clamp100(fakeTyping)

  // Signal 3: Tab cycling / fake multitasking.
  let cycling = 0
  if (en.cycling && m.switches5min >= 20 && m.distinctApps5min <= 5 && m.avgDwellSec < 8) {
    cycling += 60; flags.push(`Rapid window cycling (${m.switches5min} switches/5min across ${m.distinctApps5min} apps, ~${m.avgDwellSec.toFixed(0)}s each)`)
    if (m.repeatingSeq) { cycling += 40; flags.push('Repeating app-switch sequence') }
  }
  cycling = clamp100(cycling)

  // Signal 4: Stale screen (perceptual-hash similarity).
  let stale = 0
  if (en.stale && m.consecutiveStale >= 5) {
    stale = clamp100(50 + (m.consecutiveStale - 5) * 10)
    flags.push(`Stale screen: ${m.consecutiveStale} near-identical screenshots in a row`)
  }

  // Signal 5: Input-activity mismatch (meta-signal) — system shows activity but
  // there is no real output (static screen + ~no keyboard + no genuine switching).
  let mismatch = 0
  const noKeyboard = m.kbCount < 5
  const staticScreen = m.consecutiveStale >= 5
  if (en.mismatch && activityPct >= 50 && staticScreen && noKeyboard && m.switches5min < 2) {
    mismatch = clamp100(60 + (activityPct - 50)) // higher reported activity = more suspicious
    flags.push('Input-activity mismatch: reported activity with a static screen and no real output')
  }

  // Signal 6: third-party activity-manipulation app running (process watchlist).
  let appDetect = 0
  if (en.appDetect && detectedApps.length) {
    appDetect = 100 // a known manipulation tool running is definitive
    for (const a of detectedApps) flags.push(`Activity-manipulation app detected: ${a.name}`)
  }

  const signals = { jiggler, fakeTyping, cycling, stale, mismatch, appDetect }
  let raw = Math.max(jiggler, fakeTyping, cycling, stale, mismatch, appDetect)
  const triggered = Object.values(signals).filter((v) => v > SIGNAL_THRESHOLD).length
  if (triggered >= 2) raw = Math.min(100, raw * 1.3) // corroborating signals amplify

  const trustScore = clamp100(Math.round(100 - raw))
  return { trustScore, ...band(trustScore), flags, signals, metrics: m, detectedApps: detectedApps.map((a) => a.name) }
}

function start(getActiveAppFn, enabled, watch) {
  reset()
  getApp = getActiveAppFn || null
  watchlist = Array.isArray(watch) && watch.length ? watch : DEFAULT_WATCHLIST
  sampleTimer = setInterval(tick, SAMPLE_MS)
  if (getApp) appTimer = setInterval(appTick, 5000)
  // Only run the keyboard hook if the fake-keyboard signal is enabled (privacy).
  if (!enabled || enabled.fakeTyping !== false) startKeyboard()
  // Process watchlist scan (Signal 6).
  if (!enabled || enabled.appDetect !== false) { scanProcs(); procTimer = setInterval(scanProcs, 20000) }
}
function stop() {
  if (sampleTimer) clearInterval(sampleTimer); sampleTimer = null
  if (appTimer) clearInterval(appTimer); appTimer = null
  if (procTimer) clearInterval(procTimer); procTimer = null
  detectedApps = []
  stopKeyboard()
}

module.exports = { start, stop, reset, score, noteFrame }
