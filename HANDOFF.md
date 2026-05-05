# JORD Golf Tournament System — Session Handoff

Paste everything below the line into your first message when starting a new session.

---

## PROMPT — copy from here

I'm building **JORD Golf Tournament System** — a SaaS web app for running Longest Drive and Closest to Pin golf contests at events. The system lets a tournament admin set up a course on a satellite map, then players scan a QR code on their ball with their phone to GPS-submit their shot. A live leaderboard updates in real time.

### Tech Stack
- **Backend**: Node.js + Express, SQLite via `better-sqlite3`
- **Real-time**: Server-Sent Events (SSE) broadcast to leaderboard and monitor
- **Maps**: Mapbox GL JS v2.15.0 with MapboxDraw v1.4.3
- **Styling**: Custom CSS design system in `public/css/jord.css`
- **Auth**: Multi-admin session tokens — `admins` + `sessions` tables; `crypto.scryptSync` password hashing; `x-admin-token` header carries session token (not raw password). Roles: `super` | `admin`.
- **SMS/Email**: Klaviyo API (for leaderboard change notifications)

### How to Run
```
cd jord-v1
npm start         # starts on localhost:3000
```
Admin panel: `http://localhost:3000/admin`  
Super admin login: `shah82286@gmail.com` / `jord2026` (password = `ADMIN_PASSWORD` in `.env`)  
On first run, super admin is auto-seeded from `.env`.

---

### Current State (as of v3.1.0 — 2026-05-05)

#### What's fully working
- Tournament event creation with Longest Drive and/or Closest to Pin contests
- **Course search & venue autocomplete**: venue field in admin searches a 2.3MB CSV of US golf courses. Selecting a course fills the venue name, flies the admin map to the course, and saves GPS coordinates (`venue_lat`/`venue_lon`) to the database.
- **Course map** (admin): two separate hole configs (LD hole + CTP hole), each with:
  - Freehand click-and-drag polygon drawing for Fairway, Rough, OOB, Green zones
  - **Draw mode stays active** after completing a zone — draw multiple polygons of the same type without re-clicking the button. Press Esc or click outside the map to exit draw mode.
  - **Zone non-overlapping** — Turf.js clips zones so they snap tight: Fairway > Rough > OOB priority. No gap or overlap.
  - Color-coded zones: Fairway=blue `#3B82F6`, Rough=yellow `#EAB308`, OOB=red `#DC2626`, Green/CTP=green `#22C55E`. Colors show correctly on the setup map via dedicated zone-* GeoJSON layers (DrawStyle inactive fill set to transparent).
  - Trash can button: deletes the currently selected (clicked) polygon.
  - Multiple tee boxes numbered T1, T2, T3 with per-tee distance to pin displayed
  - Pin placement via map click, GPS grab (10-second accuracy sampling), or drag
  - GPS Trace tool (walk the boundary with phone) with warm-up accuracy phase
  - Selective clear (clear selected polygon only, or confirm-clear all)
  - **CTP off-green penalty** — admin sets penalty in feet; if a CTP shot lands outside the green polygon, that many feet are added to the raw distance. Shown in leaderboard and scan result.
  - Zone polygon rendering: `syncZoneLayers()` maintains 5 dedicated GeoJSON sources. `turf.simplify` reduces freehand paths to ~10–30 vertices. `scheduleClipZones()` called after freehand and GPS trace draw complete.
  - **Multiple polygons per zone** — each zone type stored as a FeatureCollection; multiple fairways, roughs, OOB areas all supported. `loadPolygon` handles both old (bare Polygon) and new (FeatureCollection) format.
  - **Zone auto-merge** — when a new polygon of an existing zone type overlaps another of the same kind, `mergeKind()` inside `clipZones()` merges them into one shape automatically. Drawing 3 overlapping fairway polygons produces a single merged fairway.
  - **Ctrl+Z undo** — up to 20-step undo stack. Snapshots pushed before each freehand draw, GPS trace, clear, and vertex-drag (captured on selection). `Ctrl+Z` / `Cmd+Z` anywhere on the page restores previous state.
  - **Node editing** — "✏️ Edit nodes" toolbar button. Click a zone polygon to select it, then click the button to enter `direct_select` mode. Midpoint handles enlarged (radius 6 + white stroke) for easy grabbing. Mode persists after each vertex drag — stays active until Esc or clicking outside the map.
  - **GPS pin grab** early-stop threshold: ±3m accuracy (was 4m)
