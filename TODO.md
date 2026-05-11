# JORD Golf — To Do List

Numbers stable — reference by number (e.g. "let's do #3").
Nothing built until confirmed. Move to In Progress / Done as we go.

---

## Backlog

**#SECURITY-1 — Set up quarterly API key rotation reminders**
Email reminders to shah82286@gmail.com on Jan 1, Apr 1, Jul 1, Oct 1 at 9am to rotate Mapbox, Anthropic, and Klaviyo API keys. Use Google Calendar or phone calendar with email notifications. See SECURITY_FIXES_APPLIED.md for details. ~60 seconds setup.

**#PRE-1 — Get on HTTPS hosting** ✓
Deployed to Railway. Live at https://tournament.jordgolf.com. SSL auto-managed by Railway. Persistent volume at /app/data for SQLite. APP_URL updated. Completed May 2026.

**#PRE-2 — Wire up or formally defer SMS/email (Klaviyo)** ✓
Completed May 2026. Full Klaviyo integration live. 4 event metrics fire from the server: `jord_registered`, `jord_ball_scanned`, `jord_tournament_ended`, `jord_dethroned`. 4 Klaviyo Flows built and set to Live — each delivers a branded dark-theme HTML email + SMS. Players opted in at registration receive messages automatically. Real Klaviyo API key set in Railway environment variables.

**#PHASE-2 — Tournament admin experience: limited UI + per-event branding**
Restrict tournament-admin panel UI (hide super-only buttons, scope event list). Add per-event branding: logo upload + accent color picker on Settings tab. Apply branding on register/leaderboard/scan pages with "Powered by JORD Golf" footer. Sales-value feature — every tournament looks branded.

**#PHASE-3 — AI Help Agent**
Claude-powered floating chat widget on admin panel. Aware of current event context (status, ball count, recent alerts). Escalation alerts to super admin dashboard when admin gets stuck. Note: usage-priced — watch costs.

**#PHASE-5 — Klaviyo welcome email for new admins**
When super admin creates a new admin account, send a welcome email with temp password (currently displayed in console). Also wire forgot-password reset link to email instead of manual copy.

**#TEST-COLOR — Fix swapped fairway/green colors on test page**
`/test` GPS simulator has fairway shown as green (`#22C55E`) and green shown as blue (`#3B82F6`) — opposite of the standard. `test.html:235-245`. Minor visual fix to match main maps.

---

## In Progress

*(nothing yet)*

---

## Done

**#THEME-V3.8 — Platform-wide cream editorial re-skin** ✓
Completed 2026-05-11 (v3.8.0). Swapped `public/css/jord.css` `:root` variables from Rumble dark-green to the Vessel/Malbon cream editorial palette. Re-skinned all 11 functional pages (admin, leaderboard, scan, register, monitor, dashboard, global, qr, test, system-summary, mapdiag) plus polished marketing pages already on cream. `JORD.renderTopbar` now references local `/img/logos/*` — no external CDN dependencies anywhere. 55/55 regression tests pass, 14/14 mobile visual tests pass with 0 layout issues. See CHANGELOG v3.8.0 for full per-file breakdown.

**#HANDOFF-UPDATE — Refresh HANDOFF.md to v3.8.0** ✓
Completed 2026-05-11. HANDOFF.md now reflects current state: v3.8.0 cream editorial theme as the source of truth, palette documented, legacy v1.5.0 lime palette retired.

**#PRE-3 — Upgrade monitor page to session auth** ✓
Completed 2026-05-10. Monitor `/monitor/:eventId` login replaced with email+password form (was: shared admin password). POSTs to `/api/auth/login` for a real session token. All monitor API calls (`/api/events/:id`, `/api/admin/correct`, `/api/alerts/:id/resolve`, ball reset) now use the session token. Audit trail upgrade: `admin_corrections.corrected_by` column now records `Name <email>` of the logged-in admin instead of generic `'admin'` — full per-rep attribution. Old localStorage password tokens are rejected by `requireAuth`, so the shared-password system is fully retired.

**#TEAM-QR-URL — Team QR code reads `?team=` URL parameter** ✓
Fixed 2026-05-10. `register.html` now reads team code from URL via `JORD.qs('team')` so Players 2-4 scanning the team QR see "✅ Joining team code: XXXXXX" confirmation. Was silently ignored before.

**#LB-ROUGH-ORDER — Rough zone not showing on leaderboard/monitor maps** ✓
Fixed 2026-05-10. Layer order in `updateZoneLayers()` was Fairway → Rough → OOB → Green, meaning OOB at 25% opacity was rendered ON TOP of Rough and obscuring it. Reordered to OOB → Rough → Fairway → Green (matches admin map and HANDOFF's "Fairway > Rough > OOB priority"). Fixed in both `leaderboard.html` and `monitor.html`.

**#EVENT-CREATOR — Show creator admin on event cards + header** ✓
Added 2026-05-10. `/api/events` and `/api/events/:id` now JOIN admins table, returning `creator_name`, `creator_email`, `creator_role`. Admin panel events list shows "👤 [name]" badge on each card; event editor header shows "👤 Created by [Name]". Super admin can see who owns each event at a glance.



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
