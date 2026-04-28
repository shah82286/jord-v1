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

### Current State (as of v1.5.0 — 2026-04-28, theme updated)

#### What's fully working
- Tournament event creation with Longest Drive and/or Closest to Pin contests
- **Course map** (admin): two separate hole configs (LD hole + CTP hole), each with:
  - Freehand click-and-drag polygon drawing for Fairway, Rough, OOB, Green zones
  - Color-coded zones: Fairway=green `#22C55E`, Rough=yellow `#EAB308`, OOB=red `#DC2626`, Green/CTP=blue `#3B82F6`. Colors show correctly on the setup map (draw fill styles use the `kindColor` Mapbox expression).
  - Trash can button: deletes the currently selected (clicked) polygon.
  - Multiple tee boxes numbered T1, T2, T3 with per-tee distance to pin displayed
  - Pin placement via map click, GPS grab (10-second accuracy sampling), or drag
  - GPS Trace tool (walk the boundary with phone) with warm-up accuracy phase
  - Selective clear (clear selected polygon only, or confirm-clear all)
  - **CTP off-green penalty** — admin sets penalty in feet; if a CTP shot lands outside the green polygon, that many feet are added to the raw distance. Shown in leaderboard and scan result.
- Ball pool management (bulk add drop codes, CSV import, QR print)
- Player self-registration at `/register/:eventId`
- **Scan page** (`/scan`): code-entry-first flow — player types their 6-digit ball code, camera is opt-in. Unregistered codes show a "Ball Not Registered" screen with instructions.
- On-course shot scanning: GPS locks, player picks Fairway/Rough/OOB/Lost, submits → full-screen satellite flyover animation then fades to compact result card with encouragement, yardage, penalty breakdown, and optional Call Admin button.
- **Live leaderboard** at `/leaderboard/:eventId`:
  - Penalty display: player row shows `final yd` with a red badge `raw − pen = final` below it. Team total shows `N yd penalty deducted`.
  - Map panel: clicking a team card in the list filters the map to just that team's dots (auto-fits view). Active filter shows the team name label. "All Teams" button resets.
  - Map-selected visual: blue ring/left-border (`#3B82F6`) — visible on both dark cards and the gold leader card.
  - Map popups: all text forced dark (`color:#1a1a1a`) via inline styles — no longer invisible on the dark theme.
- **Monitor dashboard** at `/monitor/:eventId`:
  - Map toggle: **On Hole** / **All Players** — "On Hole" hides fully-submitted teams to reduce clutter.
  - Clicking a ball dot shows the player's 6-digit ball code + "Fill correction form" button that auto-populates the code field.
  - Map popups: dark text, forced via inline styles and CSS override.
- **Admin correction**: "Distance Drove" field = raw yards; penalty is subtracted server-side to get final score.
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
1. **Polygon vertex editing UX** — after drawing a polygon the user can click it and drag vertices to adjust; works but there's no on-screen hint
2. **GPS trace on desktop** — trace tool designed for walking on-course; desktop users need to use freehand drawing instead
3. **Demo mode CTP** — demo scan only supports Longest Drive, not Closest to Pin
4. **Mobile optimization review** — user requested a full review of all pages at 375px; not yet done
5. **Penalty display formula** — uses a red badge (`raw − pen = final`) that shows on both dark and gold backgrounds; consistent across LD and CTP rows

---

### How I Like to Work
- Make targeted edits — don't rewrite files unless necessary
- Show me specific changes, explain the *why* briefly
- Ask before doing anything destructive (deleting files, dropping DB tables)
- Mobile-first: test that any UI change looks good at 375px width
- The admin panel is used by a non-technical founder — keep the UI language plain and clear
- Read the CHANGELOG.md for full history of past sessions
