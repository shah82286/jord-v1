# JORD Golf — System Understanding

> This document is a living reference. Update it whenever a significant feature is added, changed, or removed. The goal: anyone (or Claude) reading this can understand the full system without digging through the code.

**Current Version:** 3.0.0  
**Last Updated:** May 2026

---

## 1. What Is JORD?

JORD is a web-based tournament management platform for running **Longest Drive (LD)** and **Closest to Pin (CTP)** contests at golf events.

- Players use their phones to scan a QR code on a numbered ball
- GPS distance is calculated automatically on the server
- A live leaderboard updates in real-time for spectators and TV displays
- No app download required — everything runs in a phone browser

---

## 2. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Backend | Node.js + Express | All routes in `server.js` (~1,600 lines) |
| Database | SQLite (better-sqlite3) | WAL mode for concurrent writes. File: `data/jord.db` |
| Maps | Mapbox GL JS v2.15.0 + ESRI World Imagery | Satellite tiles via `JORD.satelliteStyle()` in `jord.js` |
| Drawing | MapboxDraw v1.4.3 + Turf.js | Freehand polygon draw + auto-clipping |
| Real-time | Server-Sent Events (SSE) | Full state broadcast on every change |
| Auth | Session tokens (scrypt hashing) | 7-day sessions stored in `sessions` table |
| Notifications | Klaviyo | Live — 4 flows: registered, ball scanned, tournament ended, dethroned |
| Shared JS | `public/js/jord.js` | API client, QR scanner, toast UI, map helpers |
| CSS | `public/css/jord.css` | Rumble Golf dark theme, CSS variables |

---

## 3. File Structure

```
jord-v1/
├── server.js                    # Main backend — all routes, DB schema, scoring
├── package.json                 # Dependencies
├── .env                         # Secrets (never commit) — PORT, MAPBOX_TOKEN, etc.
├── SYSTEM_UNDERSTANDING.md      # This file
├── TODO.md                      # Feature backlog
├── CHANGELOG.md                 # Version history
├── TESTING.md                   # Test strategy
│
├── data/
│   ├── jord.db                  # SQLite database
│   └── courses.csv              # 2,700+ US golf courses (2.3MB, lazy-loaded)
│
├── public/
│   ├── admin.html               # Admin panel (event mgmt, course map, players)
│   ├── scan.html                # Player scan page (GPS submission, flyover)
│   ├── leaderboard.html         # Live public leaderboard (SSE, satellite map)
│   ├── register.html            # Player registration (4-player team onboarding)
│   ├── monitor.html             # Rep dashboard (live map, alerts, corrections)
│   ├── global.html              # Public global leaderboard (monthly top 10)
│   ├── system-summary.html      # Printable system summary (open in browser → Print → PDF)
│   ├── css/jord.css             # Design system
│   └── js/jord.js               # Shared frontend library
│
└── tests/
    ├── run-tests.js             # 48 unit tests (scoring, geography)
    ├── live-tests.js            # Integration tests
    └── watch.js                 # Dev watcher
```

---

## 4. Database Schema (10 Tables)

### `events`
One row per tournament. The central record everything else links to.

Key columns: `id`, `name`, `venue`, `venue_lat/lon`, `status` (`setup|active|ended`), `starts_at/ends_at`, `has_longest_drive`, `has_closest_pin`, `admin_id`, `global_published`

Longest Drive config: `pin_lat/lon`, `fairway_polygon`, `rough_polygon`, `oob_polygon` (GeoJSON), `hole_distance_yards`, `allow_rough`, `allow_oob`, `rough_penalty_mode` (`perpendicular|fixed`), `oob_penalty_mode` (`half_hole|fixed`)

CTP config: `ctp_pin_lat/lon`, `ctp_green_polygon` (GeoJSON), `cp_off_green_penalty_ft`

### `tee_boxes`
Multiple starting positions per hole (Men's, Women's, Senior). Linked to one event, one contest type (`longest_drive` or `closest_pin`).

### `teams`
Groups of 1–4 players. Created at registration finalization.

### `balls`
One row per ball/drop code. The most important table.
- Pre-event: code exists, `team_id` is null, `status = pre_tournament`
- After registration: `team_id`, `player_index` (1–4), `first_name/last_name/email/phone`, `tee_box_id` filled in
- After scan: `ld_lat/lon`, `ld_raw_yards`, `ld_penalty_yards`, `ld_final_yards`, `ld_location_type`, `cp_distance_ft`, `cp_penalty_ft`, etc.

### `admin_corrections`
Full audit trail of every admin override. Stores before/after JSON snapshots and reason.

### `rep_alerts`
Player help requests from the scan page. Includes GPS lat/lon and message. Shown on monitor.

### `sms_log`
History of all Klaviyo sends (for debugging).