- Ball pool management (bulk add drop codes, CSV import, QR print)
- Player self-registration at `/register/:eventId`
- **Scan page** (`/scan`): 6-box OTP-style code entry — one character per box, auto-advance on type, backspace navigates back, paste fills all boxes, Enter submits. `autocapitalize="none"` keeps keyboard in whatever mode the player last used.
- On-course shot scanning: GPS locks → zone auto-detected from mapped polygons and pre-selected (fairway/rough/OOB). Ball outside all mapped zones → OOB pre-selected with a red "outside all designated zones" note. If no polygons are mapped, manual picker shown as before. CTP: `checkCTPZone` warns if ball is off the green (with penalty amount). Player can still override the selection. Submits → full-screen satellite flyover → compact result card with encouragement, yardage, and penalty breakdown.
  - **Not-scored explanation**: when `allow_rough = 0` or `allow_oob = 0`, result card shows an amber rule box explaining why the score is 0 yards ("only fairway drives count"). `getEncouragement` also uses accurate messages for these cases.
- **CTP scan**: optional "Rangefinder distance (ft)" field — if filled, overrides GPS distance with physical rangefinder reading. `manual_ft` passed to server.
- **Tournament lifecycle gate**: players cannot register or submit shots until the admin clicks "▶ Start tournament" (status = `active`). Server returns 403 for all player-facing routes when status is `setup` or `ended`. Both register.html and scan.html show friendly "not started yet" or "ended" messages.
- **Live leaderboard** at `/leaderboard/:eventId`:
  - Penalty display: team total shows post-penalty final yards; per-player rows show `raw − pen = final` badge; team badge reads "N yd penalty applied" (not a future deduction).
  - **Map full-screen expand**: "Map" toggle hides the scores column and expands the map to fill the full content area. A scrollable team strip below the map shows rank + name + score per row; tap a row to filter the map to that team's dots (tap again to clear). `min-height: 0` on `.lb-map-container` prevents flex layout from clipping the map bottom.
  - Map-selected visual: blue ring/left-border (`#3B82F6`).
  - Map popups: all text forced dark (`color:#1a1a1a`) via inline styles.
  - **Hole Tour**: "🎬 Hole Tour" button in map toolbar. Animated satellite camera tour — tee → fairway sweep → pin approach → 360° orbit → overhead pullback. ~29 seconds. Works for LD and CTP tabs.
  - **End-of-tournament screen**: when status = `ended`, a summary section prepends the rankings: Total Yards hero with fun comparison phrase, zone stats grid (Fairway / Rough / OOB / Lost in zone colours), Champion showcase card (winning team + sorted player drives), **Hall of Fame card** (all-time course record for this venue, loaded async from `/api/global/venue-record`), "All Teams" divider. Map auto-opens showing all ball dots.
- **Monitor dashboard** at `/monitor/:eventId`:
  - Map toggle: **On Hole** / **All Players** — "On Hole" hides fully-submitted teams to reduce clutter.
  - **Team colors**: 12-color palette assigned per team on first appearance (`teamColorMap` cached for session). Map dots render in that team's color (grey if not yet scanned). Each team row in Current Standings has a color-dot + 📍 button to focus the map to that team's dots (others dim to 18% opacity). "× All Teams" button in map header clears the filter.
  - Clicking a ball dot shows the player's 6-digit ball code + "Fill correction form" button that auto-populates the code field.
  - Map popups: dark text, forced via inline styles and CSS override.
