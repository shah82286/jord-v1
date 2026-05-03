# JORD Golf Tournament System — Version History

---

## v1.8.0 — 2026-05-03
### Session 8 — ESRI Imagery, Hole Tour, CTP Override, UI Polish

#### What Changed

##### ESRI World Imagery — all maps
- All 6 Mapbox map initializations (admin, leaderboard, monitor, scan ×2, test) now use ESRI World Imagery tiles instead of Mapbox satellite
- `JORD.satelliteStyle()` helper added to `jord.js` — returns a Mapbox GL JS style object using ESRI raster tiles. Single source of truth, called in every map init
- Sharper resolution for many US golf courses; free, no provider change required

##### Leaderboard — Hole Tour
- **"🎬 Hole Tour" button** added to the map toolbar (next to All Teams filter)
- Animated satellite camera tour of the hole: tee → fairway sweep → pin approach → 360° orbit → overhead pullback
- Camera pitches to 65° at tee, sweeps along the hole at zoom 18→17.5→19.5, orbits pin for 9 seconds, pulls back to full overview
- "■ Stop" turns button red mid-tour; clicking stop smoothly flies back to overhead view rather than freezing
- "HOLE TOUR" badge overlay on map while active
- Works for both LD and CTP modes — uses correct pin/tees for whichever tab is active
- Gracefully handles missing pin (shows warning toast)

##### Tournament lifecycle button
- New tournament now shows **"▶ Start tournament"** (btn-primary) instead of "End tournament"
- 3-state logic: setup → `▶ Start tournament`, active → `⏹ End tournament` (btn-danger), ended → `🔓 Re-open tournament` (btn-ghost)

##### Custom modals — no more browser dialogs
- All native `prompt()` and `confirm()` calls replaced with `JORD.prompt()` / `JORD.confirm()` custom modals across admin.html and monitor.html
- `APP.prompt()` added to `jord.js` — returns a Promise, supports placeholder, defaultValue, okText; Enter key submits

##### Zone color swap
- Fairway: `#3B82F6` (blue), Green/CTP: `#22C55E` (green) — corrected to match real-world intuition
- `kindColor` MapboxDraw expression, zone layer colors, legend CSS, toolbar emoji dots all updated
- Leaderboard and admin map legend colors updated to match

##### Multiple zones per type (FeatureCollection)
- `saveMap` now collects all polygons per zone type into a FeatureCollection instead of overwriting with the last polygon
- `loadPolygon` handles both old (bare Polygon) and new (FeatureCollection) format — backward compatible
- Server `perpendicularDistanceToPolygon` and `pointInPolygon` updated to iterate over all features in a FeatureCollection

##### Admin map polygon fill colors
- DrawStyle inactive fill set to `opacity: 0` — removes gray overlay that was hiding zone colors
- Active fill: white tint at 0.15 opacity
- Zone layers (`zone-fill-*`, `zone-stroke-*`) added without `before` parameter — renders above satellite, fills visible
- `ctp_green_polygon` added to `/api/events/:id/public` response

##### GPS accuracy + CTP manual override
- Admin GPS pin grab early-stop threshold lowered: `GOOD_ENOUGH_M = 4` → `3`
- CTP scan form now shows **"Rangefinder distance (ft)"** optional input — player or rep can enter physical rangefinder reading
- If provided, `manual_ft` overrides GPS-calculated distance; green-check (off-green penalty) still uses GPS coordinates
- Server `/api/scan/cp/:code` accepts `manual_ft` in request body

##### Removed redundant Activate button
- "Activate tournament" button removed from Settings tab — replaced by new 3-state lifecycle header button

#### Files Changed
| File | What changed |
|------|-------------|
| `public/js/jord.js` | `JORD.satelliteStyle()` ESRI tile helper; `APP.prompt()` custom modal |
| `public/admin.html` | 3-state lifecycle btn; ESRI map; custom modals; zone color swap; FeatureCollection save/load; DrawStyle fill fix; zone layers without `before`; GPS threshold 3m; removed Activate btn |
| `public/leaderboard.html` | ESRI map; Hole Tour button + animation + stop; zone color swap; FeatureCollection addZone/updateZoneLayers |
| `public/monitor.html` | ESRI map; async confirm() modals |
| `public/scan.html` | ESRI map; CTP rangefinder manual ft input; `doSubmitCP` passes `manual_ft` |
| `public/test.html` | ESRI map |
| `server.js` | `ctp_green_polygon` in public API; `pointInPolygon` + `perpendicularDistanceToPolygon` FeatureCollection support; CTP endpoint accepts `manual_ft` |

