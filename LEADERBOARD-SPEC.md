# JORD Live Leaderboard & Tournament Scoring — Feature Spec

**Status:** Draft for sign-off · **Date:** 2026-05-16 · **Author:** planning session

---

## 1. Vision

Extend JORD from a single-hole skills-contest tool (Longest Drive / Closest to Pin)
into a full tournament scoring platform — Golf Genius / Gamebook class — that also
works for casual rounds with friends.

Three use cases, one engine:

1. **Charity / corporate tournaments** — admin-run, registered field, flights,
   published live leaderboard.
2. **Stroke-play tournaments** — competitive, multi-day, WHS net scoring.
3. **Casual buddy rounds** — any player spins up a round via a link, no admin.

The existing LD/CTP system is **not replaced** — it gets reframed as on-course
*side contests* that can be attached to a hole inside any tournament.

---

## 2. Design principles

- **API-first.** Every screen talks to clean JSON endpoints. Web pages are one
  client; a future native iOS/Android app calls the same endpoints. No rework.
- **A round is the core unit.** A tournament is a wrapper around one or more
  rounds. A casual round is a round with the formalities stripped off.
- **Offline-capable score entry.** Golf courses have dead spots — score entry
  caches locally and syncs when signal returns.
- **Provider-agnostic course data.** Course data is fetched behind one function;
  swapping golfcourseapi.com → iGolf later changes nothing else.
- **Coexists with the map system.** The scorecard is pure data — no Mapbox,
  no polygons. The existing LD/CTP map code is untouched.

---

## 3. Course data strategy

