import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new Database(join(__dirname, 'data.sqlite'))

db.pragma('journal_mode = WAL')

// Minimal schema for the capture pipeline. Auth/projects/timesheets come later.
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    last_seen   INTEGER
  );

  CREATE TABLE IF NOT EXISTS screenshots (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    active_app  TEXT,
    file        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    activity_pct INTEGER          -- keyboard/mouse activity % during the interval
  );

  CREATE INDEX IF NOT EXISTS idx_shots_agent ON screenshots(agent_id);
  CREATE INDEX IF NOT EXISTS idx_shots_time  ON screenshots(captured_at);

  -- One row per continuous "working" period (a play→pause span). Paused time is
  -- simply the gap between segments, so total worked time = SUM(seconds).
  CREATE TABLE IF NOT EXISTS work_segments (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,            -- last heartbeat / stop time
    seconds     INTEGER DEFAULT 0,
    open        INTEGER NOT NULL DEFAULT 1,  -- 1 while the timer is running, 0 once paused/stopped
    note        TEXT                -- "what are you working on?" for this span
  );
  CREATE INDEX IF NOT EXISTS idx_seg_agent ON work_segments(agent_id);
  CREATE INDEX IF NOT EXISTS idx_seg_start ON work_segments(started_at);

  -- Admin settings (key/value JSON), e.g. which TrustScore signals are enabled.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`)

// Migration for databases created before the `open` column existed.
const segCols = db.prepare(`PRAGMA table_info(work_segments)`).all().map((c) => c.name)
if (!segCols.includes('open')) {
  db.exec(`ALTER TABLE work_segments ADD COLUMN open INTEGER NOT NULL DEFAULT 1`)
  db.exec(`UPDATE work_segments SET open = 0 WHERE ended_at IS NOT NULL`)
}
if (!segCols.includes('note')) {
  db.exec(`ALTER TABLE work_segments ADD COLUMN note TEXT`)
}
if (!segCols.includes('trust_score')) {
  db.exec(`ALTER TABLE work_segments ADD COLUMN trust_score INTEGER`)
  db.exec(`ALTER TABLE work_segments ADD COLUMN trust_flags TEXT`)
}
const shotCols = db.prepare(`PRAGMA table_info(screenshots)`).all().map((c) => c.name)
if (!shotCols.includes('activity_pct')) {
  db.exec(`ALTER TABLE screenshots ADD COLUMN activity_pct INTEGER`)
}

export default db