---

## v1.7.0 — 2026-04-28
### Session 7 — ngrok iPhone Testing, Course Map Polish, Penalty Box Fix

#### What Changed

##### ngrok full-device testing
- `ngrok http 3000` tunnels localhost to a public HTTPS URL — required for iPhone GPS (Safari blocks geolocation on plain HTTP)
- `/api/server-info` now queries the ngrok local API (`localhost:4040/api/tunnels`) and returns `ngrokUrl` in JSON response
- Test page (`/test.html`) auto-uses `ngrokUrl` from server-info when available, so QR codes on the test page link to the ngrok URL even when the page is loaded from localhost
- Monitor QR in the "Connect" section now loads dynamically after events fetch and uses the first active event ID (previously showed useless `/monitor` with no ID)
- Per-event QR row updated to include: Leaderboard, Rep Monitor, Register, Submit Shot
- `/qr.html` — new standalone QR code page that generates a scan QR pointing to `/scan`; auto-adapts to ngrok or localhost

##### Course setup map — polygon rendering fixes
- **Zone layer priority order** — layers added in order `oob → rough → fairway → green → ctp_green` so higher-priority zones render on top
- **`syncZoneLayers` `return` → `continue` fix** — if any zone GeoJSON source was missing, the old `return` stopped ALL zone source updates; fixed to `continue` so other zones still update
- **MapboxDraw inactive fill opacity restored** — was set to 0 (invisible when not selected); restored to `0.35` fill / `0.8` stroke so polygons remain visible after deselecting
- **`scheduleClipZones()` now called after freehand drawing** — `draw.add()` does not fire `draw.create` event (only user-interaction drawing does), so `scheduleClipZones` was never running after freehand. Fixed by calling it explicitly in `finishFreehand` and GPS trace stop
- **`turf.simplify` on polygon completion** — freehand and GPS trace polygons now simplified with `tolerance: 0.000015, highQuality: true`, reducing hundreds of drag points to ~10–30 clean vertices
- **Popup legibility** — `.mapboxgl-popup-content` CSS override forces `background:#fff; color:#1a1a1a` regardless of dark page theme; tee box popup HTML given inline dark styles

##### Penalty math box
- Red penalty math box (`raw − pen = final`) no longer wraps onto two lines — added `white-space:nowrap` to both LD and CTP penalty badge elements in leaderboard

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | `/api/server-info` queries ngrok local API, returns `ngrokUrl` |
| `public/admin.html` | Zone layer priority order; syncZoneLayers continue fix; inactive fill opacity restored; scheduleClipZones in finishFreehand + GPS trace; turf.simplify in both; popup CSS override + tee popup inline styles |
| `public/leaderboard.html` | `white-space:nowrap` on LD + CTP penalty math badges |
| `public/test.html` | Uses `info.ngrokUrl` for QR base URL; monitor QR loads after events fetch; per-event QR row expanded |
| `public/qr.html` | New file — standalone scan QR page |

---

## v1.5.0 — 2026-04-28
### Session 5 — Rumble Brand Color Theme

#### What Changed
- Full platform retheme to match Rumble Golf Co. brand identity
- Replaced warm cream/gold palette with deep forest green + neon lime-green
- New `:root` variables in `public/css/jord.css`:
  - `--bg` / `--jord-fairway` → `#0C2010` (deep forest green background)
  - `--surface` → `#142B17`, `--surface-2` → `#1C3A20` (dark green card surfaces)
  - `--jord-gold` / `--accent` / `--primary` → `#BEFF3A` (neon lime-green)
  - `--jord-gold-2` → `#A8E62E` (darker lime for hovers)
  - `--ink` → `#F0F7E8` (soft light text), `--ink-2` → `#7FA882` (muted green)
  - `--danger` → `#FF4C4C` (brighter red on dark bg)
  - `--border` uses `rgba(190,255,58,0.12)` (lime tint instead of old green)
- `.theme-dark` (TV leaderboard) updated to match — same green family, even richer
- `.lb-row.is-leader` and `.theme-dark .lb-row.is-leader` text changed from `var(--jord-charcoal)` to `var(--primary-ink)` so leader-row text stays dark on the bright lime background
- `.btn-accent` text color changed to `var(--primary-ink)` (consistent)
- All hardcoded `#C9A24A` (old gold) in admin.html, leaderboard.html, scan.html, test.html, mapdiag.html → `#BEFF3A`
- All hardcoded `rgba(201,162,74,…)` tint backgrounds → `rgba(190,255,58,…)`
- Print button in admin QR modal updated from dark-green to lime

