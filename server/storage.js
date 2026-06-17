// Screenshot images live in Supabase Storage (free tier, no card required).
// We talk to the Storage REST API directly with fetch (Node 18+ has global
// fetch) to avoid the supabase-js SDK pulling in a realtime/WebSocket dependency
// that needs Node 22. Uses the service-role key (server-side only); the bucket
// should be PRIVATE — we hand out short-lived signed URLs.
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET } = process.env
const bucket = SUPABASE_BUCKET || 'screenshots'
const base = SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') + '/storage/v1' : null

export const storageReady = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)

if (!storageReady) {
  console.error('\n⚠ Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env (see .env.example), and create a Storage bucket.\n')
}

// Send both `apikey` (required for the new sb_secret_* keys, which the gateway
// validates) and `Authorization: Bearer` (works for legacy service_role JWTs).
const authHeader = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY }
const obj = (key) => `${base}/object/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`

// Store a screenshot buffer under `key` (e.g. "<id>.png").
export async function putImage(key, buf) {
  if (!storageReady) throw new Error('storage not configured')
  const res = await fetch(obj(key), {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: buf,
  })
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

// A short-lived signed URL for a stored key (bucket stays private).
export async function imageUrl(key) {
  if (!key || !storageReady) return null
  const res = await fetch(`${base}/object/sign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  })
  if (!res.ok) return null
  const j = await res.json()
  return j.signedURL ? base + j.signedURL : null
}
