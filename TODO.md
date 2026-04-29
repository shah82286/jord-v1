# JORD Golf — To Do List

Numbers stable — reference by number (e.g. "let's do #3").
Nothing built until confirmed. Move to In Progress / Done as we go.

---

## Backlog

**#1 — Draw multiple zones on course setup map**
Currently only one polygon per zone type. Need to support drawing multiple fairways,
multiple rough areas, and multiple OOB zones on the same hole.

**#2 — Test page map auto-centers to selected tournament**
When a tournament is selected in the test tool, map should fly to that course location automatically.
No manual address/name entry needed.

**#3 — Auto-detect ball location from map dot + lock it**
Wherever the player drops their dot on the scan map, the system should auto-detect which zone
they're in (fairway / rough / OOB / green) and pre-select + lock the "Where did your ball land?"
field. Also: show a Call Admin button at that point, and show the ball's location on the map.

**#4 — Monitor map: team colors + standings highlight**
All balls for the same team show the same color dot on the monitor map.
Clicking a team row in Current Standings highlights only that team's dots on the map.
"All Players" view shows all teams, each with their own distinct color.
Each team keeps its color for the whole tournament.

**#5 — Tournament end: switch dot colors to location types**
When tournament ends, map dots switch from team colors to zone colors:
Fairway = green, Rough = yellow, OOB = red, Lost = red, Green = blue.

**#6 — Course setup map: fix polygon colors, reduce nodes, snap lines**
- Colors in zone polygons still not showing correctly in their areas
- Too many nodes appearing on drawn polygons
- Lines from different polygons don't snap to each other — they overlap instead of sharing edges

---

## In Progress

*(nothing yet)*

---

## Done

**#7 — Full iPhone test flow via ngrok** ✓
ngrok installed, auth token configured, tunnel running. Test page QR codes now auto-use current
origin so they work on both localhost and ngrok. Monitor QR uses first active event ID.
GPS note added: Safari requires HTTPS — use ngrok URL, not local IP.