#### Files Changed
| File | What changed |
|------|-------------|
| `public/css/jord.css` | Full `:root` palette swap; `.theme-dark` update; `.is-leader` text fix; `.btn-accent` text fix |
| `public/admin.html` | All `#C9A24A` → `#BEFF3A`; accent tint backgrounds updated; print button rethemed |
| `public/leaderboard.html` | All `#C9A24A` → `#BEFF3A`; badge rgba updated |
| `public/scan.html` | All `#C9A24A` → `#BEFF3A` (shot line, tee marker, ball marker) |
| `public/test.html` | All `#C9A24A` → `#BEFF3A`; accent tint updated |
| `public/mapdiag.html` | `#C9A24A` → `#BEFF3A` |

---

## v1.3.0 — 2026-04-27
### Session 4 — Course Map Overhaul, Two-Hole Setup, GPS Accuracy, Mobile Optimization

---

### What Was Built

#### Two-hole map configuration (Longest Drive + Closest to Pin)
- Admin Course Map now has two separate hole tabs: **🏌️ Longest Drive Hole** and **📍 Closest to Pin Hole**
- Each hole has its own independent tee boxes, pin location, and zone polygons
- Tab bar only appears when both contests are enabled in Settings
- CTP hole only shows Green polygon tool (no Fairway/Rough/OOB)
- Saving the map saves only the active hole's data — the other hole is untouched
- New database columns auto-migrated on startup: `ctp_pin_lat`, `ctp_pin_lon`, `ctp_green_polygon`, `ctp_hole_distance_yards`
- CP scan endpoint (`/api/scan/cp/:code`) uses `COALESCE(ctp_pin_lat, pin_lat)` for backwards compatibility

#### Freehand polygon drawing
- Replaced MapboxDraw's click-to-place polygon tool with a **click-and-drag freehand drawing** system
- Hold mouse button and drag to trace any shape — release to finish
- Points are throttled to 6px minimum distance for smooth paths without noise
- `map.dragPan` is disabled during drawing so the map doesn't pan
- Built-in polygon mode button hidden; only freehand is exposed

#### Color-coded zone polygons (definitive fix)
- Each zone type (Fairway / Rough / OOB / Green / CTP Green) gets its own dedicated Mapbox GL GeoJSON source and fill layer with a hardcoded color
- Colors exactly match the toolbar button borders: Fairway `#22C55E`, Rough `#EAB308`, OOB `#DC2626`, Green/CTP Green `#3B82F6`
- `syncZoneLayers()` keeps the colored layers in sync after every draw, delete, or GPS trace operation
- MapboxDraw's own fill set to ~0 opacity (for click-detection only) — all visible color comes from dedicated layers
- Map legend swatches updated to 14×14px solid colors matching the above

#### Selective polygon clearing
- **Clear with a polygon selected** → removes only that one polygon
- **Clear with nothing selected** → shows confirmation dialog, then clears all zones for the current hole tab

#### Tee box numbering (T1, T2, T3…)
- Tee box markers on the map now show T1, T2, T3 (numbered independently within LD tees and CTP tees)
- Tee list rows show "T1 — Men's", "T2 — Women's", etc.
- Delete tee box fixed with try/catch and success message; delete button styled as `btn-danger`

#### Per-tee distances to pin
- Distance section replaced single value with a row per tee box showing `T1 (Men's): 285 yd`, `T2 (Women's): 260 yd`, etc.
- Updates live whenever a pin is moved, tee is moved, or hole tab is switched
- Manual override input preserved below the calculated rows

#### Pin coordinate display
- After placing a pin (via click, GPS grab, or drag), latitude and longitude are displayed in a visible readout below the distance section
- Updates on every pin action and on hole tab switch

#### GPS Pin Grab — accuracy overhaul
- Changed from `getCurrentPosition` (single fast/inaccurate reading) to a 10-second `watchPosition` loop
- Keeps the **best (most accurate) reading** across all samples
- Stops early if accuracy reaches ≤4m
- Live toast updates showing "best so far ±Xm, hold still…"
- Reports final accuracy in the success message