### `admins`
User accounts. Role: `super` (all access) or `admin` (own events only). Hashed passwords with `salt:hash` format. Per-admin permission toggles for corrections, ending tournaments, managing players, managing balls.

### `sessions`
Active login tokens (32-byte random hex). 7-day expiry. Checked via `X-Admin-Token` header.

### `password_reset_tokens`
Temporary links (1-hour or 24-hour expiry). Can only be used once.

---

## 5. API Routes Summary

### Authentication (`/api/auth/*`)
- `POST /api/auth/login` — Email + password → session token
- `POST /api/auth/logout` — Invalidate token
- `GET /api/auth/me` — Current user profile
- `POST /api/auth/forgot-password` — Generate reset link
- `POST /api/auth/reset-password` — Set new password via token

### Admin Management (super only)
- `GET/POST /api/admins` — List / create admins
- `PATCH/DELETE /api/admins/:id` — Edit / remove admin
- `POST /api/admins/:id/reset-password` — Generate 24-hr reset link

### Events
- `GET /api/events` — List (super: all, admin: own only)
- `GET /api/events/:id` — Single event + tee boxes
- `GET /api/events/:id/public` — No auth (used by demo scan mode)
- `POST /api/events` — Create event
- `PATCH /api/events/:id` — Update settings / polygons
- `DELETE /api/events/:id` — Delete + cascade
- `POST /api/events/:id/end` — End tournament
- `POST /api/events/:id/reopen` — Reopen ended tournament

### Course Setup
- `POST /api/events/:eventId/tee-boxes` — Add tee box
- `PATCH /api/tee-boxes/:id` — Update tee
- `DELETE /api/tee-boxes/:id` — Remove tee

### Ball Pool
- `POST /api/events/:eventId/balls` — Bulk add codes
- `DELETE /api/events/:eventId/balls/:code` — Remove ball
- `PATCH /api/events/:eventId/balls/:code/unassign` — Unassign from team
- `PATCH /api/events/:eventId/balls/:code/player` — Edit player info
- `GET /api/events/:eventId/balls` — List all balls

### Registration (no auth)
- `GET /api/events/:eventId/info` — Event info for register page
- `POST /api/events/:eventId/register-player` — Register one player
- `POST /api/events/:eventId/finalize-team` — Create team + assign balls

### Scanning (no auth)
- `GET /api/ball/:code` — Ball details + polygons
- `POST /api/scan/ld/:code` — Submit LD shot
- `POST /api/scan/cp/:code` — Submit CTP shot

### Corrections
- `POST /api/admin/correct` — Override ball result
- `POST /api/admin/null-ball` — Mark ball invalid
- `PATCH /api/events/:eventId/balls/:code/reset-scan` — Clear scan so player can re-submit

### Alerts
- `POST /api/alerts` — Player sends help request
- `PATCH /api/alerts/:id/resolve` — Rep resolves alert

### Leaderboard
- `GET /api/leaderboard/:eventId` — Snapshot
- `GET /api/leaderboard/:eventId/stream` — SSE real-time stream

### Global Leaderboard (public)
- `GET /api/global/leaderboard?month=YYYY-MM` — Monthly top 10
- `GET /api/global/course-records` — All-time records per course
- `GET /api/global/venue-record?venue=X` — One course's record

### Utilities
- `GET /api/config` — Mapbox token + version
- `GET /api/courses/search?q=` — Course autocomplete (lazy-loads CSV)
- `GET /api/server-info` — Local IP + ngrok URL
- `GET /api/qr?data=URL&size=220` — Server-generated QR PNG
- `GET /api/events/:eventId/export.csv` — CSV export

---

## 6. Scoring Logic

### Longest Drive
```
raw_yards = haversine(tee.lat, tee.lon, ball.lat, ball.lon)

if fairway:
  penalty = 0, final = raw

if rough AND allow_rough:
  penalty = perpendicular distance to fairway polygon edge
  final = max(0, raw - penalty)

if oob/lost AND allow_oob:
  if oob_penalty_mode = 'half_hole':  penalty = hole_distance_yards / 2
  if oob_penalty_mode = 'fixed':      penalty = oob_fixed_yards
  final = max(0, raw - penalty)

if rough/oob AND NOT allowed:
  final = 0 (not scored)

Team LD score = sum of all 4 players' final_yards
```

### Closest to Pin
```
raw_ft = haversine_feet(ball.lat, ball.lon, pin.lat, pin.lon)
  OR manual_ft if player entered rangefinder distance

on_green = pointInPolygon(ball, ctp_green_polygon)

if NOT on_green AND cp_off_green_penalty_ft > 0:
  penalty_ft = cp_off_green_penalty_ft
else:
  penalty_ft = 0

distance_ft = raw_ft + penalty_ft

Team CTP score = best (lowest) distance_ft across all 4 players
```

