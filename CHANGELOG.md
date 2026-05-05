# JORD Golf Tournament System — Version History

---

## v3.1.0 — 2026-05-05
### Session 14 — Zone Map Polish, Marketing Opt-In, Scorecard Removal

#### What Changed

##### Scorecard feature removed
- `course_holes` table creation block removed from `server.js`
- `POST /api/courses/fetch-scorecard`, `GET /api/courses/:courseName/holes`, `GET /api/courses/scorecard-status`, `GET /api/courses/list` endpoints removed
- `ANTHROPIC_KEY` constant removed (was only used by scorecard Anthropic web search call)
- All scorecard CSS (`.sc-course-row`, `.sc-status-dot`, `.sc-hole-table`, etc.), HTML (`#view-scorecard` section, `map-course-data-banner`), and JS (`loadMapCourseData`, `_mapCourseHoles`) removed from `admin.html`
- Course venue search (`GET /api/courses/search`) retained — still used by venue autocomplete

##### Email/SMS marketing opt-in on registration page
- Two new checkboxes added to `/register/:eventId` after the email/phone fields:
  - Email: "Email me results, future events, and offers from JORD Golf." + fine print
  - SMS: "Text me live updates and results from JORD Golf tournaments." + TCPA text
- Consents sent as `email_opt_in` / `sms_opt_in` booleans in the register request body
- Server stores both in new `balls` columns (`email_opt_in INTEGER DEFAULT 0`, `sms_opt_in INTEGER DEFAULT 0`) — auto-migrated on startup
- `subscribeKlaviyo()` async function added to `server.js` — calls Klaviyo `POST /api/profile-subscription-bulk-create-jobs/` with `revision: 2024-02-15` for email and/or SMS lists based on consent. Fire-and-forget (non-blocking). Mocked (logs to console) when `KLAVIYO_KEY` is not set.
- Env vars added: `KLAVIYO_EMAIL_LIST_ID`, `KLAVIYO_SMS_LIST_ID` (read alongside existing `KLAVIYO_API_KEY`)

##### Zone polygon auto-merge
- When any zone is drawn and clipping runs, overlapping polygons of the same kind are automatically merged into one shape before priority clipping
- `mergeKind(kind)` added inside `clipZones()` — calls `unionAll()` on all features of a given kind, deletes the originals, and adds the merged result back to the draw canvas
- Runs for all 5 zone types: fairway, rough, oob, green, ctp_green
- Result: drawing 3 overlapping fairway polygons produces a single merged fairway shape

##### Map Ctrl+Z undo (up to 20 steps)
- `_undoStack` array + `pushUndo()` / `performUndo()` functions added in `admin.html`
- State snapshot (`draw.getAll()`) pushed before: each freehand draw commit, each GPS trace commit, each clear (single or all), and on `draw.selectionchange` when a feature is selected (captures pre-edit state before vertex drag)
- `Ctrl+Z` (or `Cmd+Z` on Mac) in the keydown handler calls `performUndo()` — restores the previous snapshot, re-syncs zone layers
- Stack capped at 20 entries; `_undoLocked` flag prevents re-entrancy during restore

##### Node editing improvements
- Midpoint handles (orange dots between vertices) enlarged from radius 3 → 6 with a white 2px stroke — much easier to grab on a laptop trackpad
- **"✏️ Edit nodes" button** added to the map toolbar
  - Click a zone polygon to select it, then click the button to enter `direct_select` mode
  - `_nodeEditActive` / `_nodeEditFeatureId` state tracks when node editing is live
  - `draw.modechange` listener re-enters `direct_select` automatically after any vertex/midpoint drag (MapboxDraw normally exits the mode after each edit)
  - Stays active until: **Esc** key or **click outside the map canvas**