#### GPS Trace — accuracy overhaul
- Added warm-up phase: records location but doesn't plot points until GPS accuracy ≤15m
- During active trace, skips any point with accuracy >10m
- Live `GPS ±Xm` accuracy badge next to the Stop Trace button (green when good, yellow when poor)

#### Mobile optimization (all pages)
- **jord.css global**: `overflow-x: hidden` on html/body; 44px min touch targets on all buttons; field-grid collapses to 1 column; stat-grid uses 2 columns; tables get horizontal scroll wrapper; toasts move to full-width bottom bar; modals become bottom sheets; map containers reduce to 300px height
- **admin.html**: Event header buttons wrap on small screens; editor nav becomes horizontal scrollable tab bar; map tools shrink to 12px with 36px targets; tee coord inputs allowed to wrap; players table wrapped in scroll container; card padding tightens
- **leaderboard.html**: Score font sizes scale down at 700px and 400px; topbar wraps; map column reduces to 280px when stacked
- **monitor.html**: Map reduces to 280px on mobile; stats bar 2-column; correction row stacks vertically
- **scan.html**: Result score and flyover yardage scale down; result buttons wrap and share width on narrow phones

---

### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | CTP DB columns auto-migration; `ctp_*` fields in PATCH allowed list; COALESCE in CP scan query |
| `public/admin.html` | Two-hole tabs; freehand drawing; dedicated zone GL layers + `syncZoneLayers()`; T1/T2/T3 numbering; per-tee distances; pin coords display; GPS pin grab accuracy; GPS trace accuracy + warm-up; selective clear; delete fix; full mobile responsive overhaul |
| `public/leaderboard.html` | Zone polygon colors updated; CTP pin marker added; mobile breakpoints improved |
| `public/monitor.html` | Default map center changed to US center; `centerMapOnCourse()` on first SSE event; mobile breakpoints |
| `public/css/jord.css` | Global mobile fixes: overflow, touch targets, toast position, modal bottom sheet, map height, table scroll, field-grid, stat-grid |
| `public/scan.html` | Mobile padding/font size improvements for small phones |

---

### Database Changes
Auto-migrations added to `server.js` startup (safe to run on existing databases):
```sql
ALTER TABLE events ADD COLUMN ctp_pin_lat REAL;
ALTER TABLE events ADD COLUMN ctp_pin_lon REAL;
ALTER TABLE events ADD COLUMN ctp_green_polygon TEXT;
ALTER TABLE events ADD COLUMN ctp_hole_distance_yards REAL DEFAULT 0;
```

---

### Known Gaps / Next Steps
- [ ] Polygon vertex editing: after freehand draw, user can select polygon and edit individual vertex points — works via MapboxDraw direct_select but UX could be clearer
- [ ] GPS trace on desktop: trace tool is designed for walking on-course with a phone; desktop testing requires manual coordinate entry
- [ ] CTP hole distance (yards) shown in tee-to-pin but not yet used in scoring formula (CP scan uses haversine from ball to pin directly)
- [ ] Leaderboard map: ball dots use old zone colors — should update to match new `#22C55E` / `#EAB308` / `#DC2626` / `#3B82F6` palette

---

## v1.2.0 — 2026-04-27
### Session 3 — Flyover Animation + Demo Scan Mode

---

### What Was Built

#### Flyover shot animation after scan submission
- After a player submits a Longest Drive shot, the result screen now shows:
  1. A satellite map zoomed to the hole (Mapbox, lazy-loaded — no page weight unless scan is submitted)
  2. A gold line that draws itself from the tee box to the ball landing spot over 1.8 seconds (ease-out)
  3. The ball landing marker pops in when the line reaches it
  4. The yardage counter counts up from 0 to the final distance over 0.7 seconds
  5. The full result card fades in below (player, team, location badge, penalty breakdown)
- Falls back to the static result card if Mapbox token is not configured
- Server now includes `tee_lat`, `tee_lon`, `ball_lat`, `ball_lon`, `event_id`, and polygon data in the LD scan response

#### Demo Scan QR — no registration needed
- Any phone can now open a demo scan experience with zero setup — no ball code, no player registration
- From the test page (`/test`): pick a GPS location on the simulator map, pick an event, click "Generate Demo Scan QR"
- Scan that QR on your phone → lands on the scan submission screen as "Demo Player"
- On submit, distance is calculated client-side (haversine formula — no server write)
- Flyover animation plays exactly as it would in a real tournament
- A teal "DEMO MODE — Not saved to leaderboard" banner makes it clear
- Demo URL format: `/scan/DEMO?demo=1&eventId=XXX&testLat=X&testLon=Y&testLoc=fairway`

