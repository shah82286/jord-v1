# JORD Golf — To Do List

Numbers stable — reference by number (e.g. "let's do #3").
Nothing built until confirmed. Move to In Progress / Done as we go.

---

## Backlog

**#9 — Global Leaderboard ("The Distances Board")**
A public, always-on page aggregating results across ALL tournaments. Golden Tee-inspired —
big, bold, something players pull up after the round and talk about. Lives at `/global`.

Three sections:
- **🔴 Live Right Now** — active tournaments with pulsing LIVE badge, current leader + distance,
  link to that event's full leaderboard. Good for tablet display at the tent.
- **📅 This Month's Leaders** — best LD and CTP across all finished tournaments this calendar
  month. Resets on the 1st. Player name, tournament name, venue, distance. The competitive hook —
  players check after their round to see if they made the monthly board.
- **🏆 All-Time Hall of Fame** — single greatest drive and closest pin ever on the platform.
  The number to beat. When broken, that's a moment.

Key decisions to make before building:
- **Qualifying scores**: fairway-only for LD records, or all final (post-penalty) yards?
- **Opt-in/out**: toggle per tournament in admin settings — some corporate events may want privacy
- **Player identity**: name-as-entered for now (no accounts). Future: shareable personal score
  card at `/score/ABC123` showing that player's result in a social-share format
- **Record broken moment**: flash animation on global page when a live tournament beats all-time

Entry point: "🌍 Global Leaders" button always visible on per-event leaderboard, becomes more
prominent after tournament ends with "See how this stacks up against the all-time leaders."

Technical notes:
- New API: `GET /api/global` — live events, monthly tops, all-time records, recent events
- Monthly: query balls WHERE created_at >= first of current month AND event status = ended
- All-time: MAX on ld_final_yards / cp_distance_ft across all opted-in events
- No auth required — fully public. Poll every 30s (SSE not needed)
- Monthly records worth persisting in a separate table so historical months are browsable

**#2 — Test page map auto-centers to selected tournament**
When a tournament is selected in the test tool, map should fly to that course location automatically.
No manual address/name entry needed.



---

## In Progress

*(nothing yet)*

---

## Done

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
