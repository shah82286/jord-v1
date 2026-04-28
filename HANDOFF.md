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

### Current State (as of v1.4.0 — 2026-04-27)

#### What's fully working
- Tournament event creation with Longest Drive and/or Closest to Pin contests
- **Course map** (admin): two separate hole configs (LD hole + CTP hole), each with:
  - Freehand click-and-drag polygon drawing for Fairway, Rough, OOB, Green zones
  - Color-coded zones: Fairway=green `#22C55E`, Rough=yellow `#EAB308`, OOB=red `#DC2626`, Green/CTP=blue `#3B82F6`. Colors now show correctly on the setup map (fixed: draw fill styles use the `kindColor` expression instead of near-transparent black).
  - Trash can button: deletes the currently selected (clicked) polygon. Useful for removing a single bad zone without clearing everything.
  - Multiple tee boxes numbered T1, T2, T3 with per-tee distance to pin displayed
  - Pin placement via map click, GPS grab (10-second accuracy sampling), or drag
  - GPS Trace tool (walk the boundary with phone) with warm-up accuracy phase
  - Selective clear (clear selected polygon only, or confirm-clear all)
  - Pin latitude/longitude displayed after placement
- Ball pool management (bulk add drop codes, CSV import, QR print)
- Player self-registration at `/register/:eventId`
- **Scan page** (`/scan`): code-entry-first flow — player types or pastes their 6-digit ball code, camera is an opt-in button (no auto-popup). Unregistered codes show a friendly "Ball Not Registered" screen with instructions.
- On-course shot scanning: GPS locks, player picks Fairway/Rough/OOB/Lost, submits → full-screen satellite flyover animation (tee → ball gold line draws, ball pops, yardage counts up) then fades to compact result card with encouragement, yardage, penalty breakdown, and optional Call Admin button.
- **Live leaderboard** at `/leaderboard/:eventId`:
  - Penalty yards now shown: player row shows `final_yards yd` with `raw−pen pen` below in red; team total shows `−N yd penalty` under the team score.
  - Map panel has **All Teams** / **[Team Name]** toggle buttons — clicking a team on the leaderboard filters the map to just that team's dots (auto-fits view); clicking "All Teams" resets.
  - Map popups show penalty breakdown in red.
- **Monitor dashboard** at `/monitor/:eventId`:
  - Map has **On Hole** / **All Players** toggle — "On Hole" hides fully-submitted teams to reduce clutter.
  - Clicking a ball dot shows the player's 6-digit ball code in the popup + a "Fill correction form" button that auto-populates the Admin Correction code field.
- Demo scan mode — no ball code needed, calculates distance client-side
- End tournament — locks scoring, Klaviyo notifications
- CSV export of all player/team data
- Full mobile responsive design across all pages

#### Database schema
Tables: `events`, `tee_boxes`, `balls`, `teams`, `rep_alerts`, `admin_corrections`, `sms_log`

Key `events` columns (recent additions auto-migrate on startup):
- `ctp_pin_lat`, `ctp_pin_lon` — CTP hole pin coordinates
- `ctp_green_polygon` — CTP green boundary GeoJSON string
- `ctp_hole_distance_yards` — CTP tee-to-pin distance

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
1. **Polygon vertex editing UX** — after drawing a polygon the user can click it and drag vertices to adjust; this works but there's no clear on-screen hint that it's possible
2. **CTP scoring distance** — the per-tee distance is calculated and shown in admin but not yet factored into CTP scoring (CTP uses ball-to-pin haversine directly, which is correct)
3. **GPS trace on desktop** — trace tool designed for walking on-course; desktop users need to use freehand drawing instead
4. **Demo mode CTP** — demo scan only supports Longest Drive, not Closest to Pin
5. **Penalty display on result screen** — scan.html result card shows raw yardage only for demo mode (client-side calc); server-scan result correctly shows penalty breakdown

---

### How I Like to Work
- Make targeted edits — don't rewrite files unless necessary
- Show me specific changes, explain the *why* briefly
- Ask before doing anything destructive (deleting files, dropping DB tables)
- Mobile-first: test that any UI change looks good at 375px width
- The admin panel is used by a non-technical founder — keep the UI language plain and clear
- Read the CHANGELOG.md for full history of past sessions