##### Monitor map first-open race condition fix
- `centerMapOnCourse()` was silently failing on first open: SSE initial snapshot fires immediately on connect, before `initMap()` creates the map object, so `!map` caused an early return and `mapCentered` was never set true — no subsequent event would retry
- Fix: `map.once('load', ...)` inside `initMap()` checks `snap && !mapCentered` and calls `centerMapOnCourse()` if the snapshot already arrived. The monitor map now always auto-locates to the tournament hole on first open.

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | Removed scorecard endpoints + `ANTHROPIC_KEY`; added `email_opt_in`/`sms_opt_in` DB migrations; `subscribeKlaviyo()` function; `KLAVIYO_EMAIL_LIST`/`KLAVIYO_SMS_LIST` constants; register-player stores opt-ins and calls `subscribeKlaviyo` |
| `public/admin.html` | Removed all scorecard HTML/CSS/JS; `mergeKind()` in `clipZones()`; undo stack (`pushUndo`, `performUndo`, Ctrl+Z); node edit state + `draw.modechange` re-entry; `✏️ Edit nodes` toolbar button; midpoint radius 3→6 with white stroke |
| `public/register.html` | Email/SMS opt-in checkboxes with TCPA fine print; sends `email_opt_in`/`sms_opt_in` in request body |
| `public/monitor.html` | `map.once('load', ...)` guard in `initMap()` fixes first-open race condition |
| `.env` | Added `KLAVIYO_EMAIL_LIST_ID` and `KLAVIYO_SMS_LIST_ID` placeholders |

#### Database Changes
```sql
ALTER TABLE balls ADD COLUMN email_opt_in INTEGER DEFAULT 0;
ALTER TABLE balls ADD COLUMN sms_opt_in INTEGER DEFAULT 0;
```
(Auto-applied on server startup — safe on existing databases.)

---

## v3.0.0 — 2026-05-04
### Session 12 — Multi-Admin Auth + Global Leaderboard

#### What Changed

##### Phase 1 — Multi-admin authentication system
- **New DB tables**: `admins` (email, password hash, role, permissions), `sessions` (token → admin mapping, 7-day expiry), `password_reset_tokens`
- **`admin_id` column** added to `events` — every new event is linked to the admin who created it
- **Password hashing**: `crypto.scryptSync` (built-in Node.js, no new npm deps) — `salt:hash` format
- **Session tokens**: 32-byte random hex, stored in DB, checked on every request. Old raw-password tokens rejected cleanly.
- **`requireAuth` rewritten**: DB session lookup instead of env-var comparison. Attaches `req.admin` for all protected routes.
- **`requireSuper`** middleware: blocks non-super admins from admin-management routes.
- **`requirePerm(perm)`** middleware: per-permission gate for tournament admins.
- **Super admin auto-seeded** on first run: `shah82286@gmail.com` / value of `ADMIN_PASSWORD` env var.
- **Event filtering**: `GET /api/events` returns all events for super admin, only own events for tournament admins. `POST /api/events` sets `admin_id = req.admin.id`.

##### Auth API routes (all new)
- `POST /api/auth/login` — email + password → session token + role + permissions
- `POST /api/auth/logout` — deletes session from DB
- `GET /api/auth/me` — returns current admin profile
- `POST /api/auth/forgot-password` — generates reset token, returns reset URL (super admin shares manually until Klaviyo wired)
- `POST /api/auth/forgot-username` — enter name, get masked email back
- `POST /api/auth/reset-password` — validates reset token, sets new password, invalidates all sessions

##### Admin management API routes (super only)
- `GET /api/admins` — list all admins with pending reset token info
- `POST /api/admins` — create tournament admin (name, email, temp password)
- `PATCH /api/admins/:id` — edit name, email, role, active, permissions
- `DELETE /api/admins/:id` — remove admin (blocks deleting last super admin)
- `POST /api/admins/:id/reset-password` — generate 24-hour reset link
- `PATCH /api/admins/:id/password` — change password directly (invalidates all sessions)

##### Admin panel login gate overhaul
- Login form now takes **email + password** (no more single shared password field)
- **Forgot password** flow: enter email → reset link generated → super admin shares it
- **Forgot email** flow: enter name → masked login email shown
- **Reset password** form: shown when `?reset_token=` in URL; validates token, sets password, redirects to login
- Topbar shows logged-in admin name + "Super" label
- Sign out calls `POST /api/auth/logout` before clearing localStorage

##### Admin management panel (super admin only)
- **"👤 Manage Admins"** button in events list header (visible to super admins only)
- Admin list: shows name, email, role badge, active status, permission list, pending reset token link
- Create admin: modal with name, email, temp password
- Edit admin: modal with name, email, new password, per-permission checkboxes, active toggle
- Delete admin: confirm dialog, blocked on last super admin
- Reset password: generates link, shows it in a copyable modal