#### New server endpoints
- `GET /api/events/:id/public` — no auth required, returns event setup info (tee boxes, polygons, pin, scoring config) for the demo scan mode

---

### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | Added `rough_polygon`, `oob_polygon` to LD scan SELECT; added animation coords to LD scan response; added `/api/events/:id/public` endpoint |
| `public/scan.html` | `loadDemoMode()`, `haversineYardsClient()`, demo-aware `doSubmitLD()`, `renderResultLD()` with flyover, `startFlyoverMap()`, `startCountUp()`, `appendResultCard()`, `loadMapboxThen()` (lazy Mapbox load) |
| `public/test.html` | "Demo Scan QR" card with event picker, location picker, QR generation |

---

### Known Gaps
- [ ] Demo mode only supports Longest Drive events (not Closest to Pin)
- [ ] Backyard walk-through test still pending (register → place tee/pin → real GPS scan)

---

## v1.1.0 — 2026-04-27
### Session 2 — Phone Testing, QR Codes, Leaderboard Map, UX Polish

---

### What Was Built

#### Admin password now saves (no more re-entering)
- Changed auth token storage from `sessionStorage` to `localStorage` in `public/js/jord.js`
- Password persists across browser sessions. Only clicking "Sign out" clears it.

#### Leaderboard now has a live course map
- Added a "🗺 Map" toggle button in the leaderboard topbar (`public/leaderboard.html`)
- Clicking it opens a side panel (420px wide on desktop, full-width on mobile) showing:
  - Satellite map of the course
  - Fairway / rough / OOB / green polygon overlays in color
  - Gold tee box markers, red pin marker
  - Player ball positions as colored dots (gold = drive, blue = pin shot, red = OOB)
  - Clicking any dot shows player name, team, and score in a popup
  - Updates live via the SSE feed every time a player scans
- Tee boxes are now included in the SSE broadcast payload (`server.js → broadcast()`)

#### QR codes in admin — Print QR Codes button
- Added "🖨 Print QR Codes" button to the Ball Pool panel in admin
- Opens a clean printable page with:
  - One "Register Here" QR code (links to `/register/EVENT_ID`)
  - One scan QR code per ball code in the pool
  - Green background = already assigned to a player (player name shown below)
- **QR images are server-generated** via a new `/api/qr` endpoint — no CDN dependency

#### Server-side QR code generation (`server.js → /api/qr`)
- Uses the already-installed `qrcode` npm package (Node.js version)
- Any URL is converted to a PNG image at `/api/qr?data=URL&size=200`
- Used by the admin print page, the test tools page, and the leaderboard event links
- Works completely offline — no internet required

#### Phone testing tools page (`/test`)
- New page at `http://localhost:3000/test`
- Detects your computer's local Wi-Fi IP address (`/api/server-info` endpoint)
- Displays that IP address so you can type it on your phone
- Shows QR codes for Admin and Ball Scan pages — scan with phone camera to open
- GPS Coordinate Simulator: click anywhere on a Mapbox map to pick a fake "shot location", enter a ball code, select location type (Fairway/Rough/OOB), generate a test scan link with a QR code
- Opening that test link on your phone submits the shot using the simulated coordinates — no need to be on a golf course
- Shows QR codes for all your events (Leaderboard + Registration) for quick phone access
- Step-by-step guide for running a full backyard test

#### GPS test mode on the scan page (`public/scan.html`)
- URL params `?testLat=X&testLon=Y&testLoc=TYPE` override real GPS for testing
- A teal "TEST MODE" status bar shows when simulated GPS is active
- The location type (fairway/rough/OOB) is pre-selected from the URL param
- Generated automatically by the test tools page — no manual URL editing needed

#### Pin location info + tee-to-pin distance in admin Course Map
- A new info panel appears below the tee box list whenever a pin is placed
- Shows pin latitude and longitude to 6 decimal places
- Shows distance from each tee box to the pin in **yards and feet**
- Updates live as you drag the pin marker or drag/update tee box positions
- Helps verify measurements before activating a tournament

---

### Files Changed
| File | What changed |
|------|-------------|
| `public/js/jord.js` | `sessionStorage` → `localStorage` for auth token |
| `public/leaderboard.html` | Added Mapbox map panel, two-column layout, live ball markers |
| `public/admin.html` | QR print button, pin info panel, tee-to-pin distance display |
| `public/scan.html` | GPS test mode via URL params (`testLat`, `testLon`, `testLoc`) |
| `public/test.html` | New file — phone testing tools page |
| `server.js` | `/api/qr` endpoint, `/api/server-info` endpoint, tee_boxes in SSE broadcast, `/test` page route |

