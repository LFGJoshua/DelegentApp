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
npm start            # http://localhost:4000  (dashboard + API)
```
Screenshots are stored in `server/uploads/`, metadata in `server/data.sqlite`.

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
`Agent` → `POST /api/screenshots` (base64 PNG + metadata) → server writes file +
SQLite row → dashboard polls `GET /api/screenshots` and renders the gallery.

## Roadmap (next milestones)
- Auth + manager/employee roles, employee invites, projects
- Time tracking (start/stop) + activity (active app / window title, idle detection)
- Reports & charts (per employee / project / day), CSV / Excel export
- Cloud storage + multi-tenant (swap SQLite→Postgres, disk→S3)
