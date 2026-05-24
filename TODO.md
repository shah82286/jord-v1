# JORD Golf — To Do List

Numbers stable — reference by number (e.g. "let's do #3").
Nothing built until confirmed. Move to In Progress / Done as we go.

---

## Backlog

**#STRIPE-1 — Wire real Stripe payment for event registrations** ✓ DONE
v3.32.0 (May 2026). Stripe Connect Express + destination charges + 3%
application fee deployed to Railway. JORD platform account onboarded
through `/admin/stripe-connect`. End-to-end test passed: registration
on `/e/:slug/register` → Stripe Checkout → webhook fires
`checkout.session.completed` → confirmation page shows paid. Sandbox/
test keys (`sk_test_…`). When ready for real money: open `#STRIPE-LIVE`
to swap sandbox keys for live keys and re-onboard Connect in live mode.

**#STRIPE-LIVE — Switch from sandbox to live keys**
When JORD is ready to take real money: (1) flip Stripe Dashboard to
live mode, (2) re-do Connect platform setup in live mode (the platform
is its own product per-mode), (3) generate `sk_live_…` + `pk_live_…`
keys, (4) update Railway env vars, (5) add a NEW webhook endpoint in
live mode and update `STRIPE_WEBHOOK_SECRET` (sandbox + live webhooks
are separate), (6) JORD organizer needs to redo `/admin/stripe-connect`
onboarding in live mode, (7) end-to-end test with a real card for a
small amount, then refund yourself.

**#OAUTH-1 — Create OAuth apps for Google + Microsoft sign-in (Apple later)**
Create OAuth client apps in Google Cloud Console (free) and Azure AD (free), then paste me the Client IDs. Backend endpoint (`POST /api/users/oauth`) and the "Continue with Google / Microsoft" buttons on `/login` slot in once the IDs are set. Sign in with Apple is deferred until the Apple Developer Program ($99/yr) is set up. ~10 minutes per provider — I'll walk through it when you're ready.

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

**#KLAVIYO-FLOWS — Build the 5 remaining Klaviyo Flows**
All transactional email now routes through Klaviyo (SMTP was dropped — Railway blocks outbound SMTP). The server fires these metrics but they have NO Flow yet, so nothing is delivered. Build a Live Flow for each (steps in KLAVIYO-SETUP.md Part 1):
- `jord_password_reset` — **do first**, nobody can reset a password without it. Email-only.
- `jord_account_welcome` — new rep login + temp password. Email-only.
- `jord_admin_welcome` — new admin login + temp password. Email-only.
- `jord_admin_assigned` — existing admin added to an event. Email-only.
- `jord_tournament_signup` — `/signup` form auto-reply. Email-only.
All five are email-only (no SMS block). Email subject `{{ event.EmailSubject }}`, one HTML block `{{ event.EmailBodyHtml|safe }}`, Transactional ON, Smart Sending OFF. The 5 flows already Live (`registered`, `ball_scanned`, `tournament_ended`, `dethroned`, `team_created`) need nothing — the cream re-skin is automatic since the server builds the HTML.

**#KLAVIYO-TRANSACTIONAL — Resolve transactional approval with Klaviyo**
Klaviyo **rejected** the transactional status on a JORD email — Shaheen is confirming with Klaviyo support. This is a hard blocker: transactional status is what lets password-reset / welcome / registration emails reach people who never opted into marketing. Until Klaviyo approves transactional sending on the account, those emails are held. Action: get transactional approved (work with Klaviyo on whatever they flagged — wording, sender setup, etc.), then confirm all 10 flows show Transactional **Approved**, not "Under Review" or "Rejected".

**#EMAIL-DEPLOY — Deploy the all-Klaviyo email build to Railway**
Commits `733ecae` (route transactional email through Klaviyo) + `00cc475` (doc) + `3339d0e` (IPv4 DNS fix) are pushed to GitHub but not yet deployed. Manually deploy `main` in Railway so the new email routing goes live. Then re-test password reset end-to-end once the `jord_password_reset` flow exists.

**#REG-SIM-TEST — Run the 20-player registration simulation**
`scripts/test-registration-flow.js` was built (spins up a sandboxed server on a temp DB, registers ~20 players across 5 teams, exercises duplicate-code / full-team / pre-tournament edge cases) but never run end-to-end. Run it, fix anything it surfaces, before the next real tournament.