- **Admin correction**: "Distance Drove" field = raw yards; penalty is subtracted server-side to get final score.
- **Admin Players tab**: each player row now shows a Score column — `final_yards yd` with location sub-line, red penalty breakdown if applicable, or `—` if not yet scanned.
- **Admin tab state on reload**: reloading the admin panel restores the active event and panel. `showPanel()` writes `#eventId/panel` to the URL hash via `history.replaceState`; `init()` reads and restores it on load. `backToList()` clears the hash.
- **Player registration** (`/register/:eventId`): all 4 player codes must be entered before the team name step appears. Team name is always the last step. "Submit with fewer" shows an inline yellow warning + confirm (no browser alert). On confirm, jumps straight to the team name form.
- **Player registration opt-in** (`/register/:eventId`): email and SMS marketing checkboxes with TCPA fine print. Consents stored in `balls` table and sent to Klaviyo subscription lists when API key is configured.
- Demo scan mode — no ball code needed, calculates distance client-side
- End tournament — locks scoring, Klaviyo notifications
- CSV export of all player/team data
- Full mobile responsive design across all pages
- **ngrok phone testing** — full player experience testable on iPhone via ngrok HTTPS tunnel
  - `ngrok http 3000` exposes localhost; Safari GPS works because HTTPS
  - Test page at `/test.html` auto-generates QR codes for every page using current origin (works on both localhost and ngrok URL)
  - QR codes generated for: Admin, Ball Scan (player), Rep Monitor (uses first active event), per-event Leaderboard + Monitor + Register + Submit Shot
  - `/qr.html` — standalone scan-to-open QR for the scan page
  - **GPS note**: iPhone Safari blocks GPS on plain HTTP (local IP). Always use ngrok URL for full phone GPS testing.
- **Test tool GPS simulator**: selecting an event loads zone polygons on the simulator map. Clicking the map auto-detects which zone the point falls in and shows a colored dot + label. Map fly-to uses a full fallback chain: zone polygons → tee boxes → venue coordinates.

#### Multi-admin system (v3.0.0)
- **Super admin** (`role='super'`): sees all events, manages other admins, controls global leaderboard
- **Tournament admin** (`role='admin'`): sees only their own events; per-permission toggles: `perm_corrections`, `perm_end_tournament`, `perm_manage_players`, `perm_manage_balls`
- **Session tokens**: 32-byte hex, stored in `sessions` table, 7-day expiry. Old raw-password tokens rejected.
- **Login**: `POST /api/auth/login` → `{ email, password }` → `{ token, role, name, permissions }`
- **Forgot password**: generates reset link stored in DB; super admin shares link manually. Reset URL: `/admin?reset_token=TOKEN`
- **Forgot email**: enter name → get masked email hint
- **First run**: super admin auto-seeded from `.env` (`SUPER_ADMIN_EMAIL` or `shah82286@gmail.com`, password = `ADMIN_PASSWORD`)

#### Global Leaderboard (v3.0.0)
- **Public page**: `/global` — monthly top 10 fairway drives + course all-time records tab
- **Opt-in per event**: super admin publishes ended tournaments via "🌍 Global LB" management panel
- **Hall of Fame**: shown on ended tournament leaderboard — all-time course record for that venue
- **Data rules**: fairway drives only, `global_published = 1` events only, monthly grouping by `ld_scanned_at`

#### Database schema
Tables: `events`, `tee_boxes`, `balls`, `teams`, `rep_alerts`, `admin_corrections`, `sms_log`, `admins`, `sessions`, `password_reset_tokens`

Key `events` columns (recent additions auto-migrate on startup):
- `ctp_pin_lat`, `ctp_pin_lon` — CTP hole pin coordinates
- `ctp_green_polygon` — CTP green boundary GeoJSON string
- `ctp_hole_distance_yards` — CTP tee-to-pin distance
- `venue_lat`, `venue_lon` — course GPS coordinates (set from course autocomplete; used for map fly-to)
- `admin_id` — which admin owns this event
- `global_published` — whether this event's fairway drives appear on `/global`