---

## 7. Real-Time Architecture (SSE)

Every scan, correction, registration, alert, or tournament end triggers `broadcast(eventId)`.

```javascript
broadcast(eventId):
  payload = { event, ld_leaderboard, cp_leaderboard, alerts }
  → sends to all connected SSE clients for that event
```

**Clients:** Leaderboard, monitor dashboard, and admin panel all subscribe via `JORD.subscribe(eventId, callback)`.

**Pattern:** Full state is sent every time (not diffs). Simple but slightly heavier than delta updates. Works well for current scale.

---

## 8. Authentication Flow

1. `POST /api/auth/login` — validate email + scrypt password hash
2. `createSession(adminId)` — 32-byte random token, stored in `sessions` table, 7-day expiry
3. All authenticated requests send `X-Admin-Token: <token>` header
4. `requireAuth` middleware — looks up token in DB, attaches `req.admin`
5. `requireSuper` / `requirePerm('corrections')` — gate routes by role/perms
6. `POST /api/auth/logout` — delete session row

**Password reset flow:** Super admin generates link → shares it manually → player visits `?reset_token=X` on admin page → sets new password → all sessions invalidated.

---

## 9. Polygon & Zone System

**Storage:** GeoJSON strings in the DB. Can be a `Polygon` or `FeatureCollection` (for multiple polygons of the same zone type — e.g., two rough patches).

**Zone priority (clipping order):** Fairway > Rough > OOB. Turf.js `difference()` removes overlap when polygons are saved.

**Freehand draw:** MapboxDraw → on `draw.create` → `turf.simplify()` reduces vertices to ~10–30 → `scheduleClipZones()` runs clipping → result saved as GeoJSON string.

**Point-in-polygon (zone detection at scan time):** Custom ray casting algorithm that handles both `Polygon` and `FeatureCollection` geometry types.

**GPS Trace tool:** Player walks the zone boundary with phone, accuracy-filtered GPS points are collected → polygon saved on "Done."

---

## 10. Key UX Flows

### Admin Course Setup
1. Create event → Settings tab → fill name/venue/dates/contest type
2. Course Map tab → draw zone polygons (freehand drag or GPS trace)
3. Click to place pin → GPS grab button for precise placement
4. Add tee boxes → GPS grab or click
5. Ball Pool tab → bulk add codes → print QR labels

### Player Registration
1. Visit `/register/:eventId` via QR at check-in
2. Enter ball code (type or camera scan)
3. Enter player info + pick tee
4. Repeat for up to 4 players
5. Name the team → submit → success card with leaderboard link

### Player Scan
1. Visit `/scan/:code` (QR on the ball)
2. GPS locks in (accuracy badge)
3. Zone auto-detected + locked (fairway, rough, OOB)
4. Confirm + submit
5. Flyover animation → result card → leaderboard link

### Admin Correction
1. Open monitor page → map shows all ball positions
2. Click ball dot → popup → "Fill correction form"
3. Override distance, penalty, location type + add reason
4. Submit → score updates, SSE broadcasts to all clients, correction logged to audit trail

---

## 11. Design System

**Theme:** Rumble Golf Co. dark green aesthetic

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0C2010` | Page background |
| `--surface` | `#142B17` | Cards, panels |
| `--primary` | `#BEFF3A` | Neon lime — buttons, accents |
| `--ink` | `#F0F7E8` | Body text |
| `--danger` | `#FF4C4C` | Errors, delete actions |

**Fonts:** Playfair Display (display/headings) + Inter (body) + JetBrains Mono (codes, scores)

**Map zone colors:** Fairway = blue `#3B82F6`, Rough = yellow `#EAB308`, OOB = red `#DC2626`, Green = green `#22C55E`

---

## 12. Klaviyo Messaging

### Architecture
- Server fires Klaviyo Events API (`POST /api/events/`) for each metric
- Each event carries pre-built `SmsText`, `EmailSubject`, and `EmailBodyHtml` as event properties
- Klaviyo Flows pick up these properties using `{{ event.SmsText }}` and `{{ event.EmailBodyHtml|safe }}`
- All sends are non-blocking (`setImmediate`) — player API responses are never delayed

### 4 Active Metrics & Flows

| Metric | Trigger | Message content |
|---|---|---|
| `jord_registered` | Team finalized at registration | Team name, ball code, leaderboard link |
| `jord_ball_scanned` | Player submits LD or CTP shot | Distance, zone, team rank, leaderboard link |
| `jord_tournament_ended` | Admin ends tournament | Final rank, player's yards/feet, winner team |
| `jord_dethroned` | Team knocked off #1 | New leader name + total yards, sarcastic taunt, leaderboard button |