| Phase | Source | Cost |
|---|---|---|
| Now | [golfcourseapi.com](https://golfcourseapi.com/) | Free (300 req/day) → $6.99/mo (10k/day) |
| Slope/rating fallback | [USGA NCRDB](https://ncrdb.usga.org/) — manual lookup | Free |
| Later | iGolf Connect | ~$5K/yr |

**Cache-as-you-go.** Every course fetched is written into local `courses` /
`course_holes` tables. Repeat venues never re-hit the API; the local copy is also
the offline source. Migrating to iGolf later swaps only the import function.

**Manual entry** is always available — admin types an 18-hole scorecard (par +
stroke index + per-tee yardage) once; it becomes a reusable course.

---

## 4. Data model (proposed)

New tables — existing `events`, `teams`, `balls`, `tee_boxes` are untouched.

```
players                -- reusable identity, keyed by phone/email
  id, name, phone, email, handicap_index, account_id (nullable, future app)

courses                -- reusable course record
  id, name, city, state, country, source, external_id, num_holes, lat, lon

course_tees            -- WHS needs rating + slope per tee
  id, course_id, name, gender, par_total, yardage_total,
  course_rating, slope_rating

course_holes           -- par + stroke index are course-level
  id, course_id, hole_number, par, stroke_index

course_hole_yardages   -- yardage is per-tee
  tee_id, hole_number, yards

tournaments            -- the wrapper
  id, type ('tournament' | 'casual'), name, admin_id, event_id (nullable),
  num_rounds, default_format, flights_enabled, num_flights, flight_method,
  banter_enabled, status

rounds                 -- a round of golf at a course
  id, tournament_id, round_number, course_id, date, format, status

round_entries          -- a player in a round
  id, round_id, player_id, tee_id, group_id, flight_id, team_id (nullable)

groups                 -- pairings within a round
  id, round_id, name, tee_time, starting_hole

tournament_teams       -- for scramble / best-ball
  id, tournament_id, name

flights
  id, tournament_id, name, min_hcp, max_hcp

scores                 -- the atomic unit: one row per player per hole
  id, round_entry_id, hole_number, strokes, entered_by, entered_at

chat_messages
  id, tournament_id, player_id, body, image_path, created_at, deleted

chat_bans
  tournament_id, player_id, banned_by, created_at
```

---

## 5. Scoring formats

All formats read the same raw `scores` table; the scoring engine computes each
view. Each format is one pure function: `(holeScores, handicap, config) → standings`.

- **Stroke play** — gross & net
- **Stableford** — standard & modified (points per hole)
- **Scramble** — 2 & 4-person (one team score per hole)
- **Shamble** — best drive, then own ball in
- **Best ball / Four-ball** — 1 or 2 best balls count
- **Match play** — individual & team, hole-by-hole, auto win/loss/halve
- **Skins** — gross & net, with carryover (a tied hole carries its skin forward)
- **Nassau** — front 9 / back 9 / overall
- **Team match play** — "Reds vs Blues" / Ryder Cup style
- **Side contests** — LD & CTP (existing GPS engine) attached to specific holes

---

## 6. WHS handicaps

- Each player has a **handicap index** (entered at registration / round setup).
- **Course handicap** = computed from index + tee slope + tee rating + par,
  per WHS formula.
- **Playing handicap** = course handicap × format allowance (e.g. 95% stroke play).
- **Stroke index** per hole determines where handicap strokes fall for net scoring.
- Slope/rating come from the course API; admin can override / hand-enter.

---

## 7. Flights

- Per-tournament setting: **flights on/off**, **1–5 flights**.
- Standard flight rules: field split by handicap, lowest in Flight 1, etc.
- Results **displayed split by flight** — a winner per flight.
- Flighting is configured before play; results screen groups by flight.

---

## 8. Score entry UX

Two modes (matching Golf Genius):

- **Group scoring** — one phone per group enters all players, hole by hole.
- **Shared link** — the group link lets multiple players each enter on their
  own phone; entries sync. Anyone in the group can mark.

Entry supports hole-by-hole (default), 9-hole, and 18-hole totals. Offline-safe:
scores cache on-device and sync on reconnect. Optional attestation by a 2nd player.

---

## 9. Live leaderboard

- SSE-driven (reuses existing real-time plumbing).
- Columns: position, player/team, thru, today, total, gross/net toggle.
- Flighted view when flights are enabled.
- Multi-round: cumulative across rounds; per-round and total views.
- Tie-break rules per USGA (matching scorecards / back-9 / back-6 / back-3).
- TV / big-screen display mode (reuses `.theme-dark`).
- End-of-tournament results screen, split by flight, with winners.

---

## 10. Casual rounds

- Any player creates a round via link — pick course, format, add player names.
- No admin, no registration. Players identified by name; remembered by phone
  so a future app account can claim past rounds.
- Same scoring engine, same leaderboard, same Banter Room.

---

## 11. Banter Room

- **One chat room per tournament and per casual round.**
- "💬 Banter Room" button on leaderboard / monitor / scan pages.
- **Posting:** players + admins/reps. Public viewers are read-only.
- **Moderation:** profanity filter, admin delete-message / clear-room, and
  **ban a player** from the room (`chat_bans`).
- **On/off:** per-tournament setting, default on.
- **Images:** photo upload in chat (tournaments + casual rounds). Stored as
  files on persistent storage, not base64 in the DB.
- **Social share:** generate a JORD-branded share card, then hand off via the
  native share sheet (Web Share API) — user picks the destination app.
  Desktop fallback: download + copy link.
- Live via SSE. Unread badge on the button — no SMS/email pings.

---

## 12. Multi-day tournaments

- A tournament holds 1+ rounds, each on a date / course.
- Cumulative scoring across rounds; per-round and total leaderboard views.
- Pairings can regenerate per round (e.g. re-pair by standing).

---

## 13. Phased build plan

**Phase 1 — Core live leaderboard (complete, shippable)**
- `courses` / `course_holes` tables; manual scorecard entry + golfcourseapi import
- Single 18-hole round; gross + net stroke play
- WHS course handicap
- Group + shared-link score entry, offline-capable
- Live SSE leaderboard with gross/net toggle, TV mode

**Phase 2 — Banter Room** *(moved up — priority feature)*
- Chat (SSE), images, profanity filter, admin moderation + bans
- Branded share card + native share sheet
- On/off setting

**Phase 3 — Tournament operations**
- Multi-round / multi-day, cumulative scoring
- Flights (1–5, results split)
- Scramble, best-ball, Stableford
- Pairings / groups / tee sheet
- Casual buddy-round mode

**Phase 4 — Exotic formats + integration**
- Match play, skins (with carryover optimization), Nassau, shamble,
  team match play
- LD/CTP side contests attached to tournament holes

---

## 15. Round setup & format system (from Gamebook study)

Design derived from 30 Gamebook screenshots + WHS research. This supersedes the
thinner format list in §5 and reshapes Phase 3.

### Three entry points
A "Choose Game Type" screen, mapping to `tournaments.type`:
- **Normal Game** (`casual`) — quick single round with friends.
- **Tournament** (`tournament`) — single/multi-round, up to 72 players, 6 rounds.
- **Reds vs Blues** (`reds_blues`) — two-team Ryder Cup match play.

### Setup wizard (linear)
`Course → Holes (Full 18 / Front 9 / Back 9) → Game Setup → Players → Start`
- **Game Setup:** name, date, **Primary format**, optional **Side game**,
  **Contests** (LD/CTP — the existing JORD engine), **Round type**.
- **Players:** each player has Handicap Index, Tee box, Starting hole; the
  computed **Playing Handicap** is shown.

### Format catalog (19 formats, 3 tiers)

**Individual**
- Stroke Play — gross / net
- Stableford — regular + modified (Reg: eagle 4/birdie 3/par 2/bogey 1/DB+ 0;
  Mod / Mod2 / Mod3 variants)
- Erado — stroke play; drop the worst N holes (typically 4 of 18; not the last)
- Skins — per-hole value to the outright winner; ties carry over (optional)
- Duplicate — individual Stableford with a random 1×/2×/3× per-hole multiplier;
  last hole always 2×
- Match Play — individual

**Pair (2 players)**
- Better Ball — Stroke Play / Stableford
- 2-Man Scramble — Stroke Play
- Match Play — Better Ball / Foursome / Greensome / Scramble

**Team (3–5 players)**
- Best Ball — Stroke Play / Stableford (best 1–5 scores per hole by group size)
- Scramble — Stroke Play
- Low Scratch/Net — Stroke Play (best gross + best net combined)
- Duplicate Scramble — Stableford
- Irish Rumble — Best Ball / Stableford; escalating best-N (holes 1–6 best 1,
  7–12 best 2, 13–17 best 3, 18 all)

### Handicap allowances (WHS)
Stored per format as a default, overridable in format settings:
- Singles stroke/Stableford 95% · Four-ball 85% (stroke) / 90% (match)
- Foursomes 50% combined · Greensome 60% low + 40% high
- 2-person scramble 35/15 · 4-person scramble 25/20/15/10

Per-format settings screen: primary tie-break method, Use handicaps, Use course
handicaps, Apply HCP %.

### Revised Phase 3 build order
- **3A** — Rebuild `/tournaments` as the 3-entry wizard + format-catalog picker
  (Individual/Pair/Team tiers, format detail + settings). Scoring live for
  stroke (gross/net) + Stableford + scramble.
- **3B** — Remaining team/pair scoring: Best Ball, Better Ball, Foursome,
  Greensome, Low Scratch/Net.
- **3C** — Match play, Skins (carryover), and exotics (Erado, Duplicate,
  Irish Rumble); side games + LD/CTP contests wired in.
- **3D** — Multi-round tournaments, flights, Reds vs Blues.
- Banter Room (was Phase 2) slots in after 3A.

## 14. Open items / risks

- **golfcourseapi.com field coverage** — verify it returns slope + course
  rating; if not, those are manual-entry per tee (USGA NCRDB reference link).
- **Persistent image storage** — Railway filesystem is ephemeral; chat uploads
  need a mounted volume or object storage (R2/S3). Decide before Phase 3.
- **Offline sync conflict handling** — define behavior when two phones in a
  group edit the same hole offline.
- **Casual-mode bans** — link-based players can rejoin under a new name; ban is
  best-effort for unregistered players.
- **iGolf migration** — budget-dependent; data layer is built to swap cleanly.