##### Phase 4 — Global Leaderboard
- **`global_published` column** added to `events` — super admin opts each ended tournament in/out
- `GET /api/global/leaderboard?month=YYYY-MM` — monthly top 10 **fairway-only** drives (public, no auth). Includes available months list.
- `GET /api/global/course-records` — all-time best fairway drive per venue (public)
- `GET /api/global/venue-record?venue=X` — single-venue all-time record (used for Hall of Fame card)
- `GET /api/global/events` — list ended events with eligibility count (super admin only)
- `PATCH /api/events/:id/global-publish` — toggle global_published (super admin only)
- **`/global` page** — public leaderboard with two tabs:
  - Monthly Top 10: gold/silver/bronze rank badges, player name, team, venue, yardage. Month picker auto-populates from available data.
  - Course Records: all-time best drive per course with record holder info.
- **Hall of Fame card** on ended tournament leaderboard: fetches course record asynchronously and shows "Course Record — [Venue]" card with all-time best drive. Falls back to a "View Global Leaderboard →" link if no record exists yet.
- **"🌍 Global LB"** button (super admin only) in events list → management panel to toggle which ended events are published.

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | `admins`/`sessions`/`password_reset_tokens` tables; `admin_id`/`global_published` migrations; `hashPassword`/`verifyPassword`/`createSession`/`getSessionAdmin`; `seedSuperAdmin`; `requireAuth` rewrite; `requireSuper`/`requirePerm`; all auth + admin CRUD + global leaderboard routes; event list/create multi-tenant filtering |
| `public/admin.html` | Email+password login gate; forgot password/username/reset forms; topbar user display + proper logout; Manage Admins panel (CRUD); Global LB management panel (publish toggle); `backToList()` updated; super-admin-only buttons |
| `public/leaderboard.html` | `loadHallOfFame()` async function; HOF card injected on ended tournament; `escHtml()` helper; "View Global Leaderboard →" fallback link |
| `public/global.html` | New file — public global leaderboard page (monthly top 10 + course records tabs) |

#### Database Changes
```sql
CREATE TABLE admins (id, name, email, password_hash, role, active, perm_corrections, perm_end_tournament, perm_manage_players, perm_manage_balls, created_at);
CREATE TABLE sessions (token, admin_id, expires_at, created_at);
CREATE TABLE password_reset_tokens (token, admin_id, used, expires_at, created_at);
ALTER TABLE events ADD COLUMN admin_id TEXT;
ALTER TABLE events ADD COLUMN global_published INTEGER DEFAULT 0;
```
(All auto-applied on server startup — safe on existing databases. Super admin seeded once on first run.)

---

## v2.0.0 — 2026-05-03
### Sessions 10 & 11 — Course Search, Zone Detection, Draw Polish, Map Fly-To

#### What Changed

##### Golf course CSV search & venue autocomplete
- 2.3MB CSV of US golf courses (name, city/state, lat, lon, phone, holes, type) loaded at `data/courses.csv`
- `/api/courses/search?q=` endpoint — lazy-loads CSV on first call, cached in memory, returns top 10 matches by name or city/state (case-insensitive). Custom `parseCSVRow()` handles quoted fields with embedded commas.
- Admin event settings: venue field replaced with an autocomplete that queries `/api/courses/search` after 2 characters (300ms debounce). Dropdown shows course name + city/state + holes + type.
- Selecting a course fills the venue input, flies the admin course map to the course coordinates, and saves `venue_lat` / `venue_lon` hidden fields so coordinates persist to the DB on Save Settings.
- `venue_lat` and `venue_lon` columns auto-migrate on server startup. Included in PATCH allowed fields.

##### Zone auto-detection on scan page
- After GPS locks on a shot, `detectZone(lat, lon)` runs point-in-polygon against the event's mapped fairway, rough, and OOB polygons.
- If inside a zone polygon → that location button is pre-selected automatically.
- If outside all mapped zones → OOB pre-selected with a red "outside all designated zones" note.
- If no polygons are mapped at all → manual picker shown as before (no regression for unmapped events).
- `autoSelectZone()` runs after GPS lock (both real GPS and test-mode simulated GPS).
- `zone-auto-note` div below the location buttons explains the auto-detection to the player.

##### Test tool — course zones on map & zone detection
- Event selector dropdown added to Step 2 simulator. Selecting an event loads that event's zone polygons onto the simulator map (fairway=blue, rough=yellow, OOB=red, green=green) with 25% opacity fill.
- Map click auto-detects zone from the loaded polygons and shows a colored dot + zone label at click point.
- Map fly-to on event selection: full fallback chain — tries fairway → rough → OOB → green polygon (`fitBounds`), then tee boxes (`flyTo` zoom 17), then `venue_lat`/`venue_lon` (`flyTo` zoom 15). Whichever has data wins.
- Location type dropdown removed from Step 2 (zone is inferred from the map now).