---

### Database Changes
No schema changes in this session. The server auto-applied CTP column additions (`ctp_pin_lat`, `ctp_pin_lon`, `ctp_green_polygon`, `ctp_hole_distance_yards`) from a separate update to `server.js`.

---

### Known Gaps Going Into Next Session
- [ ] Need to test full backyard walk-through: register → place tee/pin at home address → trace fake fairway → scan on phone with real GPS
- [ ] QR codes in the print page appear but may need to wait a moment to render (server generates them as images on demand)
- [ ] TV Mode with map open: the map column width in TV mode should be tested on a real TV display
- [ ] The leaderboard map auto-opens based on button click — consider defaulting it open on tablet/desktop
- [ ] PWA offline mode (Phase 2) — still not implemented; scan page has no retry queue yet
- [ ] Golfbert API for course data autocomplete (Phase 2)

---

## v1.0.0 — 2026-04-26
### Initial Build

**Architecture decisions:**
- Node.js / Express backend — chosen for real-time SSE, simplicity, and existing team familiarity
- SQLite via better-sqlite3 — zero-config local database, upgradable to PostgreSQL for multi-server
- Mapbox GL JS — free tier covers 50k map loads/month, satellite imagery, polygon drawing
- Klaviyo for email + SMS — matches existing drop system stack
- Server-Sent Events (SSE) for real-time leaderboard — simpler than WebSockets for broadcast use case

**Features shipped:**
- Tournament event creation with scoring toggle configuration
- Multiple tee box GPS support per hole (men's / women's / senior)
- Ball pool bulk assignment from drop system codes
- On-course player registration: ball-by-ball, team name last
- Longest Drive: GPS lock on scan, fairway/rough/OOB scoring
- Rough penalty: perpendicular distance to fairway polygon
- OOB penalty: configurable half-hole or fixed yards
- Closest to Pin: hidden until submission, pin drag-and-drop
- Admin monitoring dashboard: live dot map, rep alerts, corrections
- Range finder manual entry with separate penalty field
- Offline queue for ball scans in dead zones
- Live SSE leaderboard with TV display mode
- "Dethroned" SMS via Klaviyo on leadership change
- End tournament: ball conversion, Klaviyo blast, winner display
- Player permanent dashboard link
- CSV export of all player data
- 48/48 unit tests passing

**Known gaps (Phase 2):**
- Fairway polygon drawing UI (admin map tracing — server handles data, UI pending)
- Satellite dot map for end-of-tournament display
- Shareable static image card generation
- Full personal dashboard UI
- PWA offline service worker
- Golfbert API integration for course data
- Closest to pin stylized green display
- Combined scoring across holes

**Database schema version:** 1
**Mapbox SDK version:** 3.x (GL JS)
**Klaviyo API revision:** 2024-02-15

---

## How to Version Going Forward

When making changes:
1. Update version in package.json
2. Add entry to this CHANGELOG
3. Note any database schema changes (migrations required)
4. Run `npm test` — all tests must pass before tagging

Schema migrations: add SQL to a `migrations/` folder named `002-description.sql`, `003-description.sql`, etc. Apply in order on existing databases.

---

## Architecture Notes for Future Developers

**SSE broadcast pattern:**
`broadcast(eventId)` is called after every scan, correction, and team registration. It pushes the full leaderboard state to all connected clients. This is intentionally stateless — the client always receives the full picture, never a diff.

**GPS locking on page load:**
The scan page captures GPS coordinates immediately on load via `navigator.geolocation.getCurrentPosition`. The result is stored in a local variable. The "submit" button is revealed only after GPS + in-play selection are complete. This prevents players from walking to a better position and then submitting.

**Offline handling (Phase 2):**
GPS works without internet (satellite-based). The scan page should cache the GPS reading in localStorage and retry submission with exponential backoff when signal returns. This is stubbed but not yet implemented as a service worker.

**Ball lifecycle:**
`pre_tournament` → `tournament` (bulk assignment) → `drop` (end tournament, used) or `available` (end tournament, unused)

**Adding Closest to Pin later:**
The `balls` table has `cp_*` columns already. The `getCPLeaderboard()` function is live. Only the frontend display pages (stylized green, dot placement) need to be built.