#### Maps — ESRI World Imagery (v1.8.0)
- All maps use ESRI World Imagery raster tiles via `JORD.satelliteStyle()` in `jord.js`
- Mapbox GL JS engine unchanged; only the satellite tile source swapped
- Sharper resolution than Mapbox satellite for many US golf courses

#### Color theme (v1.5.0)
- Platform uses a **Rumble Golf Co. inspired dark palette**: deep forest green backgrounds, neon lime-green accent
- CSS variables in `public/css/jord.css` `:root`: `--bg: #0C2010`, `--surface: #142B17`, `--primary / --accent: #BEFF3A`, `--ink: #F0F7E8`
- All hardcoded gold `#C9A24A` has been replaced with `#BEFF3A` across all HTML files
- `.is-leader` leaderboard row gradient uses lime; text uses `var(--primary-ink)` = `#0C2010` (dark on bright)

#### Key architectural decisions
- **Polygon colors**: MapboxDraw polygon fill styles now use the `kindColor` Mapbox expression directly (reads `user_kind` / `kind` property). `syncZoneLayers()` also maintains 5 dedicated GeoJSON sources (`zone-fairway`, `zone-rough`, etc.) as a secondary colored-fill mechanism.
- **Two-hole tabs**: LD and CTP hole data live in the same `events` row. `currentHoleTab` JS variable controls which fields are read/written. `hole_type` column in `tee_boxes` separates LD vs CTP tees.
- **GPS accuracy**: All GPS capture (pin grab + trace) now uses `watchPosition` with accuracy filtering — skips readings worse than 10–15m, waits for warm-up before recording.
- **CP scan backwards compat**: `COALESCE(e.ctp_pin_lat, e.pin_lat)` so old events without CTP fields still work.

---

### Files Map
| File | Purpose |
|------|---------|
| `server.js` | All API routes, SSE, DB schema, scoring logic |
| `public/admin.html` | Admin panel — event CRUD, course map, ball pool, players, alerts |
| `public/leaderboard.html` | Live leaderboard — SSE-driven, satellite map, TV mode |
| `public/monitor.html` | Rep monitor — live ball dots, alerts, corrections |
| `public/scan.html` | Player scan page — GPS lock, location pick, submit |
| `public/test.html` | Dev testing tools — GPS simulator, QR generator |
| `public/css/jord.css` | Shared design system |
| `public/js/jord.js` | Shared frontend library — API client, toasts, QR scanner |
| `public/global.html` | Public global leaderboard — monthly top 10 + course records |

---

### Known Issues / Next Up

#### Known issues
1. **GPS trace on desktop** — trace tool designed for walking on-course; desktop users need to use freehand drawing instead
2. **Demo mode CTP** — demo scan only supports Longest Drive, not Closest to Pin
3. **Zone overlap visual during draw** — clipping runs 200ms after releasing the mouse, not in real-time; a new polygon can visually overlap an existing one while being drawn, clips correctly on release
4. **Monitor session auth** — rep monitor (`/monitor`) still uses a shared-password system in `localStorage`; admin panel uses proper session tokens. Needs upgrade (see `#PRE-3` in TODO.md)
5. **Klaviyo email/SMS mocked** — opt-in checkboxes on registration page work end-to-end but no actual sends until real Klaviyo API key + list IDs are added to `.env` (see `#PRE-2` in TODO.md)

#### Remaining phases (not yet built)
- **Phase 2** — Tournament admin experience: limited panel UI, per-event branding (logo + color picker), "Powered by JORD Golf" footer on all event pages
- **Phase 3** — AI Help Agent: Claude-powered floating chat in admin panel, event context, escalation alerts to super admin dashboard
- **Phase 5** — Klaviyo welcome email: wire up temp password email on new admin creation; wire forgot-password reset link to email instead of manual copy

---

### How I Like to Work
- Make targeted edits — don't rewrite files unless necessary
- Show me specific changes, explain the *why* briefly
- Ask before doing anything destructive (deleting files, dropping DB tables)
- Mobile-first: test that any UI change looks good at 375px width
- The admin panel is used by a non-technical founder — keep the UI language plain and clear
- Read the CHANGELOG.md for full history of past sessions
