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
- **Auth**: Single admin password stored in `.env` as `ADMIN_PASSWORD`, sent as `x-admin-token` header
- **SMS/Email**: Klaviyo API (for leaderboard change notifications)

### How to Run
```
cd jord-v1
npm start         # starts on localhost:3000
```
Admin panel: `http://localhost:3000/admin`  
Default password: `jord2026` (change in `.env`)

---

### Current State (as of v1.9.0 — 2026-05-03)

#### What's fully working
- Tournament event creation with Longest Drive and/or Closest to Pin contests
- **Course map** (admin): two separate hole configs (LD hole + CTP hole), each with:
  - Freehand click-and-drag polygon drawing for Fairway, Rough, OOB, Green zones
  - Color-coded zones: Fairway=blue `#3B82F6`, Rough=yellow `#EAB308`, OOB=red `#DC2626`, Green/CTP=green `#22C55E`. Colors show correctly on the setup map via dedicated zone-* GeoJSON layers (DrawStyle inactive fill set to transparent).
  - Trash can button: deletes the currently selected (clicked) polygon.
  - Multiple tee boxes numbered T1, T2, T3 with per-tee distance to pin displayed
  - Pin placement via map click, GPS grab (10-second accuracy sampling), or drag
  - GPS Trace tool (walk the boundary with phone) with warm-up accuracy phase
  - Selective clear (clear selected polygon only, or confirm-clear all)
  - **CTP off-green penalty** — admin sets penalty in feet; if a CTP shot lands outside the green polygon, that many feet are added to the raw distance. Shown in leaderboard and scan result.
  - Zone polygon rendering: `syncZoneLayers()` maintains 5 dedicated GeoJSON sources. `turf.simplify` reduces freehand paths to ~10–30 vertices. `scheduleClipZones()` called after freehand and GPS trace draw complete.
  - **Multiple polygons per zone** — each zone type stored as a FeatureCollection; multiple fairways, roughs, OOB areas all supported. `loadPolygon` handles both old (bare Polygon) and new (FeatureCollection) format.
  - **GPS pin grab** early-stop threshold: ±3m accuracy (was 4m)
- Ball pool management (bulk add drop codes, CSV import, QR print)
- Player self-registration at `/register/:eventId`
- **Scan page** (`/scan`): code-entry-first flow — player types their 6-digit ball code, camera is opt-in. Unregistered codes show a "Ball Not Registered" screen with instructions.
- On-course shot scanning: GPS locks → zone auto-detected from mapped polygons and pre-selected. Fairway/Rough detected from their polygons; ball outside all zones → OOB pre-selected with a red "not in any designated zone" warning. CTP: `checkCTPZone` warns if ball is off the green (with penalty amount). Player can still override the selection. Submits → full-screen satellite flyover → compact result card with encouragement, yardage, and penalty breakdown.
  - **Not-scored explanation**: when `allow_rough = 0` or `allow_oob = 0`, result card shows an amber rule box explaining why the score is 0 yards ("only fairway drives count"). `getEncouragement` also uses accurate messages for these cases.
- **CTP scan**: optional "Rangefinder distance (ft)" field — if filled, overrides GPS distance with physical rangefinder reading. `manual_ft` passed to server.
- **Tournament lifecycle gate**: players cannot register or submit shots until the admin clicks "▶ Start tournament" (status = `active`). Server returns 403 for all player-facing routes when status is `setup` or `ended`. Both register.html and scan.html show friendly "not started yet" or "ended" messages.
- **Live leaderboard** at `/leaderboard/:eventId`:
  - Penalty display: team total shows post-penalty final yards; per-player rows show `raw − pen = final` badge; team badge reads "N yd penalty applied" (not a future deduction).
  - **Map full-screen expand**: "Map" toggle hides the scores column and expands the map to fill the full content area. A scrollable team strip below the map shows rank + name + score per row; tap a row to filter the map to that team's dots (tap again to clear). `min-height: 0` on `.lb-map-container` prevents flex layout from clipping the map bottom.
  - Map-selected visual: blue ring/left-border (`#3B82F6`).
  - Map popups: all text forced dark (`color:#1a1a1a`) via inline styles.
  - **Hole Tour**: "🎬 Hole Tour" button in map toolbar. Animated satellite camera tour — tee → fairway sweep → pin approach → 360° orbit → overhead pullback. ~29 seconds. Works for LD and CTP tabs.
  - **End-of-tournament screen**: when status = `ended`, a summary section prepends the rankings: Total Yards hero with fun comparison phrase, zone stats grid (Fairway / Rough / OOB / Lost in zone colours), Champion showcase card (winning team + sorted player drives), "All Teams" divider. Map auto-opens showing all ball dots.
- **Monitor dashboard** at `/monitor/:eventId`:
  - Map toggle: **On Hole** / **All Players** — "On Hole" hides fully-submitted teams to reduce clutter.
  - **Team colors**: 12-color palette assigned per team on first appearance (`teamColorMap` cached for session). Map dots render in that team's color (grey if not yet scanned). Each team row in Current Standings has a color-dot + 📍 button to focus the map to that team's dots (others dim to 18% opacity). "× All Teams" button in map header clears the filter.
  - Clicking a ball dot shows the player's 6-digit ball code + "Fill correction form" button that auto-populates the code field.
  - Map popups: dark text, forced via inline styles and CSS override.
- **Admin correction**: "Distance Drove" field = raw yards; penalty is subtracted server-side to get final score.
- **Admin Players tab**: each player row now shows a Score column — `final_yards yd` with location sub-line, red penalty breakdown if applicable, or `—` if not yet scanned.
- **Admin tab state on reload**: reloading the admin panel restores the active event and panel. `showPanel()` writes `#eventId/panel` to the URL hash via `history.replaceState`; `init()` reads and restores it on load. `backToList()` clears the hash.
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

#### Database schema
Tables: `events`, `tee_boxes`, `balls`, `teams`, `rep_alerts`, `admin_corrections`, `sms_log`

Key `events` columns (recent additions auto-migrate on startup):
- `ctp_pin_lat`, `ctp_pin_lon` — CTP hole pin coordinates
- `ctp_green_polygon` — CTP green boundary GeoJSON string
- `ctp_hole_distance_yards` — CTP tee-to-pin distance

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

---

### Known Issues / Next Up

#### Known issues
1. **Polygon vertex editing UX** — after drawing a polygon the user can click it and drag vertices to adjust; works but there's no on-screen hint
2. **GPS trace on desktop** — trace tool designed for walking on-course; desktop users need to use freehand drawing instead
3. **Demo mode CTP** — demo scan only supports Longest Drive, not Closest to Pin
4. **Mobile optimization review** — full review of all pages at 375px not yet done
5. **Course map zone overlap during drawing** — clipping runs 200ms after releasing the mouse, not in real-time; a new polygon can visually overlap an existing one while being drawn, clips correctly on release
6. **Code entry keyboard default mode** — the 6-box hidden-input approach keeps the keyboard in whatever mode the player last used (letters↔numbers), which is the intended behavior. On first open, keyboard defaults to letter mode on iOS — players switch to numbers if needed. By design: ball codes can include letters, so letter mode is valid.

---

### How I Like to Work
- Make targeted edits — don't rewrite files unless necessary
- Show me specific changes, explain the *why* briefly
- Ask before doing anything destructive (deleting files, dropping DB tables)
- Mobile-first: test that any UI change looks good at 375px width
- The admin panel is used by a non-technical founder — keep the UI language plain and clear
- Read the CHANGELOG.md for full history of past sessions