##### Polygon non-overlapping via Turf.js
- Turf.js v6 CDN added to admin.html.
- `clipZones()` runs 200ms after any `draw.create` or `draw.update` event (debounced via `scheduleClipZones`).
- Priority: Fairway > Rough > OOB. Fairway is never clipped. Rough is clipped against the fairway union. OOB is clipped against the combined fairway+rough union.
- Zones snap tight — no gap or overlap between adjacent polygons.

##### Admin draw mode stays active
- After completing a freehand zone draw, the cursor stays crosshair and draw mode remains active for the same zone type — draw again immediately without re-clicking the zone button.
- Success toast changes to "drawn — draw again or press Esc to finish".
- If a draw fails (too few points), cursor stays crosshair so the user can try again without re-clicking.
- **Esc key** → exits draw mode, restores map hand cursor.
- **Click outside the map** → also exits draw mode (clicking zone buttons is excluded, so switching zones works normally).
- `stopFreehand()` helper function added; handles all exit cleanup.

##### 6-box OTP code entry (scan page)
- `renderCodeEntry()` rewritten with 6 individual `<input>` elements (one per character) in an OTP-style row.
- Auto-advance: typing a character moves focus to the next box automatically.
- Backspace navigation: backspace on an empty box moves focus to the previous box.
- Paste distribution: pasting a 6-character string fills all boxes at once.
- Enter key submits from any box.
- `autocapitalize="none"` — keyboard stays in whatever mode the player last used (no snapping back to ABC after each character). Input handler applies `.toUpperCase()` in JS.
- `flex:1; min-width:0` per box ensures equal sizing across all screen widths.

##### Registration page UX overhaul
- Team name input always appears last — only shown after all 4 players have entered codes (or after confirming "Submit with fewer").
- Requires all 4 codes to be entered before the team name step appears.
- "Submit with X players" is a ghost button below an "— or —" divider, not a popup alert.
- Clicking it shows an inline yellow warning box with Confirm / Cancel (no browser `alert()`).
- Confirming the inline flow skips to the team name step with a yellow "submitting with N players" note.

##### /scan route fix
- `GET /scan` (no code) returned "Cannot GET /scan" — the pages map only had `/scan/:code`.
- Fixed by adding `'/scan': 'scan.html'` alongside `/scan/:code` in the static-page route map.

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | `/scan` route; `venue_lat`/`venue_lon` auto-migrate + PATCH fields; `parseCSVRow()`; `loadCourses()` lazy loader; `/api/courses/search` endpoint |
| `public/admin.html` | Turf.js CDN; `clipZones()` + `scheduleClipZones()`; venue autocomplete replaces Mapbox Places; hidden `venue_lat`/`venue_lon` inputs; `stopFreehand()`; draw mode stays active after draw; Esc + click-outside exit |
| `public/scan.html` | `detectZone()`, `autoSelectZone()`, `zone-auto-note`; 6-box OTP code entry with auto-advance/backspace/paste/Enter |
| `public/test.html` | Event selector dropdown; `loadSimEvent()` with full fallback fly-to chain; `renderSimPolygons()` zone overlays; zone auto-detect on map click; location dropdown removed |
| `public/register.html` | `submittingWithFewer` state; team name always last; 4-code requirement; inline fewer-player confirmation |
| `data/courses.csv` | New file — US golf course database |

#### Database Changes
```sql
ALTER TABLE events ADD COLUMN venue_lat REAL;
ALTER TABLE events ADD COLUMN venue_lon REAL;
```
(Auto-applied on server startup — safe on existing databases.)

---

## v1.9.0 — 2026-05-03
### Session 9 — Start Gate, Zone Detection, End-Tournament Screen, Player Flow Polish

#### What Changed

##### Tournament start gate
- All player-facing API routes now require `status = 'active'`: `register-player`, `finalize-team`, `scan/ld/:code`, `scan/cp/:code` return 403 with a clear error message if the tournament is in setup or ended state
- `register.html` blocks on `setup` status with "Tournament hasn't started yet" (previously only blocked on `ended`)
- `scan.html` shows a "Not Started Yet" banner when `event_status === 'setup'`

