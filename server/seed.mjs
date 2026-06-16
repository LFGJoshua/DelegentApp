// Dev helper: seed a few days of sample work segments (with notes) so the
// agent's chart + history view has data to show. Usage: node seed.mjs <agentId>
import db from './db.js'
import { randomUUID } from 'node:crypto'

const agentId = process.argv[2]
if (!agentId) { console.error('usage: node seed.mjs <agentId>'); process.exit(1) }

// Start clean for this agent so re-seeding is idempotent.
db.prepare(`DELETE FROM work_segments WHERE agent_id = ?`).run(agentId)

// Make sure the agent is registered so the dashboard can list it.
db.prepare(`INSERT INTO agents (id, name, last_seen) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`)
  .run(agentId, process.argv[3] || 'BatchiGuest', Date.now())

const DAY = 86400000
function seg(daysAgo, secs, note, startHour = 9) {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const base = d.getTime() - daysAgo * DAY + startHour * 3600000
  db.prepare(`INSERT INTO work_segments (id, agent_id, started_at, ended_at, seconds, open, note)
              VALUES (?,?,?,?,?,0,?)`).run(randomUUID(), agentId, base, base + secs * 1000, secs, note)
}

// A tidy Thu–Mon history like the reference (Sun left empty on purpose).
seg(4, 8 * 3600 + 21 * 60, 'Building dashboard')  // Thu
seg(3, 7 * 3600 + 35 * 60, 'Client onboarding')   // Fri
seg(2, 5 * 3600 + 38 * 60, 'Code review')         // Sat
seg(0, 2 * 3600 + 4 * 60, null)                   // today (Mon) — "No note"

console.log('Seeded sample history for', agentId)
process.exit(0)
