import pg from 'pg'

// Timestamps are stored as BIGINT (ms epoch) and counts come back as int8. By
// default node-postgres returns BIGINT as a string, which breaks all our time
// math and `=== 0` count checks — parse int8 as a JS number (ms epochs and our
// counts are well within Number's safe range).
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)))

if (!process.env.DATABASE_URL) {
  console.error('\n⚠ DATABASE_URL is not set. Create a .env in server/ (see .env.example) with your Supabase connection string.\n')
}

// Supabase (and most hosted Postgres) require TLS. Set PGSSL=disable for a local
// Postgres without TLS.
const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 8 })

// A tiny better-sqlite3-style wrapper over node-postgres so the call sites read
// the same (prepare().run/get/all) — except they're async, so callers `await`.
// Supports both positional `?` and named `@name` placeholders, translating them
// to Postgres `$1, $2, …`.
function prepare(text) {
  const named = /@[a-zA-Z_]/.test(text)
  function build(args) {
    if (named) {
      const obj = args[0] || {}
      const order = []
      const sql = text.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => { order.push(name); return '$' + order.length })
      return { sql, vals: order.map((n) => (obj[n] === undefined ? null : obj[n])) }
    }
    let i = 0
    const sql = text.replace(/\?/g, () => '$' + (++i))
    return { sql, vals: args }
  }
  return {
    async run(...args) { const { sql, vals } = build(args); const r = await pool.query(sql, vals); return { changes: r.rowCount } },
    async get(...args) { const { sql, vals } = build(args); const r = await pool.query(sql, vals); return r.rows[0] },
    async all(...args) { const { sql, vals } = build(args); const r = await pool.query(sql, vals); return r.rows },
  }
}

// Create the schema. Called once at startup before the server starts listening.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      pass_hash   TEXT NOT NULL,
      pass_salt   TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'employee',
      user_type   TEXT NOT NULL DEFAULT 'Default',
      company     TEXT,
      created_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS agents (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      last_seen   BIGINT,
      user_id     TEXT
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      captured_at  BIGINT NOT NULL,
      received_at  BIGINT NOT NULL,
      active_app   TEXT,
      file         TEXT NOT NULL,        -- object-storage key (e.g. <id>.png)
      width        INTEGER,
      height       INTEGER,
      activity_pct INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shots_agent ON screenshots(agent_id);
    CREATE INDEX IF NOT EXISTS idx_shots_time  ON screenshots(captured_at);

    CREATE TABLE IF NOT EXISTS work_segments (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      started_at  BIGINT NOT NULL,
      ended_at    BIGINT,
      seconds     INTEGER DEFAULT 0,
      open        INTEGER NOT NULL DEFAULT 1,
      note        TEXT,
      trust_score INTEGER,
      trust_flags TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seg_agent ON work_segments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_seg_start ON work_segments(started_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  BIGINT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

    -- Migrations for existing databases (idempotent).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT;
  `)
}

export default { prepare, init, pool }