### Message Builders (server.js)
- `msgRegistration()` — dark green JORD email with team card + ball code card + leaderboard button
- `msgLDScan()` — yards hit, zone badge, team rank, leaderboard button
- `msgCTPScan()` — feet from pin, on/off green, team rank, leaderboard button
- `msgTournamentEnded()` — final results card, winner team, personal yards/feet
- `checkLeadershipChange()` — dethroned email with red theme, new leader card, sarcastic quote, leaderboard button

### Klaviyo Flow Settings (all 4 flows)
- Re-entry: **Allow re-entry** (players can register/scan at multiple tournaments)
- Smart Sending: **Off** (tournament messages must always deliver)
- Transactional: **Checked** (bypasses marketing consent — confirmational messages)
- Email template: HTML block containing `{{ event.EmailBodyHtml|safe }}`
- SMS template: `{{ event.SmsText }}`

### Environment Variables Required
```
KLAVIYO_API_KEY=pk_...
KLAVIYO_EMAIL_LIST_ID=...   # for subscription opt-ins
KLAVIYO_SMS_LIST_ID=...     # for subscription opt-ins
```

---

## 13. Known Gaps & Planned Features

### Pre-Launch Issues
| Issue | Severity | Status |
|---|---|---|
| HTTPS required for iPhone GPS | Critical | ✅ Resolved — Railway + tournament.jordgolf.com |
| SMS/Email (Klaviyo) not connected | High | ✅ Resolved — 4 flows Live in Klaviyo |
| Monitor page uses old shared-password auth | Medium | Open — not yet upgraded to session tokens |
| No automated database backup | Medium | Open — needs cron job for `data/jord.db` |

### Phase 2 Features
- Rep alert GPS → tap-to-navigate (Google Maps link)
- "Print check-in QR" one-click button in admin
- Per-event branding (logo upload, accent color)
- End-of-event summary email to all players
- AI Help Agent on scan page (Claude API key already in `.env`)
- Combined LD + CTP blended scoring
- Stripe payments + self-serve event booking
- Leaderboard embed code for client websites
- PWA offline scan mode (queue + sync when signal returns)

---

## 13. Development & Testing

### Running Locally
```
npm install
npm start
# Server runs on http://localhost:3000
```

### Phone Testing (iPhone via ngrok)
```
ngrok http 3000
# Visit http://localhost:3000/test for QR codes + GPS simulator
# Use ngrok HTTPS URL on iPhone (Safari requires HTTPS for GPS)
```

### Running Tests
```
node tests/run-tests.js     # 48 unit tests
node tests/live-tests.js    # Integration tests
```

### Demo Mode (no registration needed)
```
/scan/DEMO?demo=1&eventId=EVT123&testLat=X&testLon=Y&testLoc=fairway
```
Full scan + flyover experience, calculated client-side, not saved to DB.

### GPS Test Mode (desktop simulation)
```
/scan/:code?testLat=X&testLon=Y&testLoc=fairway
```

---

## 14. Environment Variables (`.env`)

```
PORT=3000
APP_URL=http://localhost:3000
ADMIN_PASSWORD=<first super admin password>

MAPBOX_TOKEN=pk.eyJ...           # Public — 50k map loads/month free tier
ANTHROPIC_API_KEY=sk-ant-...     # Claude API (AI Help Agent — not live yet)
KLAVIYO_API_KEY=...              # Email/SMS (wired, not live yet)
KLAVIYO_SMS_LIST_ID=...

APP_VERSION=3.0.0
BUILD_DATE=2026-05-04
```

---

## 15. Deployment

**Production host:** Railway (railway.com)
**Workspace:** JORD Golf
**Project:** Tournament
**Service:** Tournament
**Volume:** tournament-volume → mounted at `/app/data` (SQLite persists across deploys)
**Live URL:** https://tournament.jordgolf.com
**Railway URL:** https://tournament-production-fd6f.up.railway.app
**Domain:** tournament.jordgolf.com CNAME → tournament-production-fd6f.up.railway.app (set in GoDaddy)
**SSL:** Auto-managed by Railway

**Deploying updates:**
```
railway link --workspace "JORD Golf" --project "Tournament"
railway service link "Tournament"
railway up --detach
```

**Checking logs:**
```
railway logs
```

**Other notes:**
- SQLite WAL mode handles concurrent tournament scans without configuration
- Auto-migrations run on startup — tables and missing columns are added automatically
- CORS: Currently `origin: '*'` — open. Restrict to your domain in production.
- Scale path: SQLite → PostgreSQL when multi-server is needed. SQL is compatible.
- Rate limiting on login (5 attempts/15 min), forgot-password (3/15 min), reset-password (5/15 min) — added May 2026.

---

*Update this document whenever a new feature is added, a flow changes, or a known gap is resolved.*
