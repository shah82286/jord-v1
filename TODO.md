# JORD Golf — To Do List

Numbers stable — reference by number (e.g. "let's do #3").
Nothing built until confirmed. Move to In Progress / Done as we go.

---

## Backlog

**#PRE-1 — Get on HTTPS hosting**
Required before any live events. iPhone Safari blocks GPS access on plain HTTP — without HTTPS, no iPhone user can submit a scan. Need an SSL certificate on the production server (free via Let's Encrypt on most hosts). Must also update `APP_URL` in `.env` to the HTTPS domain.

**#PRE-2 — Wire up or formally defer SMS/email (Klaviyo)**
Klaviyo is integrated in the code but currently mocked — no texts or emails actually send. Options: (a) add the real Klaviyo API key and test the sends, or (b) formally decide to defer and set client expectations in writing before first paid event.

**#PRE-3 — Upgrade monitor page to session auth**
The rep monitor (`/monitor`) still uses an old shared-password system stored in `localStorage`. The admin panel uses proper session tokens. Monitor should be upgraded to the same login system so reps get their own accounts and the shared password is retired.

---

## In Progress

*(nothing yet)*

---

## Done

**#ZONE-MERGE — Overlapping same-kind zone polygons auto-merge** ✓
Built in v3.1.0. Drawing multiple fairway (or rough/OOB/green) polygons that overlap automatically merges them into one shape. `mergeKind()` runs inside `clipZones()` before priority clipping — uses `turf.union` to combine, deletes originals, adds merged result back to the draw canvas.

**#MAP-UNDO — Ctrl+Z undo for map zone adjustments** ✓
Built in v3.1.0. Up to 20-step undo stack. State snapshots captured before each freehand draw, GPS trace, clear operation, and on feature selection (pre-vertex-drag). `Ctrl+Z` / `Cmd+Z` anywhere on the admin page restores previous state.

**#MAP-NODES — Node editing with persistent direct_select mode** ✓
Built in v3.1.0. "✏️ Edit nodes" toolbar button enters `direct_select` for selected polygon. `draw.modechange` listener re-enters `direct_select` after each vertex/midpoint drag so editing stays active. Midpoint handle radius enlarged (3→6) with white stroke. Exits on Esc or click outside map.

**#KLAVIYO-OPTIN — Email/SMS marketing opt-in on registration** ✓
Built in v3.1.0. Email and SMS checkboxes on `/register/:eventId` with TCPA fine print. Consents stored in `balls.email_opt_in` / `balls.sms_opt_in`. `subscribeKlaviyo()` in `server.js` sends to Klaviyo subscription bulk-create API (mocked when key not set).

**#SCORECARD-REMOVE — Remove scorecard feature** ✓
Removed in v3.1.0. Deleted `course_holes` table, 4 scorecard API endpoints, `ANTHROPIC_KEY`, and all scorecard HTML/CSS/JS from admin.html. Venue course search (`/api/courses/search`) retained.

**#9 — Global Leaderboard ("The Distances Board")** ✓
Built in v3.0.0. `/global` page with monthly top 10 (fairway-only drives) and course records tabs. Hall of Fame card on ended-tournament leaderboard. Super admin publish toggle per event. `GET /api/global/leaderboard`, `/api/global/course-records`, `/api/global/venue-record` endpoints.

**#2 — Test page map auto-centers to selected tournament** ✓
Built in v2.0.0. Full fallback chain on event selection: polygon bounds → tee boxes → venue_lat/lon. No manual address entry needed.

**#MAP-LOCATE — All maps auto-locate and zoom to tournament hole on open** ✓
Fixed in session 13. Admin map calls `flyAdminToVenue()` on first load (was only re-opens). Leaderboard `initMap()` starts at tee/pin/venue coords. Monitor `centerMapOnCourse()` race condition fixed — `initMap()` now catches the case where SSE snapshot arrives before the map is created.

**#MONITOR-ZONES — Monitor page shows zone coloring** ✓
Fixed in session 13. Monitor had no `addZone` or `updateZoneLayers` functions. Added full zone rendering (fairway/rough/OOB/green) matching leaderboard pattern. Called from `updateStats()` on every SSE event.

**#10 — ESRI World Imagery + Hole Tour** ✓
All maps swapped from Mapbox satellite to ESRI World Imagery (`JORD.satelliteStyle()` in jord.js).
Leaderboard map: "🎬 Hole Tour" button — animated satellite flyover from tee → fairway → pin approach (zoom 19.5) → 360° orbit → overhead pullback. ~29s. Stop returns to overhead.

**#GPS — Admin GPS pin grab accuracy threshold** ✓
`GOOD_ENOUGH_M` lowered from 4m → 3m in admin.html. Pin grab now waits for tighter accuracy before early-stopping.

**#CTP-MANUAL — CTP rangefinder distance override** ✓
Scan page CTP form shows optional "Rangefinder distance (ft)" input. If filled, `manual_ft` is sent to server and overrides GPS calculation. Off-green penalty check still uses GPS coordinates.

**#8 — Keyboard stays in mode on code entry** ✓
Replaced 6 separate `<input>` elements with 6 visual `<div>` boxes + one hidden `<input>`. Keyboard never resets between characters because focus never moves. `autocapitalize="characters"` auto-uppercases letter entry. Blinking cursor indicator on active box position.

**#5 — Dot colors after tournament ends** ✓ (resolved by design decision)
Keeping dots in team colors after tournament ends. No zone-color switch.

**#3 — Auto-detect ball zone from GPS + lock it** ✓
Fixed `pointInPolygon` to handle FeatureCollections (was silently failing — `geom.coordinates[0]` undefined on FeatureCollection). Added `checkRing` helper. After detection: fairway/rough locks all buttons; OOB/outside locks fairway+rough but keeps Lost Ball enabled. Locked note shown with "contact a rep to change zone."

**#4 — Monitor map: team colors + standings highlight** ✓
12-color palette assigned per team on first appearance, cached for session. Map dots now use team color (grey if not yet scanned). 📍 button on each team row in Current Standings focuses map to that team's dots (others dimmed to 18% opacity). "× All Teams" button in map header clears filter.

**#1 — Draw multiple zones on course setup map** ✓ (already working — code verified)
`byKind` arrays + `toFC` FeatureCollection + `loadPolygon` FeatureCollection iteration all support multiple polygons per zone type. No drawing restriction exists.

**#6 — Course setup map: fix polygon colors, reduce nodes, snap lines** ✓
- ✅ Colors fixed — zone layer priority order + inactive opacity restored
- ✅ Node count fixed — turf.simplify reduces freehand paths to ~10–30 vertices
- ✅ Clipping fixed — scheduleClipZones now runs after freehand draw completes
- ✅ Snap/block — real-time constraint is complex; leaving as-is (clips correctly on mouse release)

**#7 — Full iPhone test flow via ngrok** ✓
ngrok installed, auth token configured, tunnel running. Test page QR codes now auto-use current
origin so they work on both localhost and ngrok. Monitor QR uses first active event ID.
GPS note added: Safari requires HTTPS — use ngrok URL, not local IP.