**#HELP-BUBBLES — Info tooltips across tournament setup screens**
Add clickable `ℹ`/`!` info bubbles next to every setting, input, and toggle on the admin Settings + Course Map tabs so a non-technical tournament director can self-serve. The `.help-icon`/`.tooltip` CSS already exists in the editor — extend it comprehensively and make it tap-friendly on mobile (hover doesn't work on touch).

**#RAILWAY-AUTODEPLOY — Wire Railway auto-deploy from GitHub** ✓ DONE
Confirmed working May 2026 — pushes to `main` auto-trigger Railway
builds (verified during Stripe Connect deploy). No further action needed.

**#DOCS-REFRESH — Update CHANGELOG + HANDOFF**
Several shipped features aren't fully in the docs: v3.11.0 tournament rep role, the registration flow rewrite (team name first, dropdown, dup-code popup), pre-tournament registration, the platform-wide cream email re-skin + 4 new emails, and the rep view-permission levels (`perm_view_leaderboard` etc.). Refresh both files so the next session starts with accurate context.

---

## In Progress

**#DROP-INTEGRATION — JORD Tournament → The Drop data handoff**
*Started 2026-05-14. Paused waiting on Drop dev team answers.*

**Goal:** After a tournament ends, registered players' ball codes + contact info auto-transfer to The Drop (drop.jordgolf.com) so the same balls become Drop balls people can pay-it-forward leave on courses.

**Decisions locked in:**
- **Scope:** All registered players transfer (scanned or not). Unused codes stay in JORD pool.
- **Trigger:** Auto-fire 24h after `events.status='ended'`. Admin can "Send now" to skip grace, or "Skip transfer" to disable.
- **Data sent per player:** name, email, phone, ball_code, venue_name, venue_lat, venue_lon, event_name, event_date, registered_at, scanned_at, marketing opt-in flags.
- **Home course in Drop:** Free-text venue name; Drop's UI handles match-or-create.
- **Existing Drop users:** Match by email, add ball to existing account.
- **Editable fields after registration:** name, email, phone (already shipped — see "Already done" below).
- **Welcome email:** JORD sends from JORD Klaviyo. Transactional, fires regardless of marketing opt-in.
  - Two templates: "Played" (lists all their ball codes) and "Sorry you missed it — registered but didn't scan"
  - Single email per player listing all codes (not one per code).
- **Sync visibility:** Per-event status panel in admin (pending / sent / failed / disabled), with retry buttons.

**Already done (pre-existing):**
- Edit registered player (name/email/phone) in admin Players tab → already built, shipped commit `dbe1d2e`. `PATCH /api/events/:eventId/balls/:code/player` at [server.js:1352](server.js#L1352); inline edit form at [admin.html:2984-3014](public/admin.html#L2984-L3014).

**Phase A — to build (no Drop API needed):**
1. Data model: `events.drop_transfer_status` (pending/sent/failed/disabled), `events.drop_transfer_at`, per-ball `drop_transferred_at`, new `drop_transfer_log` table for retry history.
2. Export endpoint `GET /api/admin/drop-export/:eventId` returning JSON array of `{ ball_code, first_name, last_name, email, phone, venue_name, venue_lat, venue_lon, event_name, event_date, registered_at, scanned_at, email_opt_in, sms_opt_in }`.
3. Manual CSV export button (lets Shaheen do CSV import to Drop today, before API).
4. 24h delayed scheduler (hourly job: find `status='ended' AND ended_at < NOW()-24h AND drop_transferred=0`).
5. Per-event sync status panel in admin (status + retry/skip/send-now buttons).
6. Two welcome email templates in JORD Klaviyo ("Played" + "Sorry you missed it") fired on transfer success.

**Phase B — after Drop team conversation:**
- Wire actual push to Drop (REST API call / shared DB / keep CSV-only).

**Open questions for Drop dev team:**
1. Does Drop have a REST API? Endpoint URL + auth scheme (API key / JWT / bearer)?
2. Drop's data model: how to add a ball to an existing user-by-email? Required ball record fields?
3. Home course: free-text string accepted, or do we need to match against Drop's course ID database?
4. Webhook back to JORD when a ball gets found/dropped? (Not required, but would let JORD show "this ball is in the wild" status.)

**Also pending from Shaheen:** Drop 6-digit code so I can walk through register-a-ball flow on drop.jordgolf.com to understand their UX before final design.

---

## Done

**#REP-ROLE — Tournament Rep role with per-event assignment + permission toggles** ✓
Completed 2026-05-12 (v3.11.0). New `role='rep'` joins super/admin. Reps are read-only by default and explicitly assigned to events via a new `event_reps` join table. Four opt-in permission toggles: `perm_corrections`, `perm_resolve_alerts`, `perm_reset_scans`, `perm_register_walkups`. Reps can never edit the course map, end tournaments, manage other accounts, or touch the ball pool. New page `/admin/reps` for rep CRUD (admins see their own, super sees all). New "🎽 Reps" tab on each event editor for per-event assignment. Monitor UI hides controls reps can't use. Same login form — server routes by role. 12 new regression tests, 87/87 passing.

**#THEME-V3.8 — Platform-wide cream editorial re-skin** ✓
Completed 2026-05-11 (v3.8.0). Swapped `public/css/jord.css` `:root` variables from Rumble dark-green to the Vessel/Malbon cream editorial palette. Re-skinned all 11 functional pages (admin, leaderboard, scan, register, monitor, dashboard, global, qr, test, system-summary, mapdiag) plus polished marketing pages already on cream. `JORD.renderTopbar` now references local `/img/logos/*` — no external CDN dependencies anywhere. 55/55 regression tests pass, 14/14 mobile visual tests pass with 0 layout issues. See CHANGELOG v3.8.0 for full per-file breakdown.

**#HANDOFF-UPDATE — Refresh HANDOFF.md to v3.8.0** ✓
Completed 2026-05-11. HANDOFF.md now reflects current state: v3.8.0 cream editorial theme as the source of truth, palette documented, legacy v1.5.0 lime palette retired.

**#TEAM-LATE-JOIN — Late arrivals can join a team via QR/share code** ✓
Completed 2026-05-10. Added `share_code` column on `teams` table. `finalize-team` saves the 6-char team code, ensuring uniqueness per event. New endpoints: `GET /api/events/:eid/teams/by-share-code/:code` (lookup) and `POST .../add-player` (join). `register.html` now detects when a `?team=XXXXXX` URL matches an already-finalized team and switches into "Add yourself to [Team Name]" mode (shows existing members, single-player form, posts to add-player). Server validates team isn't full (4 max), event is active, drop code is unused. New `/team/:eid/:share` page (`team.html`) shows team name, member list with empty-seat placeholders, QR code + copy-link button to invite more, and a leaderboard link. Linked from the registration success screen.

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