##### Zone auto-detection — fixed
- `/api/ball/:code` now returns `rough_polygon`, `oob_polygon`, `ctp_green_polygon`, and `cp_off_green_penalty_ft` — previously only `fairway_polygon` was returned, silently breaking client-side zone detection
- `detectZone()` now distinguishes `'oob_outside'` (ball is outside all mapped zones) from `'oob'` (ball is explicitly inside the OOB polygon) — each shows a different styled message
- `checkCTPZone(lat, lon)` — new function runs on GPS lock for CTP contests: checks if position is inside the green polygon; shows a prominent red warning with penalty amount if off-green

##### Not-scored rule explanation on result card
- When `allow_rough = 0` and the shot landed in rough, result card shows an amber rule box: "📋 Why 0 yards? Rough drives are not scored in this tournament — only fairway drives count."
- Same for `allow_oob = 0` with OOB / lost ball shots
- `getEncouragement()` updated: no longer says "still on the board!" when the shot type does not score in this event

##### Admin Players tab — score column
- Each player row now has a Score column: `final_yards yd` with a location sub-line, or a red penalty breakdown (`raw−penalty=final`) when a penalty applied, or `—` if not yet scanned
- Column hidden on mobile (≤375px) alongside Code and Email to keep the layout compact

##### Leaderboard penalty badge
- Team total penalty badge text changed from `−20 yd penalty` (implied a further deduction) to `20 yd penalty applied` (makes clear the number shown already reflects it)

##### End-of-tournament leaderboard screen
- When `status = 'ended'`, the leaderboard prepends a full summary section above the team rankings:
  - **Total Yards hero** — large lime number, all players' combined distance + a fun comparison phrase ("That's 3.2× the length of the Golden Gate Bridge!")
  - **Zone stats grid** — 4 cells in zone colour: In Fairway / In Rough / Out of Bounds / Lost Balls
  - **Champion showcase** — lime-bordered card with winning team name, combined yards, and each player's individual drive sorted best-to-worst with location icon and yardage
  - **"All Teams" divider** before the standard ranked rows
- **Map auto-opens** when tournament ends — all ball dots visible on satellite; click any team card to filter to just that team's 4 dots (existing map-filter behaviour unchanged)

##### Monitor team colors + standings highlight (#4)
- 12-color `TEAM_COLORS` palette assigned to teams on first appearance, cached in `teamColorMap` for the session
- Map dots render in team color (grey if not yet scanned)
- Each team row in Current Standings gets a color-dot + 📍 button; tap to filter map to that team (non-filtered dots dim to 18% opacity, map fits to filtered bounds)
- "× All Teams" button in map header clears the filter
- Legend updated: "Each color = one team" / "Not yet scanned" / "Tap 📍 to focus"

##### Keyboard stays in mode on code entry (#8)
- Root cause: 6 separate `<input>` elements caused keyboard to reset mode (letters↔numbers) on every focus change
- Fix: replaced with 6 visual `<div>` boxes + one hidden `<input>` that holds focus throughout entry
- `autocapitalize="characters"` on hidden input auto-uppercases letter entry; blinking cursor indicates active box

##### Leaderboard map full-screen expand
- Map was clipped at the bottom in flex layout — fixed with `min-height: 0` on `.lb-map-container`
- "Map" toggle adds `map-expanded` class to `.lb-content`: hides scores column, map takes full width
- Scrollable team strip below map: rank + name + score per row; tap to filter (tap again to clear)

##### Admin panel tab state on reload
- Reload always reset to Events list regardless of active panel
- `showPanel()` now calls `history.replaceState` with `#eventId/panel` after every switch
- `init()` reads and restores from hash on load; `backToList()` clears the hash

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | Start gate on register-player, finalize-team, scan/ld, scan/cp; ball lookup returns rough_polygon, oob_polygon, ctp_green_polygon, cp_off_green_penalty_ft |
| `public/leaderboard.html` | Penalty badge text; end-tournament banner (hero, zone grid, champion card, divider); map auto-open on end; `min-height:0` fix; `map-expanded` class; `.lb-map-teams` team strip; `renderMapTeams()` |
| `public/admin.html` | Score column in Players tab; mobile CSS hides score col; `history.replaceState` in `showPanel`; hash-based restore in `init` |
| `public/monitor.html` | `TEAM_COLORS` palette; `getTeamColor()`; `setTeamFilter()`; `updateMapDots` team-color + dim logic; 📍 button in team rows; filter info bar |
| `public/register.html` | Blocks registration when status = 'setup' |
| `public/scan.html` | Not-started banner; oob_outside detection; checkCTPZone; not-scored rule explanation; getEncouragement updated; `checkRing` helper; `pointInPolygon` FeatureCollection fix; 6-div + hidden-input code entry |

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
