# Delegent — Screen Monitoring System

A self-contained, scrin.io-style monitoring system: a desktop **agent** captures
the screen on an interval and uploads it to a local **server**, which stores the
images and serves a live **dashboard**.

```
agent/   Electron desktop agent — captures the screen, uploads to the server
server/  Node + Express + SQLite backend + web dashboard (screenshots on disk)
```

## 1. Start the server
```bash
cd server
npm install
cp .env.example .env   # then fill in DATABASE_URL + R2_* (see below)
npm start              # http://localhost:4000  (dashboard + API)
```
Storage is cloud-based, all on **Supabase** (free tier): **Postgres** for data and
**Supabase Storage** for screenshot images. Configure it in `server/.env` (see
`server/.env.example`). The server creates its tables automatically on first start.

### Required environment (`server/.env`)
| Var | Where to get it |
|-----|-----------------|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (pooler, `:6543`) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` secret |
| `SUPABASE_BUCKET` | name of a **private** Storage bucket (e.g. `screenshots`) |

## Deploy (Render + Supabase)
1. Create a **Supabase** project → copy the Postgres pooler connection string, the
   Project URL + `service_role` key, and create a private Storage bucket.
2. Push to GitHub, then in **Render**: New + → **Blueprint** → pick the repo. It
   reads [`render.yaml`](render.yaml) and prompts for the secret env vars.
3. Point the desktop agent's **Server URL** at the Render URL and sign in.

## 2. Start the agent (on each machine to monitor)
```bash
cd agent
npm install
npm start
```
In the agent window: set the **Server URL** (default `http://localhost:4000`), a
**device name**, and an **interval**, then click **Start monitoring** (or
**Capture now** for a one-off). Watch them appear on the dashboard.

## Pipeline (this milestone)
`Agent` → `POST /api/screenshots` (base64 PNG + metadata) → server uploads the
image to R2 + writes a Postgres row → dashboard polls `GET /api/screenshots` and
renders the gallery (images served via R2 URLs).

## Roadmap (next milestones)
- Auth + manager/employee roles, employee invites, projects
- Time tracking (start/stop) + activity (active app / window title, idle detection)
- Reports & charts (per employee / project / day), CSV / Excel export
- Cloud storage + multi-tenant (swap SQLite→Postgres, disk→S3)
