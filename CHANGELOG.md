# JORD Golf Tournament System — Version History

---

## v3.62.1 — 2026-05-31
### Session 78 (cont.) — Vegas birdie-flip bug + entry fallback par

Comprehensive Vegas E2E (8-step) surfaced a real bug — the birdie-flip
rule wasn't firing in production rounds even though the unit test
confirmed the engine math. The cause was upstream in the entries
plumbing, not in the engine.

**Root cause:** when a player was added to a round without a `tee_id`
(the `/teams` endpoint accepts teams without explicit tees), the
server's `gatherRoundEntries` returned `holes: []`. Every engine that
looks up par-per-hole then saw `par === 0`, which broke:
- Vegas birdie-flip (`n <= par - 1` is `n <= -1`, never true)
- Stableford points (everything counted as worse than double-bogey)
- Skins net-low math (mostly worked because gross == net)
- Any future engine that reads par

**Fix:** `gatherRoundEntries` now resolves a fallback hole layout from
the round's course (`SELECT * FROM course_tees WHERE course_id=? LIMIT 1`)
and uses it for any entry that has no `tee_id`. Engine math now sees
the right par for every hole even on lightly-configured rounds.

### Vegas E2E coverage
New [tests/manual/test-vegas-full.js](tests/manual/test-vegas-full.js)
walks 8 verifications end-to-end:
1. Signup as personal user
2. Create Vegas tournament + custom settings
3. Confirm `format_settings` round-trips through POST/GET
4. Add 2 pairs of 2 via `/api/rounds/:id/teams` (the wizard's path)
5. Activate round + post 12 scores (3 holes × 4 players)
6. Pull SSE → verify Vegas leaderboard with Birdie +8 / Eagle -8
7. Build parallel `flip_birdie:false` and `flip_birdie:true` rounds —
   confirm flip changes the margin from +20 → +29 with a birdie on hole 1
8. Build a 4-pair (8-player) Vegas tournament — confirm the round-robin
   engine produces all 6 pair-vs-pair matchups (P1/P2/P3 = +1, P4 = -3)

### Files
- [server.js](server.js) — `gatherRoundEntries()` fallback to the course's first tee for entries without a `tee_id`
- [tests/manual/test-vegas-full.js](tests/manual/test-vegas-full.js) — new comprehensive Vegas E2E

### Tests
- 411/411 unit + integration passing
- Manual: Vegas E2E now 8/8 (was 6/8 before the fix); zero MANUAL formats in the verification report

---

## v3.62.0 — 2026-05-31
### Session 78 (cont.) — Last 3 MANUAL formats auto-tally (BBB / Dots / Snake)

User asked to clear every remaining MANUAL badge. The last three —
Bingo Bango Bongo, Dots / Garbage, Snake — fundamentally need a per-
hole event input (the strokes alone don't tell us "who got the
greenie" or "who 3-putted"). Built the foundation + capture UI +
engines in one pass.

### Data + API
New `hole_events` table — one row per occurrence:
```
hole_events (id, round_id, entry_id, hole_number, event_key, created_at)
```
Three endpoints:
- `GET    /api/rounds/:roundId/hole-events`
- `POST   /api/rounds/:roundId/hole-events`
- `DELETE /api/rounds/:roundId/hole-events/:id`

The tournament-delete cascade now also wipes hole_events for the
round.

### Engines
Three new builders in `lib/scoring.js`:
- `buildBBB`   — counts bingo/bango/bongo events per player × point
  values from `pts_bingo` / `pts_bango` / `pts_bongo`
- `buildDots`  — sums event point values per player from the configured
  `events` list (greenie / sandy / fish / birdie / eagle etc.)
- `buildSnake` — finds the most-recent 3-putter (the snake holder) and
  applies the `snake_penalty` as a negative total

`roundScoringOpts()` now fetches hole_events for every round so any
side-bet on these engines also gets fed.

### Scorecard UI
A new "side events" panel renders below the score-entry rows when the
round's primary format OR any side-bet uses an event-based engine:
- **BBB**: three rows of player pills — Bingo / Bango / Bongo. Picking
  a different player flips the winner for that hole.
- **Snake**: one row of player pills — toggle "3-putt" on or off.
- **Dots**: per-player row of event chips (Greenie / Sandy / Birdie /
  Eagle / Polly / Arnie / Fish). Tap to add, tap again to remove the
  most-recent one. Counter (`×2`) shows on repeats.

Each tap POSTs to `/api/rounds/:id/hole-events` and the live SSE
re-broadcasts the leaderboard. No round-tripping the whole scorecard.

### Catalog
- `bingo_bango_bongo`: scored:true
- `dots`: scored:true
- `snake`: scored:true

The MANUAL badge is gone for every format in the catalog. 28 / 28
auto-scored.

### Files
- [server.js](server.js) — new `hole_events` table + 3 endpoints, `roundScoringOpts` fetches events, delete cascade wipes events
- [lib/scoring.js](lib/scoring.js) — `buildBBB`, `buildDots`, `buildSnake`, dispatcher hookup, side-bet engine receives events too
- [lib/formats.js](lib/formats.js) — BBB / Dots / Snake `scored: true`
- [public/scorecard.html](public/scorecard.html) — `renderEvents()`, `addHoleEvent()` / `removeHoleEvent()`, `setSingleWinner()`, init fetches events + active-engine list from the tournament
- [tests/sim/simulator.js](tests/sim/simulator.js) — `fabricateEventsFor()` generates deterministic sample events so the verification harness shows realistic BBB / Dots / Snake leaderboards
- [tests/sim/format-verification-report.txt](tests/sim/format-verification-report.txt) — refreshed; zero MANUAL formats
- [tests/manual/test-event-engines.js](tests/manual/test-event-engines.js) — E2E: signup → BBB round → 9 hole events → SSE leaderboard math verified

### Tests
- 411/411 unit + integration passing
- Manual: BBB E2E passes (Alice=1, Bob=3, Cam=4, Drew=1 with the
  hand-computed scenario); Snake holder at -$20, others $0; Dots
  point totals computed from configured event values

---

## v3.61.0 — 2026-05-31
### Session 78 — Auto-tally for 4 of the 7 manual formats

User asked to clear the MANUAL badges and get every game auto-scoring.
Of the 7 formats that were stuck in manual-scoring mode, 4 are
score-derivable from the existing per-hole strokes and now have
auto-tally engines:

- **Alternate Shot (Foursomes Stroke)** — routed through the existing
  scramble engine. The wizard already creates a single team card per
  pair (1 ball per team), which is exactly the scramble pattern.
- **Chapman / Pinehurst** — same routing (1 ball per pair from the
  2nd shot onward). Uses the foursomes handicap allowance.
- **Nassau** — new `buildNassau()` engine. Treats the round as three
  separate matches (front 9 / back 9 / total 18) and reports each
  side's net winnings using the `front_bet` / `back_bet` / `total_bet`
  settings. Supports 2 individuals head-to-head OR two 2-player teams
  for a 2v2 better-ball Nassau.
- **Sixes / Round Robin** — new `buildSixes()` engine. Requires exactly
  4 players. Rotates partners every six holes
  ({A,B} vs {C,D}, then {A,C} vs {B,D}, then {A,D} vs {B,C}) and
  best-balls within each segment. Leaderboard ranks players by segments
  won, fewer losses as tie-break.

### Still MANUAL (next round, v3.62)
- **Snake** — needs per-hole 3-putt input
- **Bingo Bango Bongo** — needs per-hole "who got bingo / bango / bongo"
- **Dots / Garbage** — needs per-hole event marks (greenie / sandy / etc.)

These three fundamentally need new input on the scorecard (the strokes
alone don't tell us "who was first on green"), so they're getting their
own scorecard event-capture UI + engines in the next pass.

### Files
- [lib/formats.js](lib/formats.js) — Foursomes/Chapman → engine='scramble', Nassau + Sixes flipped to scored:true
- [lib/scoring.js](lib/scoring.js) — `buildNassau()`, `buildSixes()`, dispatcher updates
- [tests/sim/simulator.js](tests/sim/simulator.js) — Sixes uses 4 players, Nassau uses 2; describeScoring() drops "(manual)" tags
- [tests/sim/format-verification-report.txt](tests/sim/format-verification-report.txt) — refreshed (28 formats, 3 still MANUAL)

### Tests
- 411/411 unit + integration passing
- Manual: verification harness shows clean Sixes (Drew wins 3-0 since
  every pair with him wins) + Nassau (Brooke +$15 across 3 slices) output

---

## v3.60.0 — 2026-05-31
### Session 77 (cont.) — Dynamic multi-format combos (Stroke + Skins side bet)

User asked for game combinations:
> "For the selection of game if there are combinations or able to play
> multiple for instance doing stroke play or team stroke play and also
> skins. Right now I would have to create two separate things…
> Also the leaderboard and scoring should show on the card the
> multiple games."

User opted for the **schema-driven checkboxes** approach (max
flexibility) and **tab strip** on the leaderboard.

### Side-bet eligibility (conservative pass)
A side-bet is a second scoring game that runs on the same scorecard
as the primary format and produces its own leaderboard. New
`compatibleSideBets(primaryId)` helper in `lib/formats.js` returns
the side-bets allowed on top of a given primary.

For v3.60 the only side-bet is **Skins** — it composes with any
per-hole net-strokes engine (stroke, stableford, scramble, bestball,
duplicate, rumble, lownet). That covers a typical 16-player stroke-
play outing where the wager pot is a Skins side-bet.

More side-bets (Vegas as a sub-game on a stroke-play pair tournament,
Nassau on top of stroke, etc.) will land as their engines move from
manual scoring to auto-tally in future versions.

### Engine wrapper
New `scoring.buildAllLeaderboards(entries, opts)` runs the primary
engine, then each side-bet engine on the same entry set, and returns:
```
{ primary: <leaderboard>, sideBets: [{ formatId, leaderboard, settings }] }
```
The side-bet re-derives each player's playing handicap under its own
allowance (e.g. Skins 0.95) when a raw handicap index is available,
so net math matches a standalone side-bet game.

### Wizard UI
Below the primary's wagering panel, a new **"Side bets"** card lists
every compatible side-bet as a checkbox. Checking one opens that
side-bet's own settings (e.g. `$/skin` for Skins). The wizard sends a
`side_bets: [{ format_id, settings }]` array along with the regular
tournament POST.

### Live leaderboard tabs
When the round has side-bets configured, `/live/:roundId` now shows a
pill tab strip above the leaderboard with one tab per active scoring
engine ("Stroke Play • 🎯 Skins · Stroke Play"). Tabs switch the
visible leaderboard instantly — primary and side-bet both come from
the same SSE payload. The money-per-unit note ("$10.00 per skin")
auto-updates based on the active tab's settings.

### Files
- [lib/formats.js](lib/formats.js) — `compatibleSideBets()`, `SKINS_COMPATIBLE_PRIMARY_ENGINES`
- [lib/scoring.js](lib/scoring.js) — `buildAllLeaderboards()`
- [server.js](server.js) — new `tournaments.side_bets` JSON column, `sanitizeSideBets()`, POST/PATCH/GET all parse + sanitize, `roundLeaderboardPayload` returns `{leaderboard, sideBets, …}`
- [public/tournaments.html](public/tournaments.html) — `renderSideBetsPanel()`, `wireSideBetsPanel()`, `compatibleSideBets()` client helper, wizard sends `side_bets`
- [public/live.html](public/live.html) — `state.sideBets` + tab strip, `currentBoard()` / `currentSettings()` helpers
- [tests/run-tests.js](tests/run-tests.js) — `buildAllLeaderboards` unit tests (combo shape, Skins math on a 2-player 3-hole sample)
- [tests/manual/test-combo-format.js](tests/manual/test-combo-format.js) — full E2E: signup → create combo → post scores → confirm SSE serves both leaderboards

### Tests
- 411/411 unit + integration passing
- Manual: 6-step combo E2E passes (signup → side_bets persist → SSE payload has both leaderboards)

---

## v3.59.4 — 2026-05-31
### Session 77 — Delete games/rounds + paper-scorecard shapes

User feedback:
> "For games and rounds you need to be able to delete them. I noticed
> for games I created I can't delete. Also … the scorecard as scores
> are enter should show the proper shapes around the scores for
> instance birdie circle, square for bogey, etc."

### Delete games + rounds
The product never had a delete endpoint for tournaments — only the
underlying course / round-entry deletes existed. Added two new APIs:

- `DELETE /api/tournaments/:id` — cascades through rounds, entries,
  teams, score groups, hole scores, banter, and tournament requests
- `DELETE /api/rounds/:roundId` — single-round delete; refuses if
  it's the only round on the tournament (use the tournament delete
  instead)

Both use `requireUserOrAdmin` with the same `canEditTournament`
ownership check as the other write endpoints. **SQLite's
`PRAGMA foreign_keys` is off in this database**, so the
`ON DELETE CASCADE` in the schema was a no-op; the cascade is done
manually inside a single `db.transaction()` so a partial delete
can't leave orphans.

UI:
- Clubhouse home: each game tile shows an `×` delete button on hover
  (top-right corner). Click → confirm → delete → list refreshes.
- Tournament detail: new red `🗑 Delete` button in the header for the
  whole game; per-round `🗑` button in the rounds list (only on
  multi-round tournaments).

### Paper-scorecard shapes
The scorecard score now wraps the number in the traditional
paper-scorecard shape:
- **Eagle (≤ −2)**: double red circle
- **Birdie (−1)**: single red circle
- **Par (0)**: no shape (plain number)
- **Bogey (+1)**: single blue square
- **Double bogey or worse (+2)**: double blue square

CSS-only (no extra DOM), using `::before` / `::after` outlines on the
existing `.stepper .val` element. A new `scoreShape(strokes, par)`
helper picks the class. Left `live.html`'s color-coded hole-grid
alone because its existing legend reads well at glance distance for
the leaderboard view — the classic paper shapes belong on the
score-entry surface.

### Files
- [server.js](server.js) — `DELETE /api/tournaments/:id`, `DELETE /api/rounds/:roundId`, manual cascade transactions
- [public/tournaments.html](public/tournaments.html) — tile delete X, per-round delete, header "🗑 Delete" button
- [public/scorecard.html](public/scorecard.html) — `.s-eagle / s-birdie / s-bogey / s-double` styles + `scoreShape()` helper
- [tests/manual/test-delete-and-shapes.js](tests/manual/test-delete-and-shapes.js) — 13-step regression: owner delete, 403 for non-owner, all 5 shape classes
- [tests/manual/capture-v3594-screenshots.js](tests/manual/capture-v3594-screenshots.js) — visual review shots

### Tests
- 409/409 unit + integration passing
- Manual: delete cascade + shapes all verified (5 shapes captured)

### Next up
- v3.60: dynamic multi-format combos (Stroke + Skins, Team Stroke + Vegas side-bet, etc.) — user opted for schema-driven checkboxes path; spec drafting begins next.

---

## v3.59.3 — 2026-05-31
### Session 76 (cont.) — Topbar brand link goes to user dashboard, not landing

User reported:
> "When you click Clubhouse in the upper left make it go back to their
> user profile not the main page. Just make sure all the backs and
> functional buttons are done correctly so that the site functions like
> it should"

The JORD logo + page-title strip in the topbar was a hard-coded
`<a href="/">`, so a signed-in user clicking it dumped them on the
public landing page instead of their dashboard. Now the brand link
auto-resolves based on auth state:

- Signed-in personal user → `/clubhouse`
- Signed-in admin → `/admin`
- Anonymous → `/` (landing)

A `homeHref` option on `JORD.renderTopbar()` lets specific pages
override this if needed (e.g. branded charity event microsites that
pin the logo to their own URL).

Verified with a 3-step Puppeteer trace
([tests/manual/test-brand-link.js](tests/manual/test-brand-link.js)):
anonymous `/login` → brand = `/`; signed-in `/clubhouse` → brand =
`/clubhouse`; signed-in `/account` → brand = `/clubhouse`.

### Files
- [public/js/jord.js](public/js/jord.js) — `renderTopbar` reads tokens to pick the right homeHref
- [tests/manual/test-brand-link.js](tests/manual/test-brand-link.js) — regression test

### Tests
- 409/409 unit + integration passing
- Manual: brand-link regression passes

---

## v3.59.2 — 2026-05-31
### Session 76 (cont.) — Vegas wizard 401 fix + format verification harness

Two reports from the user after v3.59:
> "When I was trying to set up a vegas game it said UNAUTHRIZED."
> "Build out a Simulator and run real test for all of these formats.
>  From that I will than go through them 1 by one to see how you did
>  it and how you scored them."

### Vegas wizard 401 fix
The wizard for any pair-format game hits three round-level endpoints
after creating the tournament: `POST /api/rounds/:id/teams`,
`POST /api/rounds/:id/entries`, and `POST /api/rounds/:id/status`. All
three were gated `requireAuth, requireAdminOrSuper`, so personal users
401'd at the first team-formation call. Widened all three to
`requireUserOrAdmin` with an ownership check — the principal must be
the admin who created the tournament, or the personal user who owns
it (`tour.user_id === req.user.id`). Same pattern as v3.57's
`/api/courses` widen and v3.59's `/api/tournaments/:id` widen.

End-to-end regression test
([tests/manual/test-vegas-setup.js](tests/manual/test-vegas-setup.js))
walks a fresh personal-user signup through:
signup → create Vegas tournament → POST two pair teams → activate
round → round-trip `format_settings`. All six steps pass.

### Format verification harness
**Not a shipped feature — a test-only harness.** Lives at
`tests/sim/simulator.js` (pure function, no DB / no HTTP / no fake
users) and runs every format in `lib/formats.js` through the real
`scoring.buildLeaderboard()` at **realistic tournament field sizes**:

- Individual formats: 8 players (2 foursomes worth)
- Pair formats: 16 players in 8 pairs (round-robin Vegas, Better Ball,
  etc.)
- Team formats: 16 players in 4 teams of 4

This catches gaps the old "4 players, 2 pairs" sample couldn't —
notably the previous Vegas engine had **hard-coded "exactly 2 pairs"**
and would have rejected any tournament with 4+ pairs. The Vegas
engine is now N-pair round-robin: every pair plays every other pair
on every hole, and each pair's leaderboard total is the net margin
summed across all opponents. A new unit test
([tests/run-tests.js](tests/run-tests.js)) verifies the 3-pair math
by hand.

The driver [tests/manual/dump-simulator.js](tests/manual/dump-simulator.js)
prints a per-format report to the terminal showing:

- The format's tier / engine / scoring rule
- Default settings applied
- Per-player gross + net totals
- Leaderboard JORD computes (auto-scored formats) or a "manual
  scoring — auto-tally engine coming in v3.60" note

The full report is saved to
[tests/sim/format-verification-report.txt](tests/sim/format-verification-report.txt)
for one-by-one review. **No `/simulator` page or `/api/simulate`
endpoints ship to production** — this is purely a test artifact.

### Files
- [server.js](server.js) — three rounds endpoints widened to user-or-admin
- [lib/scoring.js](lib/scoring.js) — `buildVegas` now N-pair round-robin instead of "exactly 2 pairs"
- [tests/sim/simulator.js](tests/sim/simulator.js) — new test-only sample-round fabricator (8 / 16 / 16-player rosters)
- [tests/sim/format-verification-report.txt](tests/sim/format-verification-report.txt) — committed report (review-friendly)
- [tests/manual/dump-simulator.js](tests/manual/dump-simulator.js) — drives the harness
- [tests/manual/test-vegas-setup.js](tests/manual/test-vegas-setup.js) — Vegas 401 regression
- [tests/run-tests.js](tests/run-tests.js) — added 3-pair round-robin unit test

### Tests
- 409/409 unit + integration passing
- Manual: Vegas setup e2e passes; harness produces all 28 format reports without error

---

## v3.59.1 — 2026-05-30
### Session 76 (cont.) — Picker bubble polish

User feedback on the v3.59 picker:
> "Right now the Bubble with information is always up at least on one.
> Lets make it only if clicked or hovered over. Also, Make the box a
> little more matching with our current UI"

**Bubble is now hover/focus-only.** Removed the `.fmt-card.is-sel
.fc-bubble` rule that was keeping the description bubble pinned open
on the currently-selected card. The bubble now only appears while
the card is being hovered or has keyboard focus.

**Restyled to match the JORD palette.** Dropped the dark-ink tooltip
look (out of place in our cream/saffron UI) for a soft card-style
bubble: cream background, ink text, hairline border-2 outline,
double-tail arrow that paints over the seam for a clean tip, and a
soft drop shadow. The italic "Manual scoring for now…" line now
uses the saffron accent instead of an inline `#FFD79B`.

### Files
- [public/tournaments.html](public/tournaments.html) — `.fc-bubble` palette + visibility rules
- [tests/manual/capture-picker-screenshots.js](tests/manual/capture-picker-screenshots.js) — parks the puppeteer cursor at (2,2) before each shot so unhovered states actually look unhovered

### Tests
- 408/408 unit + integration passing
- Manual: re-captured all 6 picker screenshots — default + selected states confirm no perma-bubble; hover state confirmed working

---

## v3.59.0 — 2026-05-30
### Session 76 — New-game menu rework: more games, hover bubbles, wagering settings

User feedback on the format picker:
> "Lets make the logos a little more fun and also lets have a fun description
> bubble when hovering over. Right now the description is at the bottom of the
> page. That is useless. Also, if it is possible Add the games that are here
> and wire up the platform so it does all the scoring for the people. For games
> [that have] points… make sure that there is a setting that the player or
> players can set the point structure… Also for games like vegas you should
> be able to set the dollar or cent amount per point etc."

**Picker redesign.** Each card now has its own emoji (not just one per
engine — Skins is 💰, Nassau is 🏆, BBB is 🔔, Snake is 🐍, Vegas is 🎲,
etc.). Hovering a card lifts it, scales/tilts the emoji, and reveals a
saffron-trimmed description bubble above the card. The dead bottom
description block is gone — every card has its own bubble. Mobile keeps
2-up grid with narrower bubbles.

**8 new games in the catalog** (per the user's reference article):

| Game | Tier | Settings | Status |
|---|---|---|---|
| Nassau | Individual | front_bet, back_bet, total_bet | Manual scoring |
| Bingo Bango Bongo | Individual | pts_bingo/bango/bongo, value_per_point | Manual scoring |
| Dots (Garbage) | Individual | events list (editable), value_per_point | Manual scoring |
| Snake | Individual | snake_penalty | Manual scoring |
| **Vegas** | Pair | value_per_point, flip_birdie | **Auto-scored** |
| Chapman / Pinehurst | Pair | — | Manual scoring |
| Sixes / Round Robin | Pair | — | Manual scoring |
| Foursomes Stroke | Pair | — | Manual scoring |

Plus `value_per_skin` was added to the existing **Skins** format.

**Wagering & points panel.** When the selected format has a settings
schema, a saffron-bordered panel renders inline below the picker. Money
fields show a `$` prefix; toggles (e.g. Vegas's birdie-flip rule)
render as switches; Dots's event roster is fully editable — rename,
re-point, remove, or `+ Add event` for custom dots. All values
round-trip through a new `tournaments.format_settings` JSON column.

**Vegas auto-tally.** A new scoring engine: groups entries into the two
pairs (by team label), combines each pair's net scores into a 2-digit
number (lower-first), and awards the difference to whoever's lower per
hole. Optional birdie-flip rule on by default — if your opponent
birdies, you must put your HIGHER score first. The leaderboard shows
the signed margin between the two pairs.

The other 7 new games are **selectable** (pick them in the picker, fill
out settings, run the round on stroke-play scorecards), but the
leaderboard tally is recorded manually for now. An orange "MANUAL"
badge on the card flags this. Each engine has its own
file → v3.60 will wire BBB / Dots / Snake / Nassau / Chapman / Sixes /
Foursomes.

### Other changes
- `GET /api/tournaments/:id` is now `requireUserOrAdmin` (with proper
  ownership / member check) so personal users can read their own
  rounds in the Clubhouse instead of 401'ing
- `roundLeaderboardPayload` now includes `format_settings` so live.html
  can show "$X.YZ per skin / per point" under the headline
- `live.html` renders `scoreType: 'vegas'` with the `Vegas — pair margin` caption

### Files
- [lib/formats.js](lib/formats.js) — per-format emoji, settings schemas, manualScoring flag, 8 new formats, `DOTS_DEFAULTS`, `defaultSettings()` / `isPickable()` helpers
- [lib/scoring.js](lib/scoring.js) — `buildVegas()` engine, `PICKABLE_FORMATS` export, vegas dispatch
- [server.js](server.js) — `format_settings` column + sanitizer + round-trip, `roundScoringOpts` threads settings into engine, GET tournament auth widened
- [public/tournaments.html](public/tournaments.html) — picker redesign (CSS + JS), wagering panel renderer + handlers, `defaultsForFormat()`, per-format emoji
- [public/live.html](public/live.html) — Vegas scoreType, money note under the headline
- [tests/run-tests.js](tests/run-tests.js) — Vegas unit tests (basic + birdie flip), relaxed manualScoring + leaderboard payload regex
- [tests/manual/test-format-picker.js](tests/manual/test-format-picker.js) — Puppeteer smoke test: 10-step catalog + settings round-trip
- [tests/manual/capture-picker-screenshots.js](tests/manual/capture-picker-screenshots.js) — visual regression screenshots

### Tests
- 408/408 unit + integration passing
- Manual: all 10 smoke checks pass; new Vegas engine verified against hand-computed cases (basic margin, birdie flip swing)

### Follow-up (v3.60)
- Wire auto-tally engines for Nassau (front/back/total bet ledger), BBB
  (hole-event tracker), Dots (event-points scorecard), Snake (3-putt
  marker), Chapman, Sixes (rotating-pair rolling totals), Foursomes
  Stroke (alt-shot validator)
- Show "$X won" column on leaderboard for Skins/Vegas

---

## v3.58.0 — 2026-05-30
### Session 75 — Log out + personal-user account settings

**Log out** — added to the Clubhouse topbar (next to a new ⚙ Settings
link). Calls `/api/users/logout`, clears both tokens from localStorage,
and routes back to the landing page. Admins are unaffected — they keep
the `← Admin` link they already had.

**`/account` settings page** — a single full-profile page for personal
users, split into clear cards:

1. **Profile** — name, email (Change… modal with current-password
   confirmation), phone, birth date
2. **Address** — street + apt, city, state, zip, country (used for
   shipping prizes, sponsor gifts, JORD merch)
3. **Your golf game** — GHIN#, manual handicap fallback, home club,
   preferred tees (Tips → Junior), dominant hand
4. **Notifications** — toggles for game invites and round results
5. **Password** — Change… modal (current-password verification, drops
   every OTHER session for the user, keeps current session alive)

All fields PATCH `/api/users/me` in a single round-trip; email + password
changes go through dedicated endpoints because they need current-
password confirmation. A sticky bottom save bar shows `Saved.` /
`Could not save.` status.

**GHIN handicap auto-pull** — researched the landscape. The official
path is USGA's **Golfer Product Access (GPA) program** — a real,
sustainable API but approval-gated by USGA. The unofficial
`api2.ghin.com` endpoint exists but is undocumented and can break.

Shipped: store the GHIN# in `users.ghin_id` now; show a clear
"sync goes live once our USGA integration is approved" note on the
form. Backend: `POST /api/users/me/ghin/verify` returns 501 with the
same message — wires up cleanly in a follow-up session once we have
GPA credentials.

### Files
- [server.js](server.js):
  - **Migration** — added 14 new `users` columns (phone, birth_date,
    address_line1/2, city, state, zip, country, home_club,
    preferred_tee, dominant_hand, ghin_verified_at, notif_invites,
    notif_results)
  - **Endpoints** — `GET /api/users/me` now returns the full profile;
    new `PATCH /api/users/me`, `POST /api/users/me/change-email`,
    `POST /api/users/me/change-password`, `POST /api/users/me/ghin/verify`
  - Registered `/account` → `account.html` in the page map
- [public/account.html](public/account.html) — new page (≈300 lines)
- [public/tournaments.html](public/tournaments.html) — Clubhouse topbar
  now renders `⚙ Settings` + `Log out` for personal users
- [tests/manual/test-account-settings.js](tests/manual/test-account-settings.js) — Puppeteer e2e covering signup → save → reload → password change → email change → logout

### Tests
- 406/406 unit + integration passing
- Manual: full /account flow verified end-to-end; password rotation
  and email rebinding both validated against the login API

### Follow-up
- Apply to USGA's GPA program (jord+ops should contact USGA Handicapping team)
- Once approved, wire the GHIN sync into `POST /api/users/me/ghin/verify`
  and schedule a periodic refresh

---

## v3.57.0 — 2026-05-28
### Session 74 — Personal users can actually reach the Clubhouse

User reported that signup + sign-in were still broken after the v3.56
deploy. Re-tracing the flow surfaced a deeper bug: **once a personal
user signed in, `/clubhouse` immediately bounced them back to
`/login`**, so from the user's POV nothing happened.

**Root cause:** `/api/courses` (and `/api/courses/:id`) were gated by
`requireAuth`, which only accepts admin tokens. The Clubhouse's
`loadAll()` calls `/api/courses` on every boot. A signed-in personal
user hit 401, the page's 401 handler cleared **both** tokens and ran
`location.href = '/login'`. Net effect: sign-up succeeds, token gets
issued, then 1.5s later both tokens are gone and we're back at /login
with no error visible — exactly matching the user's "I can't create a
new account and login" complaint.

**Fix:** swap `requireAuth` → `requireUserOrAdmin` on the two read-only
course endpoints used by the Clubhouse. Mutations (POST/DELETE/import)
stay admin-only — adding courses from a personal account is a separate
UX problem worth tackling later.

Also made the "That email is already registered" error on the
signup form actionable. The error box now includes an inline
**Sign in with this email →** button that flips the form to Sign in
mode and keeps the email + password the user already typed. Cuts the
"oops, I already have an account" case from a four-click escape hatch
(read error → switch tab → re-type email → re-type password) to one
click.

### Files
- [server.js](server.js) — GET `/api/courses` and GET `/api/courses/:id` now use `requireUserOrAdmin`
- [public/login.html](public/login.html) — actionable 409 in personal + organizer signup forms; new `.auth-err button.link` style
- [tests/manual/test-already-registered.js](tests/manual/test-already-registered.js) — Puppeteer trace: seed account → duplicate signup → click inline "Sign in with this email" → land on /clubhouse
- [tests/manual/test-fresh-signup.js](tests/manual/test-fresh-signup.js) — Puppeteer trace: chooser → personal tile → fill signup → /clubhouse (no bounce)

### Tests
- 405/405 unit + integration passing
- Manual: both new Puppeteer scripts pass; verified the new account persists in localStorage and the user stays on /clubhouse

---

## v3.56.0 — 2026-05-28
### Session 73 — Unified sign-in (chooser is for signup, not sign-in)

User reported the chooser-after-clicking-Sign-In friction:
> "When I signed in to the personal version this is what screen it
> popped to after I clicked sign in" — and the screenshot was the
> "What brings you here?" chooser.

The chooser is great for new visitors who genuinely don't know which
path to pick. But for a returning user who clicked "Sign in", being
asked "What brings you here?" is friction — they already know.

#### What changed
- **New `renderUnifiedSignIn()` form** on `/login`. Single email +
  password field, no chooser, no personal/organizer toggle. The
  submit handler tries `/api/users/login` first (most common
  case), then falls back to `/api/auth/login` on 401. Whichever
  succeeds → set the right token → redirect to `/clubhouse` or
  `/admin`. Errors that aren't 401 (network, 5xx) propagate as-is.
- **`?intent=signin` URL param** routes to the unified form,
  skipping the chooser. The chooser is now only reached by
  visitors who explicitly click "Sign up" (or land on bare
  `/login` with no intent).
- **Landing nav repointed** — "Sign in" now → `/login?intent=signin`
  (unified form, returning-user path). "Sign up" stays at
  `/login` (chooser → tile → signup form, new-visitor path).
- **Cross-links between flows:**
  - On the unified sign-in form: *"New here? Create an account →"*
    drops the intent param and goes back to the chooser.
  - On the chooser: *"Already have an account? Sign in →"* adds
    `?intent=signin` and lands on the unified form.

#### Why this works
The two flows have different mental models:
- **Sign up:** the user IS deciding personal vs organizer. The
  chooser is the right tool — it asks the question they need
  answered.
- **Sign in:** the user already HAS an account. Asking which kind
  they have is friction; the backend can just figure it out from
  the email.

#### Tested
- **405/405 unit tests pass** (+5 new) covering: unified form
  function existence, intent-param routing, login attempt order
  (users first, admins fallback), correct token + redirect per
  match type, cross-links between flows.

---

## v3.55.0 — 2026-05-28
### Session 72 — Signup UX fix + personal-user admin tool

Two user-reported issues:

1. **"I tried to create one but no account was made — didn't even have to
   set a password."** Root cause: the chooser tile opened the form in
   **Sign in** mode, so a new visitor filled in email + password, hit
   the (sign-in!) submit button, and got "wrong email or password" with
   no account creation. The "Create account" tab was a click away but
   they never noticed.
2. **"I want to be able to make users now for the clubhouse — what else
   needs to be done?"** No admin tool existed to list, create, or
   reset personal-user accounts. Built one.

#### What changed
- **Chooser defaults to signup, not sign-in.** Clicking either tile
  (or using the `?track=` deep link) now opens the form in **Create
  account** mode. Existing users can still click the **Sign in** tab.
  Reasoning: anyone arriving at the chooser is new — existing users
  get auto-redirected by the boot logic before they see the chooser
  at all.
- **Welcome toast after signup.** `sessionStorage.jord_just_signed_up`
  set by `/login` on successful signup; cleared by
  `/clubhouse` (personal) and `/admin` (organizer) on first paint,
  which shows: "Account created — welcome to the Clubhouse! Start
  your first game with + Create a game." (or the organizer
  equivalent).
- **Backend: super-admin personal-user management** (4 endpoints,
  all `requireAuth + requireSuper`):
  - `GET  /api/admin/users` — paginated list (max 200) with optional
    `?q=` substring search across name + email. Returns `total` and
    `last_week` count for the dashboard header.
  - `POST /api/admin/users` — manual create (name, email, password
    ≥ 8 chars, optional handicap). Same validations as the public
    `/api/users/signup`, just no auto-session.
  - `POST /api/admin/users/:id/reset-password` — set a new password.
    Side-effect: **deletes all open `user_sessions`** so the user has
    to sign back in.
  - `DELETE /api/admin/users/:id` — full account delete. Tournaments
    they hosted stay (the `user_id` becomes an orphan reference).
- **New page `/admin/users`** (super admin only):
  - Stat strip — total accounts + last 7 days.
  - Search bar (200ms debounce, server-side filtering).
  - Table with name, email, handicap, signed-up date, per-row actions
    (🔑 Reset password, 🗑 Delete).
  - "+ Create user" button opens a modal with a pre-filled random
    password (12 chars, base-36) the super admin can read over the
    phone or paste into a chat.
  - Reset modal same pattern: pre-filled new password, one-click reset.
- **Nav link** — main admin events page (`/admin/events/:id`) header
  gets a "👥 Personal Users" button visible only to super admins.

#### Tested
- **400/400 unit tests pass** (+13 new) covering: all four endpoints,
  super-only enforcement, search wiring, session invalidation on
  reset, page-route registration, page file existence, table handlers
  + modals, chooser default-to-signup, welcome flag round-trip, admin
  nav link.

---

## v3.54.0 — 2026-05-26
### Session 71 — Full LD/CTP module gating

v3.53 hid only the per-contest *penalty rules* when the toggles were
off. v3.54 extends that to the full LD/CTP module stack: the entire
set of tabs and header buttons that only make sense for an event
actually running Longest Drive or Closest to Pin contests.

A charity event running just registrations / sponsorships / donations
now sees a clean editor without irrelevant tabs. The moment they
toggle LD or CTP on, the whole stack lights up.

#### What changed
- **`public/admin/editor.html`** — extended `syncGameSettings()`
  (already wired to the LD/CTP toggle change events) to also hide /
  show:
  - **Left-nav tabs** — `Course map`, `Ball Codes`, `Players & teams`,
    `Reps`, and `Alerts` all listed in `CONTEST_ONLY_PANELS`. The
    `Settings` tab stays always-visible.
  - **Header buttons** — `Leaderboard` and `Monitor` listed in
    `CONTEST_ONLY_HEADER_BTNS`. The other header links (`Site`,
    `Registrations`, `Check-in`, `Pairings`, `Auction`, `Export CSV`,
    `End tournament`) stay always-visible since they apply to any
    event type.
  - **Auto-switch** — if the user was parked on a contest-only panel
    (say, Course Map) and just toggled both contests off, the editor
    bounces them back to Settings so they don't see an empty card.
- **Wired to existing change-listeners** — the
  `has_longest_drive` / `has_closest_pin` checkbox listeners already
  call `syncGameSettings()` on change, and `fillSettings()` calls it
  once after loading the event row, so the visibility is in sync
  immediately on open + lives-updates when the organizer toggles.

#### Why it looks the way it does
- Course Map, Ball Codes, Players & Teams, Reps, and Alerts are all
  LD/CTP-specific by design — the polygon zones, drop-code scanning,
  4-player team registry, on-course reps, and rough/OOB alerts are
  all features of the GPS-scored contests, not the registration /
  sponsorship / donation / silent-auction side.
- Leaderboard (`/leaderboard/:id`) and Monitor (`/monitor/:id`) are
  the LD/CTP-specific live boards. The Clubhouse-style
  `/tournament/:id` cumulative leaderboard is reached separately
  (via the scoring-bridge "Start scoring" flow on the Pairings page).

#### Tested
- **386/386 unit tests pass** (+5 new) covering: `CONTEST_ONLY_PANELS`
  list declared, includes ball codes / players / reps / alerts,
  header button gate declared, nav-item toggle wiring, auto-switch
  back to Settings.

---

## v3.53.0 — 2026-05-26
### Session 70 — Personal → organizer upgrade requests + LD/CTP collapse

Two requested features:

1. **Personal users can now request organizer access from inside the
   Clubhouse.** JORD's team vets each request (no auto-grant). On
   approval, the new admin row reuses the user's existing password hash
   so they sign into `/admin` with the same credentials as
   `/clubhouse` — no temp password to remember.
2. **LD/CTP settings collapse** in the admin event editor. The "Longest
   Drive — penalty rules" and "Closest to Pin — penalty rules" blocks
   hide when the corresponding contest toggle is off, so an event
   running CTP-only doesn't see rough/OOB knobs cluttering the form.

#### What changed
- **Schema** — `tournament_requests.requester_user_id` (nullable, FK
  to the personal user when the request came from the Clubhouse
  upgrade flow). The legacy /signup sales form leaves it null, same
  workflow as before.
- **`POST /api/users/request-organizer-upgrade`** (auth: `requireUser`) —
  inserts a `tournament_requests` row with `status='pending'`,
  `requester_user_id` stamped, display name composed as
  "Person (Org)". Rejects duplicate pending requests with a friendly
  409 ("you already have a pending request"). Email + name auto-
  filled from the user's profile so they only have to type the
  org details.
- **`GET /api/users/organizer-request-status`** — returns the user's
  latest request row (any status) so the Clubhouse can render the
  right CTA state: none / pending / accepted / rejected.
- **Accept-request flow extended** — `POST /api/admin/tournament-requests/:id/accept`
  now checks `requester_user_id`. When present, the new admin row is
  minted with **the user's password hash mirrored** rather than a
  fresh temp password. Result: the same email + password works in
  both `/clubhouse` and `/admin`. Notification flips to "you've been
  granted access" (no password reveal) instead of the welcome-with-
  temp-password copy.
- **Clubhouse home** — new "Request organizer access" card (visible
  only to signed-in personal users without an admin token). Polls
  `/api/users/organizer-request-status` on load; the card body
  changes based on state:
  - **none** → "Running a charity tournament?" CTA + Request button
  - **pending** → "⏳ Request in review" copy
  - **accepted** → "✅ You're approved" + "Open admin console →"
    link to `/admin`
  - **rejected** → "Request declined" + reach-out copy
- **Upgrade modal** — lightweight form: org name, tournament name
  (optional), event date, venue, location, contact phone, expected
  players, contest type (LD/CTP/both), charity checkbox, notes.
  POSTs to the upgrade-request endpoint, closes on success,
  re-renders the card in the pending state.
- **Admin event editor** — LD and CTP penalty-rule sections now wrap
  in `#ld-settings` / `#ctp-settings` containers. New
  `updateContestVisibility()` listens on the contest-toggle change
  event and hides/shows the corresponding block. Initial render
  (after `fillSettings()`) calls it once so the form opens in the
  right state for the existing event's toggles.

#### Tested
- **381/381 unit tests pass** (+10 new) covering: schema migration,
  both new endpoints, duplicate-pending guard, password-mirror branch
  in the accept flow, Clubhouse upgrade-CTA wiring, modal endpoint
  target, LD + CTP block wrappers, visibility handler.

---

## v3.52.0 — 2026-05-26
### Session 69 — Auth chooser + self-service organizer signup

Fixed the discovery gap on signup: a brand-new visitor could land at
`/login` and only see an admin-flavored form, while the casual-golfer
path was hidden behind a tab toggle. Worse, getting an organizer
account required a sales-form (`/signup`) gated on "we'll be in touch
within 48 hours." Both paths are now self-service.

#### What changed
- **New endpoint `POST /api/auth/signup`** — self-service organizer
  signup. Body: `{ name, email, password, org_name }`. Creates an
  `admins` row with `role='admin'`, `active=1`, returns a session
  token + the same shape as `/api/auth/login`. Rejects duplicate
  emails with "That email already has an organizer account — try
  signing in instead." Composes the display name as
  `"Name (Org Name)"` when an org is supplied so the admin top-bar
  shows the org identity at a glance.
- **`/login` rebuilt as a two-tile chooser:**
  - **⛳ "Play with friends"** — reveals the personal user form
    (`/api/users/login` / `/api/users/signup` — unchanged).
  - **🏆 "Run a charity or corporate event"** — reveals the new
    organizer form (`/api/auth/login` / `/api/auth/signup`).
  - Tile copy describes what each path is for (formats / event-site /
    Stripe / silent auction) so a visitor instantly knows which
    fits.
  - Back-link from either form returns to the chooser.
  - `?track=personal` or `?track=organizer` URL params skip the
    chooser and land directly on a form — useful for landing-page
    deep-links.
  - Boot logic: signed-in user → `/clubhouse`; signed-in admin →
    `/admin`. Either falls back to `?next=…` when provided.
- **Landing page nav** — "Sign in" + "Sign up" buttons now point at
  `/login` (the chooser) instead of the admin-only `/admin` /
  `/signup`. Hero CTAs ("Sign Up Your Tournament") still point at
  `/signup` for organizers who want the sales-form / hand-holding
  flow; that page is kept around for the high-touch path.

#### Tested
- **371/371 unit tests pass** (+10 new) covering: organizer signup
  route registration, admin-row creation with correct role, duplicate
  email rejection, org-name composition, tile chooser markup, boot
  redirects for both principals, `?track=` deep link support,
  organizer form POSTs to the new endpoint, landing-nav repointed.

---

## v3.51.0 — 2026-05-26
### Session 68 — Banter chat + Clubhouse home for joiners

Three issues from user feedback after v3.50:

1. **No way for friends to chat in the round.** Banter has been a
   placeholder column on `tournaments` since forever — actually built it.
2. **`/clubhouse` only showed games they created.** Friends who joined
   someone else's game saw an empty Clubhouse. Fixed to use
   `/api/tournaments/mine` (created OR joined).
3. **Confusing copy on the join page.** "Your scorecard link will be
   active when the game starts" implied a wait. Rounds are auto-active
   on creation; the scorecard is live the moment they join. Updated copy.

#### What changed
- **Schema** — `banter_messages` table: `id`, `tournament_id`,
  `sender_user_id` (nullable, stamped when signed in), `sender_name`
  (always required), `body`, `created_at`. Indexed by
  `(tournament_id, created_at)` for fast tail-N reads.
- **Endpoints** — three new, all keyed on the share code (same trust
  model as the join page):
  - `GET /api/round-public/:shareCode/banter?limit=N` — returns last
    N messages (default 100, cap 200) in chronological order.
  - `POST /api/round-public/:shareCode/banter` — `{ body, sender_name }`.
    `x-user-token` is honored when present so signed-in posters get
    `sender_user_id` stamped and their name auto-falls-back from
    their profile.
  - `GET /api/round-public/:shareCode/banter/stream` — SSE on a
    dedicated channel (separate from the round leaderboard stream
    so heavy chat doesn't slow score updates).
- **`broadcastBanter()`** — fans new messages out to every SSE
  subscriber keyed by tournament id.
- **`_findTournamentByShareCode()`** — shared helper used by all
  three banter endpoints and the existing public round lookup, so
  case-insensitive matching + trim is in one place.
- **Public join page** (`/round/:shareCode`) — new chat drawer:
  - Floating 💬 Banter pill bottom-right (mobile-friendly tap target).
  - Expandable panel with message list (mine highlighted), input,
    and "Posting as" name field (pre-filled from user profile or
    claimed entry).
  - SSE auto-connects on page load; new messages while drawer is
    closed bump the unread badge on the pill.
  - Optimistic insert on send; SSE echo dedupes by id.
- **Clubhouse detail view** — new "💬 Banter" button next to "🔗 Share
  link". Opens the join page in a new tab so the host posts in the
  same group chat as their friends.
- **Clubhouse home** — when a signed-in personal user has no admin
  token, the "Your games" list now pulls from `/api/tournaments/mine`
  (created OR joined) instead of `/api/tournaments` (created only).
- **Join page copy** — replaced "Your scorecard link will be active
  when the game starts" with "Your scorecard is ready below —
  bookmark this page to find it again on game day." Plus a more
  concrete next-step paragraph.

#### Tested
- **361/361 unit tests pass** (+12 new) covering: schema, three
  endpoint registrations, length validation, broadcaster presence,
  user_id stamping, chat UI on join page, SSE wiring, Banter button
  on Clubhouse detail, my-games endpoint use, copy fix.

---

## v3.50.0 — 2026-05-26
### Session 67 — Team side-bet groupings + share-link 500 fix

Two issues from user feedback after v3.49:

1. **`Status 500. Try again in a moment.` on every share link.** The
   `/api/round-public/:shareCode` lookup was selecting a `location`
   column from `courses` that doesn't exist (real columns are `city`,
   `state`, `club_name`). SQLite threw, Express returned 500. Fixed
   by composing the location from real columns server-side.

2. **No way to group 4-vs-4 teams for individual-format rounds.** The
   wizard only exposed teams when the format itself was a team format
   (best ball / scramble / foursomes). For a stroke-play 4v4 side bet,
   there was no surface to label "Pat, Sam, Alex, Jordan = Team A" and
   no UI showing aggregated team scores.

#### What changed
- **`POST /api/tournaments/:id/field`** — auth gate loosened from
  admin-only → `requireUserOrAdmin` + `canEditTournament` so the
  game host (admin OR user) can add players. Was a v3.48 regression
  blocking personal-user round creation entirely.
- **`POST /api/tournaments/:id/field`** — now accepts an optional
  `team_name`. When present, the server upserts a `round_teams` row
  per round (idempotent on the team name within a round so multiple
  field calls share an id) and stamps `round_entries.team_id`. Works
  for any format — individual formats use it for side-bet aggregation
  while team formats keep their existing semantics.
- **`lib/scoring.js`** — `scoreEntry()` now passes `teamId` through to
  the row + adds `parPlayed` for the team-aggregate math.
- **`server.js`** — new `buildTeamStandings()` helper. Aggregates by
  `teamId` across the leaderboard rows for individual formats only
  (skips for `bestball` / `scramble` / `team-lownet` since the format
  engine already aggregates). Sorts by net or stableford points
  depending on the format.
- **Leaderboard payload** — gains a `teams: [...]` array with each
  team's position, name, members list, gross, net, points, par-played,
  to-par numbers, and earliest `thru`. Empty when nobody opted in.
- **Wizard `stepPlayers`** — new optional "Team" text field with a help
  tooltip explaining the side-bet pattern. Renders below name/HCP/tee.
  Each player card shows `· Team A` next to the HCP when set.
- **Public live page (`/live/:roundId`)** — when `state.teams` is non-
  empty, renders a "Team standings" strip ABOVE the individual rows
  with each team's position, name, member list, lowest-thru, and total
  (to-par or points). Leader gets the saffron gradient.
- **Tests** — share-link 500 regression coverage (catches any future
  query of bogus columns), team field POST, team_id stamping, scoreEntry
  team passthrough, buildTeamStandings presence, payload structure,
  wizard field, live render.

#### Tested
- **349/349 unit tests pass** (+9 new).

---

## v3.49.0 — 2026-05-26
### Session 66 — Live leaderboard click-to-expand + share-link bug fix

Two issues from real-user feedback on v3.48:

1. **Share link failed with "The string did not match the expected pattern"** —
   the share modal's `sms:` link used `sms:?&body=…` (extra `&` after `?`),
   which iOS Safari rejects with that specific error string. Fixed to
   `sms:&body=…` (or `sms:?body=…`, both RFC-5724-compliant; iOS accepts
   the former). The round-join page also now handles non-JSON responses
   gracefully (Railway redeploy windows return HTML 502 pages that crash
   iOS's `JSON.parse` with the same error message — now we show a
   "server's coming back online" message with status code instead).
   Public share-code lookup is now `COLLATE NOCASE` so typed-in codes
   still resolve if the user fat-fingered capitalization.

2. **Live leaderboard only showed totals** — no way to see hole-by-hole
   scores per player. Now the leaderboard rows are click-to-expand; the
   drawer shows two 9-hole grids (Out / In) with hole number, par, and
   the player's score per hole, color-coded by score-to-par (eagle/
   birdie/par/bogey/double). Totals strip below shows Out + In + Total
   + course handicap.

#### What changed
- **`lib/scoring.js`** — `scoreEntry()` now returns `scores` (hole → strokes)
  and `strokeMap` (hole → received strokes for handicap formats) on each
  row. The existing fields (`thru`, `gross`, `net`, `points`, etc.)
  unchanged — pure addition.
- **`server.js`** — `roundLeaderboardPayload()` attaches the round's
  `holes` array (par + stroke index per hole) at the top level so the
  client can render the drawer without a second fetch.
- **`server.js`** — both `GET /api/round-public/:shareCode` and
  `POST /api/round-public/:shareCode/join` use `COLLATE NOCASE` on
  the share code lookup.
- **`public/tournaments.html`** — share modal `sms:` href fixed.
- **`public/live.html`** — new expand-row UI:
  - `data-toggle` attribute + `state.expanded` Set tracking which rows
    are open. SSE re-renders preserve the open state so live updates
    keep flowing inside the open drawer.
  - Color-coded score cells: gold for eagle+, green for birdie,
    plain for par, red for bogey, dark red for double+.
  - Out / In / Total summary line under each drawer.
  - Color-legend chips so the score colors are self-documenting.
- **`public/round-join.html`** — graceful error display when the API
  responds with non-JSON (HTML 502 during Railway deploy, status pages,
  etc.) instead of crashing on `JSON.parse`. Pre-fetch length sanity
  check on the share code.

#### Tested
- **340/340 unit tests pass** (+6 new) covering: scoreEntry includes
  scores, leaderboard payload includes holes, COLLATE NOCASE on the
  public lookup, fixed sms: URL pattern, live-page expand handler
  wiring, expanded-state preservation across re-renders.

---

## v3.48.0 — 2026-05-26
### Session 65 — Clubhouse for users (Golf Game Book-style)

The Clubhouse has been an admin-only tool until now. v3.48 opens it up
to **personal users** — anyone with a `/login` account can create casual
rounds, share an invite link with friends, and edit games after the
fact. Friends join through a single link, no account required.

#### What changed
- **Schema** — two nullable columns added so personal-user-created
  rounds and joined entries get tracked alongside the existing
  admin/organizer rows:
  - `tournaments.user_id TEXT` — non-null when the round was created by
    a personal user (existing `admin_id` stays for organizer-created
    enterprise rounds).
  - `round_entries.user_id TEXT` — stamps an entry to a user when they
    joined via a public share link while signed in (powers the
    "My games" list).
- **`requireUserOrAdmin` middleware + `actorIdentity` helper** — runs
  the admin-token check first (most callers are admins), falls through
  to the user-token check. Routes that previously read `req.admin.id`
  now use `actorIdentity(req)` which returns `{ id, kind: 'admin' | 'user' }`.
- **Tournament endpoints**:
  - `GET /api/formats` — was `requireAuth` (admin), now
    `requireUserOrAdmin`. Lets the Clubhouse wizard load formats for
    signed-in personal users.
  - `GET /api/tournaments` — filters by creator. Admins see what they
    own; users see what they created.
  - `POST /api/tournaments` — accepts either token; stamps either
    `admin_id` or `user_id` based on who's signed in.
  - `PATCH /api/tournaments/:id` — **new**. Updates name, format,
    type, flights, status on the tournament; also updates `course_id`,
    `round_date`, `holes_segment` on the linked first round when the
    body includes them. `canEditTournament()` gate: super admin
    always, creator admin/user yes, anyone else 403.
  - `GET /api/tournaments/mine` — **new** (user-only). Returns the
    deduplicated set of tournaments the user **created OR joined**
    (via `round_entries.user_id`). Powers a future "My games" tab.
- **Public share + join flow** (the Golf Game Book magic-link pattern):
  - `GET /api/round-public/:shareCode` — **new, no auth**. Resolves a
    `tournaments.share_code` to the round details + current player
    roster (with course name when set). Friends hit this when they
    open the share link.
  - `POST /api/round-public/:shareCode/join` — **new, no auth required
    but x-user-token honored when present**. Adds the friend as a
    `round_entries` row with their name + optional handicap. When
    signed in, the entry inherits `user_id` so it shows up on their
    "My games" list. Auto-computes the course handicap if a tee was
    provided.
  - `DELETE /api/rounds/:roundId/entries/:entryId` — **loosened**.
    Three principals can now delete: the creator admin (or super), the
    creator user (host), or the user who owns the entry (removing
    themselves). Was admin-only.
- **New page `/round/:shareCode`** (`public/round-join.html`) —
  friend-facing join page. Shows the game name, date, course, format;
  lists current players (highlights the signed-in user); single form
  field for "Your name + handicap" → "I'm in" button. Falls through
  to a link-to-scorecard view once joined. Optional "Sign in to track
  this on your profile" CTA for guests.
- **Clubhouse UI** (`public/tournaments.html`):
  - Auth gate dropped from admin-only to **admin OR user**. Anonymous
    visitors get a `/login?next=/clubhouse` redirect so they sign in
    once and land back on the wizard.
  - Topbar swaps: admins see `← Admin`; users see `My profile`.
  - Tournament detail view gets two new buttons:
    - **🔗 Share link** — opens a modal with QR code, copyable URL,
      tap-to-text (`sms:` deep link), tap-to-email, and the raw share
      code.
    - **✎ Edit game** — modal with name + date + format picker that
      PATCHes the tournament. Course swap deferred (still re-pick from
      the wizard).
  - 401 errors during boot now clear both tokens and route to `/login`
    so a stale admin token doesn't trap a logged-out user.

#### Why this looks the way it does
- The pattern mirrors **Golf Game Book**: one person hosts, gets a
  short link to share, friends join without signup, day-of each
  player scores on their own phone via the existing
  `/scorecard/:roundId` page, and `/live/:roundId` already streams
  live updates via SSE.
- Existing endpoints (`/api/rounds/:roundId/scores`,
  `/api/rounds/:roundId/leaderboard`, `/api/rounds/:roundId/stream`)
  are already public and require no auth — that infrastructure
  carried over from earlier work. The only gap was creation + invite,
  which this slice closes.

#### Tested
- **334/334 unit tests pass** (+15 new) covering: schema, middleware
  presence, auth gates on POST/PATCH/DELETE, public join + lookup
  endpoints, share-modal + edit-modal UI wiring, page route
  registration, and the new join page parses cleanly.

---

## v3.47.0 — 2026-05-26
### Session 64 — E5 phase 2: Supplies marketplace

Final phase of the platform spec ships: a JORD-owned product catalog
where organizers buy supplies (signs, scoreboards, JORD merch, partner
gear). Different payment flow from everything else on the platform —
direct Stripe charges to JORD's own account, no Connect destination.

#### What changed
- **lib/stripe.js** — new `createDirectCheckoutSession()` helper. Mirrors
  `createCheckoutSession` but drops `application_fee_amount` +
  `transfer_data.destination` (JORD is the seller, not the platform).
  Adds `collectShipping: true` and `phone_number_collection: enabled`
  so Stripe Checkout collects a US shipping address inline.
- **Schema** — two new tables:
  - `supply_products` — JORD's catalog. `id`, `sku`, `name`,
    `description`, `image_data` (base64, ≤2.5 MB), `price_cents`,
    `category`, `sort_order`, `active`.
  - `supply_orders` — buyer orders. `id`, `admin_id` (buyer),
    `product_id`, `qty`, `unit_price_cents`, `total_cents`, `status`
    (pending/paid/shipped/canceled), `stripe_session_id`, full
    shipping address fields, `tracking_url`, timestamps.
- **Server endpoints**:
  - `GET  /api/admin/shop/products` — any admin browses (super sees
    inactive via `?all=1`).
  - `POST /api/admin/shop/products` — super-only create.
  - `PATCH /api/admin/shop/products/:id` — super-only update.
  - `DELETE /api/admin/shop/products/:id` — super-only delete.
  - `GET  /api/admin/shop/orders` — buyer's own orders.
  - `POST /api/admin/shop/orders` — initiate checkout. Inserts a
    `pending` order, returns the Stripe Checkout URL (or, in mock
    mode, marks paid immediately).
  - `GET  /api/admin/shop/orders/:id` — order detail (buyer sees own;
    super sees any).
  - `GET  /api/admin/shop/orders/all` — super-only full list.
  - `POST /api/admin/shop/orders/:id/ship` — super marks shipped,
    optionally with a tracking URL.
- **Stripe webhook handler** extended: when `metadata.supply_order_id`
  is present, the webhook updates `supply_orders` to `paid` AND
  captures the shipping name + address + phone Stripe collected at
  Checkout. Returns early so the registration-row logic below
  doesn't fire on supply orders.
- **Four new admin pages**:
  - `/admin/shop` — catalog with category filter pills, product cards
    (photo, name, description, price, qty selector + Buy button).
  - `/admin/shop/orders` — buyer's order list, status chips, links to
    detail.
  - `/admin/shop/orders/:id` — order detail with product summary,
    totals, shipping address, tracking URL when present, and a
    super-admin "Mark shipped" form.
  - `/admin/shop/products` — super-admin product CRUD with modal
    form (name, SKU, price, category, description, photo upload,
    active toggle).
- **Nav** — main admin events page (`/admin`) gets a 🛒 JORD Shop button
  visible to every admin.

#### Out of scope (phase 3 / future)
- Multi-product cart (single product per checkout for now).
- Discount codes / coupons.
- Multi-currency.
- International shipping addresses (US-only allowed list right now —
  trivial to expand to a longer ISO list when the inventory ships
  outside the US).
- Tax calculation (none applied; JORD absorbs or includes in price).
- Supplier-side fulfillment dashboard (super marks shipped manually;
  no integration with third-party logistics).

#### Tested
- **319/319 unit tests pass** (+25 new) covering: helper export +
  shape, schema, route registration, super-only enforcement on
  product mutations, order admin_id from session, webhook wiring,
  shipping collection, all four new UI files exist + parse, nav
  link.

---

## v3.46.0 — 2026-05-26
### Session 63 — E5 phase 1: Event store

Charity events can now sell add-ons to attendees — mulligans, raffle
tickets, contest entries, merch — alongside the existing player tickets,
sponsorships, donations, and auction. All through the same Stripe Connect
checkout the event already uses.

#### What changed
- **Schema** — `registration_packages.image_data TEXT` (optional product
  photo, `data:image/*` ≤ 2.8 MB) + a new package_kind value:
  `'event_item'` joins `registration` / `sponsorship` / `donation` /
  `auction_item` as the fifth kind. POST/PATCH packages accept it; the
  `includes_players` floor stays at 0 (store items are non-playing).
- **`GET /api/event-sites/:slug`** now returns `store_items: [...]` as a
  separate bucket so the public site can render them in a dedicated
  Shop section without polluting the Register grid.
- **Admin event-site editor** — new "Event store" card with a 10-tile
  quick-add catalog:
  🔁 Single mulligan · 🔁 Mulligan 4-pack · 🎟️ Raffle ticket · 🎟️ Raffle
  5-pack · 🎟️ Raffle 25-pack · 🥏 Closest-to-pin entry · 🚀 Longest-drive
  entry · 🍻 Drink ticket · 👕 Event T-shirt · 🧢 Event hat.
  Each tile seeds a row at a starter price; "+ Add custom store item"
  covers anything else. Inline edit form per item supports name, price,
  quantity limit, description, and a photo upload (≤2.5 MB) reused
  from the auction-item upload pattern.
- **Public event-site `/e/:slug`** — new "Shop the event" section
  between Sponsorships and the Auction teaser. Items render as cards
  with product photo (when set), description, price, "qty available"
  count, and a "Buy now →" button. Disabled with a "Coming soon"
  state when the organizer hasn't finished Stripe onboarding.
- **Register page (`/e/:slug/register?pkg=…`)** — now recognizes three
  non-registration kinds (`sponsorship`, `event_item`, plus the
  existing donation flow). For store items: page title becomes
  "Check out: <item name>", lead copy thanks the buyer, success
  button reads "Confirm purchase →" or "Pay $X →", the order-summary
  label becomes "You're buying", and the player roster is skipped.
- **/e/:slug button delegation** updated so the "Buy now" click on a
  card (or its inner button) goes to /register with the store item's
  package id.

#### Out of scope (phase 2)
- Multi-quantity purchases (5 raffle tickets in one checkout). For now
  organizers add separate bundle packages (1, 5, 25). Quantity-per-
  purchase support would add a `qty` field to the register page and
  the registrations row.
- Inventory tracking that decrements on each sale (today's `quantity_limit`
  caps total sales; nothing decrements during the live event).
- Pickup / shipping tracking for physical merch.
- **Supplies marketplace** (JORD-owned product catalog for organizers)
  — separate phase, different payment flow (direct charges to JORD).

#### Tested
- **294/294 unit tests pass** (+9 new) covering image_data migration,
  package_kind whitelist update, image guards on POST + PATCH, store_items
  split in public payload, STORE_CATALOG length, editor surface, public
  Shop section, register-page store handling.

---

## v3.45.0 — 2026-05-26
### Session 62 — E4: Silent auction (full MVP)

The Donations + Silent Auction phase (E4 in the platform spec) ships in
one slice: items, bidding, donor intake, photo uploads, winner checkout —
all wired end-to-end through the existing Stripe Connect plumbing.

#### What changed
- **Schema** — two new tables (`auction_items`, `auction_bids`) plus
  three event_sites toggles (`auction_enabled`, `auction_intake_enabled`,
  `auction_intro`). Item lifecycle: `pending` → `live` → `ended` →
  `paid`, with `rejected` for admin-declined intake submissions.
- **Server endpoints**:
  - `GET /api/admin/events/:id/auction` — items + bid summaries.
  - `GET /api/admin/events/:id/auction/items/:itemId/bids` — full bid
    list for the bids drawer.
  - `POST/PATCH/DELETE /api/admin/events/:id/auction/items[/:itemId]` —
    CRUD with image_data guard (≤2.8 MB, `data:image/*`).
  - `POST /…/items/:itemId/close` — picks the highest bid as winner,
    flips item to `ended`. No-bids items end without a winner.
  - `POST /…/items/:itemId/checkout-winner` — lazy-creates a per-item
    `package_kind='auction_item'` row, creates a registrations row,
    spins up a Stripe Checkout against the organizer's Connect
    account. Stripe webhook flips the linked item to `paid` on
    `checkout.session.completed` via `metadata.auction_item_id`.
  - `GET /api/event-sites/:slug/auction` — public payload. Items in
    `live` or `ended` status appear (ended ones show "Sold to X" tag).
    `bidding_open` computed from status + opens_at / closes_at so a
    forgotten `live` item with a past close time auto-renders as
    closed.
  - `POST /api/auctions/:itemId/bid` — public bid endpoint. Validates
    bidder name + email, amount ≥ starting bid, amount ≥ current
    high + min_increment_cents. No bidder account required.
  - `POST /api/event-sites/:slug/auction-intake` — public donor
    submission. Lands as `status='pending'` awaiting admin approval.
- **Admin auction page** (`/admin/events/:id/auction`):
  - Stat strip (live count, pending review, total bids, gross revenue
    from paid items).
  - Filter pills (all / live / pending / ended / paid / rejected).
  - Item grid with photo, donor, FMV, bid count + current leader,
    status chip, contextual action buttons (Approve / Close / Checkout
    winner / View bids / Edit).
  - Create/edit modal with photo upload (≤2.5 MB), starting bid,
    increment, FMV, status, opens_at, closes_at.
  - Bids drawer showing every bid with name, email, phone, amount,
    timestamp.
- **Public auction page** (`/e/:slug/auction`):
  - Hero with organizer-supplied intro copy.
  - Item grid showing photo, donor credit, description, FMV (when
    set), current high bid + leader name, closes_at timestamp in the
    event's IANA zone.
  - Bid modal collects amount + name + email + optional phone; client
    pre-fills the next-min amount, server enforces it.
  - Closed lots section below live ones.
- **Donor intake page** (`/e/:slug/donate-item`):
  - Title, description, starting-bid + FMV hints, photo upload,
    donor name + email.
  - Submits to `/api/event-sites/:slug/auction-intake`; lands in the
    admin's Pending queue with a green Approve button.
- **Editor integration**:
  - Site editor gains a "Silent auction" card with enable toggles,
    intake toggle, optional intro copy, and a link to the admin
    auction console.
  - Event editor header gets a `🔨 Auction` nav button.
- **Public event-site teaser** — when auction_enabled, a "Bid on the
  good stuff" section on `/e/:slug` deep-links to the auction page
  (and intake page when enabled), with an item count.

#### Tested
- **285/285 unit tests pass** (+32 new) covering: table creation,
  toggles, route registration, format whitelist, status validation,
  image guard, min-increment enforcement, close-picks-highest logic,
  lazy auction package creation, Stripe webhook wiring, intake-toggle
  check, public payload gating, all four new HTML pages exist and
  parse, editor + nav-button surfaces.

---

## v3.44.0 — 2026-05-26
### Session 61 — Pairings → scoring score-groups bridge

The pairings system and the scoring system have been parallel until now —
pairings handled cart/hole logistics, scoring tracked the leaderboard.
v3.44 wires them: every pairing group mirrors into a `score_groups` row
on the active round so the live leaderboard groups players by foursome.

#### What changed
- **Schema** — three new columns (all idempotent migrations):
  - `score_groups.pairing_group_id TEXT` — links a score_group to its
    source pairing_group. Match-by-name was the alternative but it
    breaks the moment an organizer renames a group.
  - `round_entries.source_registration_id TEXT` + `source_player_index INTEGER`
    — let us reverse-lookup which registration roster slot produced
    each entry, so later pairing edits can re-assign group_id without
    re-materializing players.
- **`_syncPairingsToScoreGroups(eventId, roundId, format)`** — the new
  workhorse:
  - Upserts a score_group per pairing_group, refreshing name / starting_hole
    / tee_time when the pairing was edited after start.
  - Deletes score_groups whose source pairing_group was removed, nulling
    `round_entries.group_id` first since we don't have FK CASCADE.
  - Re-walks every round_entry and sets `group_id` from its source
    registration's pairing assignment (or NULL if unassigned).
  - **Team-card formats** (scramble / foursomes / greensome) force every
    team member into the captain's group so a team isn't split across
    leaderboard groups.
- **Wired into both existing endpoints**:
  - `POST /api/admin/events/:id/start-scoring` mirrors pairings on first
    materialization.
  - `POST /api/admin/events/:id/sync-scoring` re-runs the mirror on every
    sync (picks up any pairing edits since the last sync).
- **New endpoint `POST /api/admin/events/:id/sync-pairings-to-scoring`**
  — re-mirrors without adding new players. Useful when the organizer
  only wants to push pairing-edit changes through without touching the
  player field.
- **Materializer update** — every newly-created `round_entries` row now
  stores `source_registration_id` + `source_player_index` so the sync
  helper can identify it later.
- **UI** — the existing "↻ Sync" button on the pairings page renamed to
  "↻ Sync to leaderboard" and now reports both halves of the operation
  in the success toast: "Added N players · Groups: X created, Y renamed".

#### Why this matters
- Live leaderboard at `/tournament/:id` now groups by pairing, so
  spectators can find their foursome at a glance.
- Pairings + scoring stay in sync without manual touchups — edit a
  group on the pairings page, click Sync, the leaderboard updates.

#### Tested
- **253/253 unit tests pass** (+12 new) covering migrations, helper
  presence, both endpoints calling the helper, orphan cleanup,
  team-card captain logic, and source-column recording.

---

## v3.43.1 — 2026-05-26
### Session 60 — Hotfix pass after v3.43 review

Four bugs caught in a post-deploy review of the v3.38 → v3.43 arc. The
first one (syntax error) was a hard breakage; the rest were silent
data-shape bugs that would surface as you actually used the new features.

#### Bugs fixed
- **Editor page stuck on "Loading…"** — `event-site-editor.html` had a
  nested IIFE inside a template-literal expression (`(function(){…})()`
  inside `${esc(…)}`) that the JS parser couldn't handle in this
  context. Replaced with a named helper `suggestedDollarsCsv()` that
  reads the JSON column via the existing `parseJ()` helper. The whole
  page now loads.
- **Donation package leaked into the public "Register" grid** —
  `/api/event-sites/:slug` filtered out `sponsorship` but not the
  auto-created `donation` package, so visitors saw a $0/0-player tile
  in the Register section. Filter is now `=== 'registration'` (positive
  match) instead of `!== 'sponsorship'` (negative).
- **Donor messages became phantom players** — the v3.43 donations
  endpoint stuffed the donor's optional message into `players_json`
  as a synthetic `{name: '(donor message)'}` entry. With sponsorship
  + donation queries not filtering by `package_kind`, that name showed
  up in the scoring leaderboard and in the pairings unassigned-player
  pool. Fix: store the message in the existing `description` column
  instead (where the registrations dashboard already renders it), and
  defensively add `AND COALESCE(p.package_kind, 'registration') = 'registration'`
  to the pairings player-pool query, the scoring materializer, and
  both sync-scoring lookups.
- **Clone endpoint dropped sponsor + fundraising + donation config** —
  three INSERT statements were written before those columns existed
  and never updated:
  - `events` INSERT: now copies `fundraising_goal_cents` + `fundraising_visible`.
  - `event_sites` INSERT: now copies `donations_enabled`,
    `donation_suggested_json`, `donation_min_cents`, `donation_prompt`.
  - `registration_packages` INSERT: now copies `package_kind` +
    `sponsor_type`, and explicitly skips the auto-created `donation`
    package (the new event will lazy-create its own on the first
    donation).

#### Prevention
- **New test category: HTML inline-script syntax checks** — every
  inline `<script>` body under `public/` is parsed with `new Function()`
  on every test run. The v3.43 stuck-loading bug would have failed
  this check immediately. 22 new tests, one per inline script.

#### Tested
- **241/241 unit tests pass** (+22 inline-script syntax checks).
- Boot test: server.js loads and registers all routes cleanly (no
  console error at import).

---

## v3.43.0 — 2026-05-25
### Session 59 — Standalone cash donations (E3 phase 3)

Third and final slice of the Raise-Money phase (before the Klaviyo email
blast, which is deferred). Visitors can now give any amount on the public
event page without buying a registration package. Same Stripe Connect
plumbing — donations land directly in the organizer's account.

#### What changed
- **Schema** — four new columns on `event_sites`:
  - `donations_enabled INTEGER DEFAULT 0` — public toggle.
  - `donation_suggested_json TEXT` — JSON array of preset cents amounts
    (e.g. `[2500, 5000, 10000, 25000]`). Normalized server-side to
    sorted positive integers, capped at 8 values.
  - `donation_min_cents INTEGER DEFAULT 500` — server-enforced floor to
    stop micro-donations that lose money to card fees.
  - `donation_prompt TEXT` — optional custom copy above the picker.
- **Third package_kind: `'donation'`** — `registration_packages` now
  accepts donation rows. Manual creation works via the existing POST
  /packages, but the visitor flow auto-creates one lazily.
- **New endpoint `POST /api/donations`**:
  - Body: `{ event_id, amount_cents, buyer_name, buyer_email, buyer_phone?, message? }`.
  - Validates `donations_enabled` + amount >= `donation_min_cents`.
  - Lazy-upserts a single `donation` package per event (no upfront
    seeding needed).
  - Creates a `registrations` row with the donor-specified amount;
    same Stripe Checkout / Connect destination charge plumbing as
    `/api/registrations`. Optional `message` is stored in the
    `players_json` payload so it surfaces on the registrations dashboard.
  - Cancel URL bounces back to `/e/:slug?donate_canceled=1`.
- **Public payload (`/api/event-sites/:slug`)** now returns
  `donations: { enabled, suggested_cents, min_cents, prompt }` when the
  organizer flipped the toggle (else `{ enabled: false }`).
- **Admin event-site editor** — new "Donations" card with:
  - Accept-donations checkbox.
  - Minimum donation (USD).
  - Suggested amounts (comma-separated USD, e.g. `25, 50, 100, 250`).
  - Optional custom prompt textarea.
  - Persisted via the existing Save changes button.
- **Public event-site** — new "Give" section between Sponsorships and
  FAQ when donations are enabled:
  - Preset-amount strip (auto-fills the custom input).
  - Custom amount input with minimum + step constraints.
  - Name + email + optional message fields.
  - Submit → POST `/api/donations` → 302 to Stripe Checkout (or to
    the confirmation page in mock mode).

#### Tested
- **219/219 unit tests pass** (+11 new, +1 corrected) covering
  migrations, route registration, server-side validation
  (enabled-check, minimum-check), lazy package creation, donation
  kind acceptance, public payload gating, editor UI surface, and
  public form wiring.

#### What's next for E3
Klaviyo email blast (deferred until Klaviyo Flows in #KLAVIYO-FLOWS
are built). After that E3 is complete.

---

## v3.42.0 — 2026-05-25
### Session 58 — Fundraising goal bar + revenue dashboard (E3 phase 2)

Second slice of the Raise-Money phase. Public-facing animated goal
progress bar (organizer opts in) plus an admin-side revenue breakdown
that splits player tickets vs. sponsorships.

#### What changed
- **Schema** — two new event columns:
  - `events.fundraising_goal_cents INTEGER` — target amount in cents
  - `events.fundraising_visible INTEGER DEFAULT 0` — public toggle
  (separate so an organizer can set a goal privately first).
- **PATCH `/api/events/:id`** allowed list extended to accept both
  fundraising fields.
- **GET `/api/event-sites/:slug`** returns `fundraising: { goal_cents,
  raised_cents, percent }` only when the organizer has flipped the
  visible toggle AND set a non-zero goal. Raised = sum of paid +
  partial_refund amount_cents minus refund_amount_cents (matches what
  net-to-organizer-before-platform-fee would look like).
- **GET `/api/admin/events/:id/registrations`** returns two new payloads:
  - `revenue_by_kind` — `{ registration: {…}, sponsorship: {…} }` with
    `gross_cents`, `refunds_cents`, `count`, `net_cents` for each.
  - `fundraising` — same shape as the public version but always
    returned (admins see their progress even when hidden from the
    public).
- **Admin event-site editor** — new "Fundraising goal" card with:
  - Target amount (USD, step 100). Leave at 0 to disable.
  - "Show goal bar publicly" checkbox.
  - Persists via the existing Save changes button.
- **Public event-site** — animated goal bar fills on first paint via
  `requestAnimationFrame` + CSS transition. Headline shows the raised
  total + goal target; caption underneath shows percent + "thank you
  to every supporter" copy.
- **Registrations dashboard** — two new sections under the stat cards:
  - **Fundraising progress** card with the same animated bar (always
    visible to admins; chip notes whether the public can see it).
  - **Revenue breakdown** with two horizontal bars: 🎟️ Player tickets
    (in ink) vs. 💼 Sponsorships (in saffron). Each bar fills
    proportionally to total net revenue.

#### Tested
- **197/197 unit tests pass** (+8 new) covering migrations, allowed-list
  extension, public payload gating, admin breakdown, editor UI surface,
  public bar markup, and dashboard helpers.

---

## v3.41.0 — 2026-05-25
### Session 57 — Sponsorships (E3 phase 1)

First slice of the Raise-Money phase (E3) ships. Organizers can now sell
non-playing sponsorships (hole sponsors, cart sponsors, beverage sponsors,
etc.) through the same Stripe Connect flow that already powers player
registration. The public event site renders a separate Sponsorships
section with type-specific framing.

#### What changed
- **Schema** — two new columns on `registration_packages` (the existing
  table is reused as the unified catalog):
  - `package_kind TEXT DEFAULT 'registration'` discriminates player
    tickets from sponsorships.
  - `sponsor_type TEXT` picks from a known catalog (title, hole, cart,
    beverage, food, hole_in_one, longest_drive, closest_to_pin,
    scorecard, leaderboard, foursome, custom).
- **Server**:
  - `SPONSOR_TYPES` whitelist on the server validates the sponsor type
    on POST/PATCH; unknown values get coerced to null.
  - `POST/PATCH /api/admin/events/:id/packages` now accepts
    `package_kind` + `sponsor_type`, and the minimum `includes_players`
    relaxes from 1 to 0 for sponsorships (a "hole sponsor" doesn't get
    a player slot).
  - `GET /api/event-sites/:slug` now returns `sponsorships: [...]`
    alongside `packages: [...]` — split by `package_kind`.
- **Admin event-site editor** (`/admin/events/:id/site/edit`):
  - New "Sponsorships" card with an 11-tile quick-add catalog:
    🏆 Title · ⛳ Hole · 🏌 Cart · 🍻 Beverage · 🍴 Food · 🎯 Hole-in-One ·
    🚀 LD · 🥏 CTP · 📋 Scorecard · 📺 Leaderboard · 👥 Foursome.
  - Each tile carries a starter price and description; tap to seed a
    new sponsorship row inline.
  - "+ Add custom sponsorship" button for anything outside the catalog.
  - Tiles for already-added types render disabled to prevent dupes.
  - Renderer refactored to be ID-keyed (was index-keyed) so registration
    packages + sponsorships can coexist in a single state.packages
    array without aliasing.
- **Public event site** (`/e/:slug`):
  - When the event has sponsorships, the existing Sponsorships section
    renders them as cards with the sponsor-type emoji chip, price,
    description, and quantity-remaining when capped. "Become a sponsor →"
    button hits the same `/register?pkg=…` flow.
  - When there are no sponsorships, falls back to the original generic
    pitch text so the section doesn't disappear.
- **Registration page** (`/e/:slug/register?pkg=…`):
  - Sponsorship-aware: detects `package_kind='sponsorship'`, allows
    0-player rosters (skips the player section), swaps the page title
    to "Confirm your sponsorship", the order-summary label to
    "You're sponsoring", and the success button to "Confirm sponsorship".
  - Looks up the package by id across BOTH `packages` and
    `sponsorships` so the URL works for either kind.

#### Out of scope for this slice
- Fundraising goal bar (next slice).
- Revenue / expense dashboard (next slice).
- Cash donations as standalone items.
- Klaviyo email blast.

#### Tested
- **189/189 unit tests pass** (+11 new) covering: migrations, server
  whitelist, payload split, admin UI surface, public CTA, register
  page adaptation.

---

## v3.40.0 — 2026-05-25
### Session 56 — Clone past tournament

Closes a long-standing pain for organizers who run the same tournament
year after year: re-creating last year's event from scratch was 30+
minutes of clicking. Now it's two clicks.

#### What changed
- **New endpoint `POST /api/admin/events/:sourceId/clone`** — body:
  `{ name, starts_at, ends_at, copy_packages, copy_site }`. Copies the
  source event's *configuration* in a single transaction:
  - Contest toggles (LD / CTP / combined), scoring rules (rough + OOB
    penalties), hole distance, CTP off-green penalty.
  - Course polygons (fairway, rough, OOB, green) — the big win for
    same-venue yearly events.
  - Pin coordinates, CTP green polygon, CTP pin coords.
  - Branding (logo, accent, URL, is_charity).
  - Admin phone, venue, venue_lat/lon.
  - **Tee boxes** (LD tee positions on the course map).
  - **Optional**: `registration_packages` (name, price, includes_players,
    quantity_limit, description, sort_order, active).
  - **Optional**: `event_sites` (about, schedule, FAQ, contact, hero
    image, course info). Cloned site is **`published=0`** by default
    and slug gets a 4-char suffix so it doesn't collide with the source.
  - **Time zone**: re-resolved fresh from the copied lat/lon via
    `tz-lookup`, so the new event's tee times render in the venue's
    local zone without any manual step.
  - **Not copied**: registrations, balls, scoring rounds, pairings,
    check-ins, walk-ups, sessions. Live data stays with the source event.
- **New-event modal** — replaces the bare `JORD.prompt('Tournament name?')`
  with a real modal:
  - Name (required), Copy-from dropdown (recent 50 events), Starts /
    Ends datetime pickers.
  - Copy-from selection reveals two checkboxes: "Copy packages" and
    "Copy site content" (both default on).
  - Submits to `/clone` when a source is picked, otherwise falls back
    to the existing `POST /api/events`.

#### Tested
- **178/178 unit tests pass** (+10 new) covering: route registration,
  status reset to 'setup', tz re-resolution, tee/site/package copying,
  transaction wrapping, and editor UI surface.

---

## v3.39.1 — 2026-05-25
### Session 55 — Help bubbles across the setup screens (#HELP-BUBBLES)

Polish pass: every confusing field across the admin screens for setting
up a tournament now has an ⓘ help bubble that reveals a short explanation
on hover (or focus on touch devices). Aimed at non-technical organizers
who shouldn't have to guess what "Includes players" or "Strategy" means.

#### What changed
- **jord.css** — moved the help-icon / tooltip system out of editor.html
  and into the global stylesheet so every page can use it without
  duplicating CSS. Added keyboard focus support (`tabindex="0"` reveals
  on focus) and a mobile-friendly right-anchored layout so tooltips
  don't clip off the screen on phones.
- **event-site-editor.html** — 17 new bubbles across:
  - Basics (URL slug, Published toggle, Headline, Date & time,
    Subhead, Location, Hero image URL).
  - Section headers (About, Schedule, Course info, FAQ, Registration
    packages) — explain *where* the content appears on the public page.
  - Contact (Phone field — explains tap-to-call).
  - Package edit fields (Name, Price, Includes players, Quantity limit,
    Description) — biggest source of confusion historically.
- **event-pairings.html** — 8 new bubbles plus native `title=""` tooltips:
  - Scoring modal: Tournament format (explains scramble vs best ball
    vs stableford in plain English).
  - Auto-assign modal: Strategy, Group size, Shotgun toggle, Replace
    toggle.
  - Unassigned players header (explains the green-dot meaning).
  - Per-group Hole / Tee time / Carts inputs (via `title=""` so the
    inline editor stays visually clean).

#### Tested
- 168/168 unit tests still pass (UI-only change — no new tests).
- No new HTTP routes; no schema changes.

---

## v3.39.0 — 2026-05-25
### Session 54 — Scoring bridge (registrations → live leaderboard)

The biggest E2 piece lands: every paid registration in an enterprise event
now auto-becomes a scoring entry, and the organizer ships from "online
registration" to "live leaderboard at /tournament/:id" with a single click.

#### What changed
- **Scoring bridge endpoints** (`server.js`):
  - `GET /api/admin/events/:id/scoring` — returns the linked tournament +
    round summary if scoring has been started, or `{ tournament_id: null }`.
  - `POST /api/admin/events/:id/start-scoring` (body: `{ format }`) —
    creates a `tournaments` row with `event_id` set (the previously-unused
    placeholder column), creates a `rounds` row, and materializes every
    paid registration's `players_json` into `round_entries`. Team-card
    formats (scramble / foursomes / greensome) also build a `round_teams`
    row per registration so each paid foursome becomes one team. Idempotent
    on the tournament — re-clicking returns the existing IDs and only adds
    players that aren't already in the round.
  - `POST /api/admin/events/:id/sync-scoring` — pulls in any paid
    registrations added since `start-scoring` ran (e.g. walk-ups + Stripe
    QR after kick-off). Same format as the existing round.
- **`upsertPlayerFromReg` helper** — single dedup-by-phone path so future
  callers can reuse it. Players without a phone number (everyone after the
  buyer in a multi-player registration) get a fresh `players` row.
- **Format validation** — bridge rejects any format not in
  `scoring.SUPPORTED_FORMATS`, so the round always has a working
  scoring engine.
- **Pairings page UI**:
  - New "🏆 Start scoring" header button (only shown when at least one
    paid player exists). Opens a modal with a 6-option format picker
    (scramble_4p default — most charity events). On confirm: POSTs
    start-scoring, opens the leaderboard in a new tab, reloads.
  - When scoring is already wired: the button flips to a "📺 Leaderboard →"
    link plus a "↻ Sync" button for pulling in late registrations.

#### Why the design looks like this
- Tournaments + rounds were already wired; the gap was purely the
  registration → round_entries link. The `tournaments.event_id` column
  has existed as a placeholder since v3.x — this session is what
  finally uses it.
- Pairings stay an admin tool for cart/hole logistics. Scoring uses its
  own canonical player list keyed on registration roster. Two parallel
  systems by design — they're for different audiences (volunteers vs.
  spectators).

#### Tested
- **168/168 unit tests pass** (+13 new) covering: route registration,
  event_id wiring, payment-status filter, team-card branching, format
  validation, helper presence, UI surface tests for the modal + the
  leaderboard branch.

---

## v3.38.1 — 2026-05-25
### Session 53b — Editor header layout + event logo on poster

Two follow-ups to v3.38 driven by feedback on the live site.

#### What changed
- **Event editor header (`/admin/events/:id`)** — the header was squeezing
  the event name into a one-word column whenever the 8 action buttons
  (Site / Registrations / Check-in / Pairings / Leaderboard / Monitor /
  Export CSV / Start) had to share the row. New rules:
  - The row now `flex-wrap`s and the title column gets `flex: 1 1 280px`
    so it always has at least enough room to render the name + meta.
  - At ≤ 1300 px viewport, the buttons drop to their own full-width row
    underneath the title (so 8 buttons stay tappable instead of being
    crammed into 600 px).
- **Event logo upload** — new "Logo & branding" card in the event-site
  editor (`/admin/events/:id/site/edit`):
  - File picker (PNG / JPG / SVG / WebP, max 2.5 MB), live preview tile,
    Remove button.
  - Logo persists to `events.brand_logo` via `PATCH /api/events/:id`
    when the user clicks Save. `brand_enabled` flips to 1 implicitly
    when a logo is set.
  - Server-side guard added on `brand_logo`: must be a `data:image/…`
    URL under 2.8 MB, else the patch is rejected with 400 (prevents
    garbage / oversized blobs ever reaching the row).
- **Poster (`/admin/events/:id/pairings/poster`)** — the header is now
  a 2-column grid; when `event.brand_logo` is set, the logo renders at
  up to 2.4 in tall on the right of the header. Falls back to the
  title-only layout otherwise.

#### Tested
- 155/155 unit tests pass (no new tests — these are UI/CSS changes plus
  a small server-side validator).
- Verified no secrets in diff.

---

## v3.38.0 — 2026-05-25
### Session 53 — Timezones, cart numbers, 24×36 pairings poster

Three additions on top of the v3.37 pairings flow, all aimed at the
day-of-tournament experience: events now know their local time zone, every
pairing group can record cart numbers, and there's a print-shop-ready
24×36 in poster of the pairings sheet.

#### What changed
- **Time zones (auto-detected from venue lat/lon)**
  - New dependency `tz-lookup@^6.x` — small zero-runtime lookup of an IANA
    zone from lat/lon (~135 KB), pure JS, no service calls.
  - New `events.time_zone` column (`ALTER TABLE`, idempotent).
  - Helper `detectTimeZone(lat, lon)` on the server. Returns `null` for
    out-of-range or non-numeric coords so the column stays NULL instead
    of writing a misleading default.
  - **Auto-resolution points**:
    - `PATCH /api/events/:id` — when `venue_lat` or `venue_lon` is in the
      patch body, re-resolves the zone after the update.
    - Tournament-request acceptance — `INSERT INTO events` now writes
      `time_zone` from the request's venue coords.
  - **Display surfaces**:
    - Public event site (`/e/:slug`) — hero date and Schedule heading
      include the local abbreviation (`CDT`, `EDT`, etc.).
    - Pairings page — each group card shows a `Times shown in <ABBR>`
      hint when the group has a tee time set; print sheet appends the
      abbreviation next to tee times.
    - Event-site editor — the Date & Time field shows
      "Detected time zone: America/Chicago (CDT)" or a hint to set
      coords if not yet detected.
- **Cart numbers on pairings**
  - New `pairing_groups.cart_numbers` column (`ALTER TABLE`, idempotent).
  - Free text on purpose — events number carts differently
    ("12, 13" for two carts, "Walking" for none, "1A/1B" for paired numbering).
  - Endpoints updated: `GET /api/admin/events/:id/pairings` (SELECT),
    `POST /…/pairings/groups` (validation + INSERT),
    `PATCH /…/pairings/groups/:groupId` (UPDATE).
  - UI: new "Carts" input on each group card, alongside Hole and Tee
    time. Print sheet appends `· Cart 12, 13` to the group header.
- **24 × 36 in pairings poster**
  - New page `/admin/events/:id/pairings/poster` →
    `public/admin/event-pairings-poster.html`.
  - `@page { size: 24in 36in; margin: 0; }` — browser print-to-PDF
    keeps it in spec; no PDF library, no server-side rendering.
  - On-brand: cream `#F6F1E7` background, saffron accent rule, Playfair
    Display for titles, 96 pt event name, 72 pt hole numbers in inverted
    saffron tiles.
  - Layout: 3-column card grid. Each card has a big inverted hole tile
    on the left and group name + tee time + cart numbers + numbered
    member list on the right. Sorts by starting hole.
  - Screen preview: the 24×36 sheet is scaled down to fit the viewport
    via CSS transform so organizers can review before printing; print
    media resets the transform.
  - "Poster (24×36)" button added to the pairings page actions.

#### Tested
- **155/155 unit tests pass** (16 new): tz-lookup wiring, helper presence,
  schema migrations, cart-number endpoint plumbing, poster route + file +
  `@page` rule presence, and real tz-lookup sanity checks (Pebble Beach
  → `America/Los_Angeles`, Chicago → `America/Chicago`).
- Schema migrations are `IF NOT EXISTS` / `ALTER TABLE` wrapped in
  try/catch — idempotent against existing prod DB.

---

## v3.37.0 — 2026-05-24
### Session 52 — E2: pairings + hole assignments + auto-assign + print

Second slice of E2 ships. Organizers can now group registered players
into pairings (foursomes by default, configurable), assign starting
holes for shotgun starts or tee times for tee-time starts, and print
a clean pairings sheet for the morning meeting.

#### What changed
- **Schema** — two new tables:
  - `pairing_groups` (id, event_id, name, starting_hole, tee_time,
    sort_order, notes, created_at, created_by). UNIQUE indexed by
    event + sort_order.
  - `pairing_members` (group_id, event_id, registration_id,
    player_index, player_name, position). **UNIQUE constraint on
    (event_id, registration_id, player_index)** — a player can only
    appear in one group per event; moving them auto-unassigns from
    the previous group.
- **Endpoints** (all `requireAuth + requireAdminOrSuper + requireEventAccess`):
  - `GET /api/admin/events/:id/pairings` → groups (with members) +
    full player pool with `assigned` and `checked_in` flags + totals
    (`players_total`, `players_assigned`, `groups`).
  - `POST /…/pairings/groups` — create new group (auto-names `Group N`).
  - `PATCH /…/pairings/groups/:groupId` — update name, starting_hole
    (1-18), tee_time (free text), sort_order, notes.
  - `DELETE /…/pairings/groups/:groupId` — CASCADE removes members.
  - `POST /…/pairings/groups/:groupId/members` — assign a player. If
    they're already in another group, moves them.
  - `DELETE /…/pairings/groups/:groupId/members/:regId/:idx` — unassign.
  - `POST /…/pairings/auto-assign` — distribute unassigned players into
    groups. Strategies: `sequential` (keep registered foursomes
    together), `random` (shuffle), `alphabetical`. Options:
    `group_size` (1-8, default 4), `shotgun` (assign starting holes
    1-18 cyclically), `replace` (wipe existing groups first).
- **New page `/admin/events/:id/pairings`** —
  `event-pairings.html`. Two-column layout (sticky 320px player pool
  on the left, group grid on the right; collapses to stacked on
  mobile under 900px):
  - **Player pool** — searchable, shows a green dot for checked-in
    players, buyer name when different from player name.
  - **Tap-to-assign**: tap a player to select (saffron highlight), tap
    a group to assign. Works one-handed on mobile.
  - **Drag-and-drop**: drag a player onto a group on desktop.
  - **Inline editing**: group name, starting hole (1-18), and tee time
    are editable directly on the group card; PATCHes the API on blur.
  - **Auto-assign modal**: strategy + group size + shotgun toggle +
    replace toggle. Returns counts after assignment.
  - **Print sheet**: opens a print-friendly view sorted by starting
    hole, then sort_order. Uses CSS `@media print` to hide everything
    except the sheet.
- **New editor top-bar button**: `⛳ Pairings` alongside Check-in,
  Registrations, Site.

#### Tested
- **139/139 unit tests pass** (7 new route presence checks).
- Schema migrations idempotent (`CREATE TABLE IF NOT EXISTS`).

#### Design notes
- **Player pool excludes add-ons**: add-on charges (mulligan packs,
  late additions) don't have their own players — they're tied to
  parent registrations whose roster is already in the pool. The
  `parent_registration_id IS NULL` filter keeps the pool clean.
- **UNIQUE constraint enforces single-assignment**: moving a player
  from Group A to Group B is two SQL operations (delete from A,
  insert into B); the constraint catches dupes server-side.
- **Tee time is free text**, not a real time. Avoids time-zone math
  and lets organizers write "8:15 AM (back 9)" or whatever they
  actually use on a starter sheet.
- **Print uses CSS-only**: no popup window, no PDF library. The print
  sheet HTML lives hidden in the page and `body.printing` swaps
  visibility right before `window.print()` fires.

#### E2 remaining
- Wire scoring engine to the event (each registered player becomes a
  scoring entry on game day; lets the Clubhouse formats run against
  the actual field).
- Clone past tournament (quick "Copy from" prefill for recurring events).

---

## v3.36.0 — 2026-05-24
### Session 51 — Walk-ups: Stripe (QR/link) + reference notes

The walk-up modal now supports real Stripe card payment via QR code (no
hardware needed), and the other payment methods capture an optional
reference (check #, Venmo handle, comp reason) for the audit trail.

#### What changed
- **`POST /api/admin/events/:id/walkups`** — extended:
  - New `payment_method: 'stripe'` branch creates the walk-up as
    `pending` and opens a Stripe Checkout Session on the organizer's
    Connect account (same Connect flow as online registration). Returns
    `{ checkout_url, session_id }` so the UI can show a QR code.
    Session metadata includes `walkup: '1'` so the webhook auto-checks
    everyone in when payment lands.
  - New `reference` field (≤80 chars) for manual methods. Persists in
    the `description` field as "Walk-up (check · 1234)" or similar so
    the audit trail is complete.
- **Stripe webhook** — `checkout.session.completed` now also auto-
  checks-in every player on the walk-up roster when
  `session.metadata.walkup === '1'`. Idempotent (skips if check-ins
  already exist).
- **Walk-up modal UI** (`event-checkin.html`):
  - **New default option**: "Stripe — card / Apple Pay (QR code)" at
    the top of the dropdown.
  - **Contextual reference field** — appears for check / Venmo /
    external card / comp / other with a hint label and helper text per
    method. Cash and Stripe don't show it (cash needs no note; Stripe
    has its own receipt).
  - **Comp** automatically zeros out the amount field.
  - **Stripe submit** swaps the button copy to "Generate payment QR →"
    and shows an explainer banner before submission.
  - **Stripe success view** — replaces the form with a 240×240 QR
    image (rendered via the free api.qrserver.com endpoint), the
    payment URL with a Copy button, and a live "Waiting for payment…"
    status that polls the check-in endpoint every 3s and updates to
    "✓ Paid — players checked in" once the webhook fires.

#### Tested
- **132/132 unit tests pass** (no new endpoints; just extended the
  existing `POST /walkups`).
- Manual: code path for each method branch reviewed; Stripe walk-up
  flow exercised in sandbox previously via the registration flow that
  uses the same `createCheckoutSession` helper.

#### Notes
- QR code uses the free `api.qrserver.com` endpoint — no key needed,
  no rate limits documented. If it ever goes down, the copy-link
  fallback keeps the flow working. Easy to swap to a self-hosted lib
  later if needed.
- All other payment methods (cash, check, Venmo, comp, other) were
  already functional — they just record the method + amount and mark
  the walk-up paid. This release adds the optional reference field so
  organizers can capture context (e.g., check number) that previously
  required a separate paper note.

---

## v3.35.0 — 2026-05-24
### Session 50 — E2 (Run the day): mobile-first check-in + walk-ups

First chunk of E2 ships. Day-of registration-desk flow for marking
players as arrived, with walk-up support for people who didn't sign up
online.

#### What changed
- **Schema** — new `checkins` table keyed on `(registration_id, player_index)`.
  Snapshots `player_name` at check-in (so a later rename doesn't lose the
  link), tracks `checked_in_by` (admin id) for audit.
- **Endpoints** (all `requireAuth + requireAdminOrSuper + requireEventAccess`):
  - `GET /api/admin/events/:id/checkin` — flattens paid registrations into a
    player-centric list, joins `checkins`. Returns `{ players, totals }`
    where players = `[{ reg_id, player_index, player_name, buyer_name,
    package_name, payment_mode, checked_in_at }]` and totals =
    `{ players_total, players_checked, registrations }`. Filters out
    add-ons (parent rows only — the parent's roster already covers them).
  - `POST /api/admin/events/:id/registrations/:regId/players/:idx/checkin`
    — upsert. Records `checked_in_by`, snapshots player_name.
  - `DELETE …/checkin` — undo (organizer tapped wrong row).
  - `POST /api/admin/events/:id/walkups` — creates a paid registration
    with `payment_mode='manual'` + auto-checks-in every named player on
    the roster. Description tags the payment method (cash/card/comp/etc.)
    for the audit cell.
- **New page `/admin/events/:id/check-in`** — `event-checkin.html`.
  Designed phone-first for use at the registration table:
  - Big progress card (X of Y checked in) with animated bar
  - Search bar + filter pills (Remaining / Checked in / All)
  - Each player is a fat tap-target row (44px+); tapping toggles their
    check-in state. **Optimistic update** so the UI feels instant —
    syncs with server, rolls back on error.
  - Walk-up FAB at bottom-right opens a bottom-sheet modal (mobile)
    or centered modal (desktop) with package picker, buyer info, player
    roster sized to package, and payment method dropdown.
  - Sticky bottom inset respects iOS safe area.
  - Walk-ups show with a "Walk-up" pill so they're visually distinct.
- **New top-bar button in event editor**: `✓ Check-in` next to Site +
  Registrations.

#### Tested
- **132/132 unit tests pass** (4 new route presence checks).
- Manual: built schema migrates idempotently on existing DB. End-to-end:
  paid registration's players show in the list, tap toggles check-in,
  walk-up creates a manual registration + auto-checks-in everyone.

#### Why this design
- **Player-centric, not registration-centric**: a foursome registration
  is 4 separate check-ins. Buyers may or may not be playing themselves.
  Staff at the desk thinks in terms of "is Steve here yet?" not "did
  Steve's registration arrive?"
- **Optimistic UI**: at a busy registration desk on tournament morning,
  even 300ms of network delay feels broken. Local state updates first,
  server syncs in the background.
- **Walk-ups become regular registrations**: shows up in the dashboard
  + revenue totals + CSV export. Payment method captured in
  `description` so the audit trail is consistent without inventing
  another column.

---

## v3.34.0 — 2026-05-24
### Session 49 — Refunds + add-on charges on registrations

Organizers can now issue refunds (full or partial, with reason) and charge
additional amounts after registration (mulligan pack, late add-on player,
etc.) directly from the registrations dashboard. Real Stripe Connect
flows for both — application fees come back on refunds, add-ons go to
the organizer's Connect account with the same 3% platform fee.

#### What changed
- **Schema** — six new columns on `registrations`: `refund_amount_cents`,
  `refund_reason`, `refunded_at`, `refunded_by_admin_id`,
  `parent_registration_id`, `description`. All idempotent ALTER TABLE.
- **`POST /api/admin/events/:id/registrations/:regId/refund`** — full
  or partial refund with optional reason. Uses Stripe's `refunds.create`
  on the platform with `refund_application_fee: true` (gets JORD's 3%
  back) and `reverse_transfer: true` (pulls the refund from the
  connected account). Status transitions: `paid → partial_refund → refunded`.
- **`POST /api/admin/events/:id/registrations/:regId/addon`** — creates
  a new `registrations` row with `parent_registration_id` pointing at
  the original, then a Stripe Checkout Session on the organizer's
  Connect account. Optionally fires a Klaviyo `jord_addon_charge`
  metric with the payment link so the buyer gets an email. Organizer
  also gets the link to copy/share manually.
- **Updated `GET /api/admin/events/:id/registrations`** — now returns
  `refund_amount_cents`, `refund_reason`, `refunded_at`,
  `parent_registration_id`, `description`. Totals include
  `refunds_cents`.
- **Updated dashboard UI** (`event-registrations.html`):
  - Refund modal: amount field (defaults to remaining), reason
    textarea, partial refunds allowed via repeat clicks.
  - Add-on modal: description + amount + "email buyer" checkbox.
    Success state shows the payment link with a copy button.
  - Add-on rows render nested under their parent with a `↳` prefix and
    accent-color tinted background.
  - New "Refunded" stat card (only shows when there's been a refund)
    and "Net to you" now subtracts refunds.
  - Status pill supports `partial_refund` (saffron) + `refunded` (red).
  - New "Refunded" filter on the toolbar.
- **Klaviyo metric `jord_addon_charge`** — fires when an add-on charge
  email is requested. Properties: `event_id`, `EmailSubject`,
  `EmailBodyHtml` (pre-built), `amount`, `description`, `link`. Needs
  a Klaviyo Flow to actually deliver — until then it logs the metric
  and the HTML is in the email body for the flow to pass through with
  `{{ event.EmailBodyHtml|safe }}`.

#### Tested
- **128/128 unit tests pass** (2 new route presence checks).
- Manual: full + partial refund flows tested with mock-mode
  registrations from the prior session. Add-on creates the linked row,
  status pill renders correctly, payment-link copy button works.
- Real Stripe refund tested in sandbox: $10 → refund $5 → row shows
  `partial_refund`, refund line "↩ $5.00 refunded". Stripe Dashboard
  shows the refund with application fee returned to platform balance.

#### Known limitation
- Klaviyo Flow for `jord_addon_charge` not built yet — when add-on
  email checkbox is ticked, the event fires but no email is delivered
  until the Flow exists in Klaviyo. Tracked under `#KLAVIYO-FLOWS`.

---

## v3.33.0 — 2026-05-24
### Session 48 — E1: organizer registrations dashboard

Finishes E1. Organizers can now see every registration for an event,
buyer info + player roster, gross / fee / net revenue, search/filter,
and export to CSV.

#### What changed
- **New page `/admin/events/:id/registrations`** —
  `event-registrations.html`. Stat cards: paid registrations, players
  paid, gross revenue, JORD fee (3%), net to organizer. Searchable +
  filterable table (paid / pending / all). Click any row to expand and
  see player roster + Stripe session id + paid-at timestamp. Mobile
  responsive (collapses to essentials under 640px).
- **New endpoint `GET /api/admin/events/:id/registrations.csv`** —
  organizer-only. Streams a CSV with confirmation #, buyer info,
  package, players (joined by `; `), amounts, status, timestamps.
  Filename uses event name slug + today's date. Auth via
  `?token=…` query param (lets the `<a download>` link work without
  custom headers).
- **Extended `GET /api/admin/events/:id/registrations`** — parses
  `players_json` into an array on the server, returns
  `includes_players` on packages, and adds `paid_count` +
  `players_paid` to the totals payload. UI no longer has to compute
  derived numbers itself.
- **New buttons in event editor top bar** — added `✎ Site` and
  `📋 Registrations` links so organizers can jump between event setup,
  the public site editor, and the registrations dashboard from one
  place. Wired in [editor.html:1812-1813](public/admin/editor.html#L1812).

#### Tested
- **126/126 unit tests pass** (1 new route presence check for the CSV
  endpoint).
- Manual: rendered with the live test registration created during the
  Stripe Connect end-to-end. Buyer info, $10 amount, 3% fee, paid
  status, player roster all show correctly. Search + filter work.
  CSV exports cleanly to Excel.

---

## v3.32.0 — 2026-05-21
### Session 47 — Stripe Connect: real payments, destination charges

Mock checkout swapped for real Stripe Checkout against each organizer's
**Connect Express account**. Buyers pay on a Stripe-hosted page, money
settles to the organizer's bank, JORD takes a 3% platform fee
(`application_fee_amount`). Still on sandbox/test keys.

#### What changed
- **`stripe` SDK installed** (v22.1.1).
- **Schema** — six new columns on `admins`: `stripe_account_id`,
  `stripe_account_status` (`pending|active|restricted`),
  `stripe_charges_enabled`, `stripe_payouts_enabled`,
  `stripe_details_submitted`, `stripe_connected_at`. Idempotent
  `ALTER TABLE … catch {}` migrations.
- **`lib/stripe.js`** — thin SDK wrapper. Exports `mode` (`stripe` |
  `mock` — auto-switches on `STRIPE_SECRET_KEY` presence), `feeCents()`
  (basis-point platform fee, default 300bp / 3%),
  `createConnectAccount`, `createAccountLink`, `retrieveAccount`,
  `mapAccountStatus`, `createCheckoutSession`, `verifyWebhook`.
- **`POST /api/stripe/webhook`** — registered with `express.raw` BEFORE
  `express.json` so signatures verify. Handles:
  - `checkout.session.completed` → marks registration `paid` via
    `metadata.registration_id`.
  - `account.updated` → maps Stripe flags → admin Connect status,
    stamps `stripe_connected_at` the first time the account becomes
    active.
  Idempotent (skips if already paid).
- **Connect onboarding endpoints** (all `requireAuth`):
  - `GET  /api/admin/stripe/account` — current status + fee bps +
    publishable key.
  - `POST /api/admin/stripe/connect/onboard` — creates (or reuses)
    `acct_…` and an `accountLinks.create` URL, returns it for redirect.
  - `POST /api/admin/stripe/connect/sync` — best-effort re-fetch + persist
    on return from Stripe (the webhook is still authoritative).
- **`POST /api/registrations` rewired** — when in Stripe mode it:
  1. Verifies the event's `admin_id` has a Connect account with
     `stripe_charges_enabled=1`. Returns `503` with a friendly
     message otherwise.
  2. Inserts the registration as `pending`/`stripe`.
  3. Creates a Checkout Session with
     `payment_intent_data.application_fee_amount = feeCents(amount)` and
     `transfer_data.destination = organizer_account`. Metadata includes
     `registration_id` so the webhook can find it.
  4. Returns `{ id, checkout_url, session_id }` — the buyer is sent
     straight to Stripe.
- **`GET /api/registrations/:id`** — accepts `?session_id=…` fallback so
  the Stripe success-URL redirect works even if the buyer's browser
  loses the in-memory id.
- **`GET /api/event-sites/:slug`** now returns `registration_open` and
  `payment_mode`. False when Stripe is on but the organizer hasn't
  activated Connect — the public page swaps "Register →" buttons for a
  disabled "Coming soon" pill and shows a status note.
- **New page `/admin/stripe-connect`** — onboarding UI. Status badges
  (none/restricted/pending/active), three flag tiles, "Connect with
  Stripe" / "Finish onboarding" CTAs, "↻ Refresh status" button, link
  to the live Stripe Dashboard. Auto-runs `/sync` when Stripe redirects
  back to `?return=1` or `?refresh=1`.
- **Stripe link added to `/admin` top bar** (💳 Stripe).
- **Event-site editor** now shows a Connect banner above all sections
  when the organizer hasn't activated payments yet.
- **Register page** shows a friendly "coming soon" gate when
  `registration_open=false`, handles `?canceled=1` from Stripe's cancel
  URL, and swaps the test-mode footnote for Stripe wording in live mode.
- **Confirmation page** handles `?session_id=…` and polls for up to 15s
  if the row is still `pending` (waiting on the webhook).

#### Env
New variables (placeholders in `.env.example`):
- `STRIPE_SECRET_KEY`        — `sk_test_…` for sandbox
- `STRIPE_PUBLISHABLE_KEY`   — `pk_test_…` (returned to the admin page)
- `STRIPE_WEBHOOK_SECRET`    — `whsec_…` from the dashboard
- `STRIPE_PLATFORM_FEE_BPS`  — defaults to 300 (3.00%)

If `STRIPE_SECRET_KEY` is missing, the system silently falls back to
mock mode — useful for local dev without leaking keys.

#### Tested
- **125/125 unit tests pass** (7 new logic tests for `lib/stripe.js`
  fee math + status mapping; 4 new route presence checks).
- End-to-end Stripe flow has to be tested live (sandbox) once the keys
  are in Railway env and the dev server restarted — buyer should hit
  Checkout with the test card `4242 4242 4242 4242` and land on the
  confirmation page with status `paid`.

#### Open items
- Stripe webhook endpoint URL must be configured in the Stripe Dashboard
  (`<APP_URL>/api/stripe/webhook`) and the signing secret pasted into
  `STRIPE_WEBHOOK_SECRET`. For local dev: `stripe listen --forward-to
  localhost:3000/api/stripe/webhook`.
- Organizers (including you) need to walk through Connect onboarding at
  `/admin/stripe-connect` once before their events can accept registration.

---

## v3.31.0 — 2026-05-21
### Session 46 — E1: registration + checkout (mock payment)

End-to-end registration flow lands. Buyers can pick a package on the public
event site, fill in their info + player roster, and receive a confirmation.
Payment is in **mock mode** until Stripe is wired in (tracked as `#STRIPE-1`).

#### What Changed
- New table **`registrations`** — `id`, `event_id`, `package_id`,
  `buyer_name/email/phone`, `players_json`, `amount_cents`,
  `platform_fee_cents` (3%), `payment_status`, `payment_mode`,
  `stripe_session_id`, `created_at`, `paid_at`.
- Three new endpoints:
  - **`POST /api/registrations`** — public. Validates event + package,
    checks `quantity_limit` against paid count, computes 3% platform fee,
    creates the row, marks it `paid` in mock mode, returns
    `{ id, confirmation_url, payment_mode, status }`.
  - **`GET  /api/registrations/:id`** — public lookup for the
    confirmation page (joins event, package, site, support email).
  - **`GET  /api/admin/events/:id/registrations`** — organizer-only.
    Lists registrations + totals (count, revenue, fees) for the upcoming
    dashboard.
- New public pages:
  - **`/e/:slug/register?pkg=:pkgId`** — `event-register.html`. Two-column
    layout: form (buyer info + player roster sized by `includes_players`)
    on the left, sticky order summary on the right with package price +
    3% service fee + total. "Test mode" badge so the buyer knows.
    Mobile-first: collapses to single column under 760px.
  - **`/e/:slug/confirmation/:regId`** — `event-confirmation.html`.
    Confirmation #, event, venue, package, status pills (paid + test-mode),
    player roster, payment breakdown, back-to-event link, support email.
- Wired the **"Register →"** buttons on the public event site
  (`event-site.html`) to navigate to the new register page (was a
  "coming soon" alert).
- Auto-switch: `PAYMENT_MODE` constant in `server.js` reads
  `STRIPE_SECRET_KEY` from env — sets to `'stripe'` if present, `'mock'`
  otherwise. Mock path returns immediate paid status; Stripe path is a
  `501` placeholder until `#STRIPE-1`.

#### Tested
- **114/114 unit tests pass** (3 new route presence checks).
- Mobile-visual run will cover the new `/e/:slug/register` page.
- Manual smoke deferred to live test (Railway) — dev server restart not
  performed locally per the CLAUDE.md workflow.

#### Next
- Organizer dashboard (registrations list + revenue at a glance).
- Stripe Checkout wire-up (`#STRIPE-1`) once the Stripe account exists.

---

## v3.30.0 — 2026-05-21
### Session 45 — E1: organizer-side event site + packages editor

Organizers can now edit their public event site and manage registration
packages without touching the DB.

#### What Changed
- New page **`/admin/events/:id/site/edit`** — full editor: URL slug + publish
  toggle, headline / subhead / date / location / hero image URL, About,
  dynamic Schedule list (time/title/note rows, add/remove), Course info,
  dynamic FAQ list (Q/A rows), Contact (name/email/phone), and a
  Registration-packages panel with add / inline-edit / delete.
- Six new admin endpoints (all `requireAuth + requireAdminOrSuper +
  requireEventAccess`):
  - `GET  /api/admin/events/:id/site`
  - `PUT  /api/admin/events/:id/site`
  - `POST /api/admin/events/:id/packages`
  - `PATCH /api/admin/events/:id/packages/:pkgId`
  - `DELETE /api/admin/events/:id/packages/:pkgId`
- Slug validated (lowercase + hyphens, ≤80 chars) and uniqueness-checked
  across events.
- "Preview public site ↗" link in the editor header once a slug is set.
- Sticky save bar with status.

#### Tested
- **111/111 unit tests pass** (6 new route presence checks).
- End-to-end smoke: login → GET site → PUT update → public `/api/event-sites`
  reflects the change → restore. Package CRUD round-trips (create / patch /
  delete) all clean.

#### Next
- Registration flow + Stripe test-mode payment.
- Organizer dashboard.

---

## v3.29.0 — 2026-05-21
### Session 44 — E1: brandable public event site at /e/:slug

The polished, professional standard event-site template — covers every section
a charity tournament needs.

#### What Changed
- New tables `event_sites` (slug + content) and `registration_packages` (the
  ticket types organizers sell).
- New endpoint `GET /api/event-sites/:slug` — returns site + event branding +
  packages + parsed schedule + parsed FAQ.
- New page **`/e/:slug`** — full template: branded topbar, photo hero with
  date/location pills, About, Schedule timeline, Course, **Register** package
  grid, Sponsorship pitch, FAQ accordion (native `<details>`), Contact card,
  "Powered by JORD Golf" footer. Hero falls back to a lifestyle photo when no
  `hero_image` is set. The organizer's `brand_accent` (if any) is applied via
  a CSS variable swap at render time.
- `scripts/seed-event-site.js` — idempotent demo seeder. Run
  `node scripts/seed-event-site.js` → demo lives at
  `http://localhost:3000/e/fairway-fund-classic-2026`.
- `#OAUTH-1` added to `TODO.md` — Google + Microsoft sign-in deferred until
  OAuth Client IDs are provisioned.

#### Tested
- 105/105 unit tests pass.
- API round-trip: 4 packages, 4 schedule items, 5 FAQs serialized correctly.
- **Mobile-visual: `/e/:slug` clean on iPhone 14 (390px) + Pixel 7 (412px) —
  0 layout issues** alongside the existing 16 pages.

#### Next
- Organizer-side UI to edit the event site + packages.
- Then registration + Stripe test-mode payment + organizer dashboard.

---

## v3.28.0 — 2026-05-21
### Session 43 — E1 cont.: handicap on signup + scorecard stroke-allocation

#### What Changed
- **Signup gets an optional Handicap Index** field — self-reported for now,
  validated −10 to 54. `users.handicap_index` (REAL) + `users.ghin_id` (TEXT)
  columns reserved for future USGA / GHIN sync.
- **Scorecard now shows stroke-allocation dots** — for each player on the
  current hole, a saffron `●` (or `●●` for 2 strokes) appears under their name
  with `+N stroke(s)` text. Math mirrors `lib/handicap.js` (WHS: 1 stroke per
  hole at SI 1…N; extra strokes on the hardest holes for N > 18).
- Stroke allocation is what every handicapped scorecard marks — confirmed
  against the [USGA Stroke Index Allocation rules](https://www.usga.org/content/usga/home-page/handicapping/roh/Content/rules/Appendix%20E%20Stroke%20Index%20Allocation.htm).
- `GET /api/users/me` now returns `handicap_index` and `ghin_id`.

#### Tested
- **105/105 unit tests pass.**
- Smoke: signup with `handicap_index: 14.3` → saved + readable via `/me`;
  blank handicap → null (allowing scratch=0 to be saved is correct).
- **Mobile-visual: `/login` clean on iPhone 14 + Pixel 7 — 0 layout issues**
  with the new handicap field added.

---

## v3.27.0 — 2026-05-17
### Session 42 — E1 cont.: user sign-up / log-in page

#### What Changed
- New page `/login` — combined Sign-in / Create-account on a single mobile-first
  form, JORD-styled, tab toggle, inline errors, "already signed in" redirect.
- `JORD.api` automatically sends `x-user-token` alongside `x-admin-token` so
  both auth contexts work side-by-side.
- `JORD.getUserToken / setUserToken / clearUserToken` helpers in `jord.js`.
- `/login` added to the mobile-visual layout suite.

#### Tested
- **105/105 unit tests pass.**
- API edge cases: duplicate email → 409, password < 8 → 400, wrong password → 401.
- **Mobile-visual: `/login` clean on iPhone 14 (390px) and Pixel 7 (412px) —
  0 layout issues**, no horizontal scroll, no off-viewport elements.

---

## v3.26.0 — 2026-05-17
### Session 41 — Enterprise Tournament Platform: spec + E1 accounts foundation

The enterprise charity-tournament product is now scoped end-to-end and the
first foundational piece (user accounts) is in. See `ENTERPRISE-PLATFORM-SPEC.md`.

#### What Changed

##### Spec
- New `ENTERPRISE-PLATFORM-SPEC.md` — competitive map vs. EventCaddy, the
  architecture (existing `events` table as the unifying container), the free +
  transaction-fee business model, and the **E1–E5 phased plan**.
- Captures the full vision: brandable event sites · paid registration ·
  check-in · sponsors (standard catalog + custom) · cash donations · silent
  auction with donor-submitted items · event store · supplies marketplace
  (JORD Shopify + partner gear + custom quotes) — *beyond EventCaddy, a JORD
  edge.*

##### E1 foundation — public user accounts
- New `users` + `user_sessions` tables. **Separate** from the existing `admins`
  system (which stays for organizers + JORD staff). `players.account_id` links
  a Clubhouse player to a user.
- `createUserSession` / `getSessionUser` / `requireUser` middleware. Token in
  `x-user-token` header. 30-day expiry, scrypt password hashing.
- Endpoints: `POST /api/users/signup`, `POST /api/users/login`,
  `POST /api/users/logout`, `GET /api/users/me`.

##### Tests
- 105/105 pass (4 new route checks). Smoke-tested signup → login → /me → 401
  without a token.

##### Still ahead in E1
- User signup/login pages.
- Brandable public event site at `/e/:slug` (polished standard template).
- Registration packages + Stripe test-mode payment flow.
- Organizer dashboard.

---

## v3.25.0 — 2026-05-17
### Session 40 — URL cleanup + in-app routing

#### What Changed

##### Meaningful URLs
- The games hub moved `/tournaments` → **`/play`**.
- Score entry moved `/play/:roundId` → **`/scorecard/:roundId`** (clearer, and
  no longer clashes with the hub).
- `/live/:roundId` and `/tournament/:id` unchanged.

##### In-app routing — back/forward work
- The `/play` hub now drives its views from the URL hash, so every screen is
  addressable and the browser back/forward buttons work:
  `#new/type` → `#new/course` → `#new/setup` → `#new/players` for the wizard,
  `#game/:id` for a game's detail, and the bare hub for the games list.
- Admin panel's "Live Leaderboards" link updated to `/play`.

---

## v3.24.0 — 2026-05-17
### Session 39 — Wizard polish + the last 3 formats — all 20 formats playable

#### What Changed

##### Front-end polish (`tournaments.html`)
- **Tooltips** — a tappable ⓘ info bubble on every setting (Course, holes,
  format, rounds, flights, handicap index, tee) with plain-language copy.
- **Playful UI** — bigger game-type cards with icon circles, format tiles with
  a per-engine emoji, larger holes/nav/create buttons, hover-lift animations.
- **Format picker** is now an always-visible grid of clickable blocks (no
  "Change format" button) — the chosen block glows saffron and its description
  shows below. Course selection is an autocomplete; already-imported courses
  show "✓ Imported" in search.

##### Last 3 formats — catalog complete
- **Low Scratch/Net** (`lownet` engine) — each hole's team score is the best
  gross + best net of the team.
- **Irish Rumble** (`rumble` engine) — best-ball Stableford with an escalating
  count (holes 1–6 best 1, 7–12 best 2, 13–17 best 3, 18 all).
- **Duplicate Scramble** — runs on the existing duplicate engine over a
  one-ball team card.
- All **20 formats** are now `scored` and playable end-to-end.

##### Tests
- 101/101 pass. All three new formats smoke-tested.

---

## v3.23.0 — 2026-05-17
### Session 38 — Live Leaderboard Phase 3D (part 3): Reds vs Blues — 3D complete

#### What Changed

##### Reds vs Blues
- New tournament type `reds_blues` — two teams, Ryder Cup–style singles match play.
- `round_entries` gains `side` (red/blue) and `match_no` — Red #1 plays Blue #1, etc.
- `rvbLeaderboard` — every match is worth a point (½ each if halved), totalled
  across rounds; reuses the match-play engine.
- Wizard: a Reds vs Blues game has a two-panel team builder (🔴 Reds / 🔵 Blues).
- `/tournament/:id` renders the Reds-vs-Blues scoreboard + match list.

##### Tests
- 99/99 pass. Reds vs Blues smoke-tested (match closeout → team point).

##### Phase 3D complete
- The live-leaderboard platform now spans: 18 game formats, the setup wizard,
  per-round live leaderboards, match play, flights, multi-round tournaments,
  and Reds vs Blues.

---

## v3.22.0 — 2026-05-17
### Session 37 — Live Leaderboard Phase 3D (part 2): Multi-round tournaments

#### What Changed

##### Multi-round
- Wizard: a "Tournament" game (individual format) can run 1–6 rounds.
- `POST /api/tournaments/:id/field` — adds a player to every round at once.
- `GET /api/tournaments/:id/leaderboard` — cumulative leaderboard summing each
  player's score across all rounds, with a per-round breakdown.
- New page `/tournament/:id` — the cumulative tournament leaderboard
  (Pos · Player · R1…Rn · Total), auto-refreshing.
- Tournament detail in `/tournaments` lists every round with its own Live and
  score-entry links, plus a Tournament-leaderboard link for multi-round events.

##### Tests
- 99/99 pass. 3-round tournament smoke-tested — per-round + cumulative totals
  verified.

##### Still ahead in 3D
- Reds vs Blues (two-team Ryder Cup match play).

---

## v3.21.0 — 2026-05-17
### Session 36 — Live Leaderboard Phase 3D (part 1): Flights

#### What Changed

##### Flights
- `lib/scoring.js` — `applyFlights`: splits a leaderboard into 1–5 handicap
  flights (Flight 1 = lowest handicaps), renumbering positions within each.
- Server applies flights to a round's leaderboard when the tournament has
  flights enabled.
- Wizard: a "Tournament" game offers a flights toggle + 2–5 flight count.
- `/live` renders flighted leaderboards with per-flight sections.

##### Tests
- 2 new tests. 97/97 pass. Flighted tournament smoke-tested.

##### Still ahead in 3D
- Multi-round tournaments (cumulative leaderboard) and Reds vs Blues.

---

## v3.20.0 — 2026-05-17
### Session 35 — Live Leaderboard Phase 3C (part 2): Match Play

Match play is now playable — individual and the pair formats.

#### What Changed

##### Scoring engine — `lib/scoring.js`
- **`scoreMatch`** — hole-by-hole: the lower net wins the hole; the match
  standing is holes-up; closes out early ("3&2" = 3 up, 2 to play), reports
  dormie and all-square (AS).
- **`buildMatchPlay`** — two sides head to head. Each side is one entry
  (individual / one-ball team card) or, for Match Play Better Ball, a team
  whose hole score is the members' best ball. Leaderboard `scoreType: 'match'`.

##### Server
- One-ball detection generalised: scramble, foursomes and greensome all share
  a single team card (was scramble-only). Match-play rounds gather two sides.

##### UI
- `/live` renders a **match card** for match-play rounds — the two sides with
  the live standing ("2 UP", "DORMIE", "3&2", "AS").
- 5 match-play formats now selectable: Individual, Better Ball, Foursomes,
  Greensome, Scramble.

##### Tests
- 5 new tests (match closeout, all-square, match leaderboard). 95/95 pass.
- Match Play Individual + Foursomes smoke-tested end-to-end.

##### Still ahead
- 3C tail: Low Scratch/Net, team exotics (Irish Rumble, Duplicate Scramble),
  LD/CTP contests. Then 3D: multi-round, flights, Reds vs Blues.

---

## v3.19.0 — 2026-05-17
### Session 34 — Live Leaderboard Phase 3C (part 1): Skins, Erado, Duplicate

The individual exotic formats are now playable.

#### What Changed

##### Scoring engine — `lib/scoring.js`
- **Skins** — the outright-low net score wins the hole; tied holes carry the
  pot to the next hole. Ranked by skins won.
- **Erado** — stroke play with the worst N holes erased (4 of 18, 2 of 9; the
  final hole can't be erased).
- **Duplicate** — individual Stableford with a frozen random 1×/2×/3× per-hole
  multiplier; the last hole is always 2×.
- New `rankBoard` helper; leaderboard `scoreType` gains `skins`.

##### Server
- `rounds.hole_multipliers` — Duplicate's multiplier array, generated once at
  round creation and frozen for the round.
- Leaderboard / SSE pass the round's scoring options (format + multipliers).

##### UI
- `/live` renders the Skins column ("N skins"); leaderboard labels adapt to
  the format (Total / Points / Skins).
- These three formats are now selectable in the wizard's format picker.

##### Still ahead in 3C
- Match Play (+ Foursomes / Greensome), Low Scratch/Net, the team exotics
  (Irish Rumble, Duplicate Scramble), and LD/CTP contests on rounds.

##### Tests
- 4 new tests (Skins, Erado, Duplicate). 91/91 pass. All three smoke-tested
  end-to-end.

---

## v3.18.0 — 2026-05-17
### Session 33 — Live Leaderboard Phase 3B: team formats

Scramble and best-ball/better-ball are now playable end-to-end.

#### What Changed

##### Selector highlight fix
- Front 9 / Back 9 buttons now highlight when selected (`.btn-ghost` was
  overriding `.btn-primary` on CSS order — they now swap). The format picker
  stays open with the chosen card highlighted instead of collapsing.

##### Team scoring
- `lib/scoring.js` — best-ball engine: aggregates a team by taking the best
  ball per hole (lowest net for stroke, highest points for Stableford).
- `lib/handicap.js` — `teamHandicap` for scramble (35/15 and 25/20/15/10),
  foursomes (50%) and greensome (60/40).
- New tables: `round_teams`; `round_entries` gains `team_id` + `is_team_card`.

##### Server
- `POST /api/rounds/:roundId/teams` — creates a team with its players,
  computes handicaps (one team handicap for scramble; per-player playing
  handicaps for best ball).
- `gatherRoundEntries` / score-entry payload are format-aware: scramble →
  one shared team card; best ball → one card per player; individual → players.
- Individual entries now apply the format's WHS allowance (e.g. net 95%).

##### Wizard
- Pair/Team formats are selectable; picking one swaps the Players step for a
  **team-setup step** — add teams, add players to each, assign tees.
- 6 team formats now playable: 2-/Multi-person Scramble, Better Ball
  (stroke/Stableford), Best Ball (stroke/Stableford).

##### Scope note
- Foursomes, Greensome and Low Scratch/Net move to Phase 3C — Foursomes and
  Greensome are match-play formats (need the match-play engine); Low Scratch/Net
  needs its own gross+net aggregation.

##### Tests
- 4 new tests (best-ball, team route). 87/87 pass. Scramble + best-ball
  smoke-tested end-to-end.

---

## v3.17.0 — 2026-05-16
### Session 32 — Live Leaderboard Phase 3A: setup wizard + format catalog

Reshaped from a 30-screenshot study of Golf Gamebook. `/tournaments` is now a
guided wizard; the scoring engine is format-driven. See `LEADERBOARD-SPEC.md §15`.

#### What Changed

##### Format catalog — `lib/formats.js`
- 20-format catalog across three tiers (Individual / Pair / Team). Each format
  declares its scoring engine, net/gross, WHS handicap allowance, team size,
  description, and a `scored` flag (live vs. coming soon).

##### Scoring engine — `lib/scoring.js`
- `buildLeaderboard` is now format-driven. Added **Stableford** (points per hole
  vs net par — ranked high-wins) alongside stroke play. Scramble reuses the
  stroke engine (a scramble entry is a team card). Result carries a `scoreType`
  (`topar` | `points`) so clients render the right column.

##### Handicap engine — `lib/handicap.js`
- `teamHandicap` for pair/team formats: 2-person scramble 35/15, 3–5 person
  scramble 25/20/15/10/5, foursomes 50% combined, greensome 60/40.

##### Server
- `GET /api/formats` — the catalog, grouped by tier.
- `POST /api/tournaments` accepts `type` (`casual` | `tournament`) and a round
  `holes_segment` (`all` | `front9` | `back9`).
- SSE / leaderboard payloads now score for the round's own format
  (`{ round, leaderboard }`) rather than a hardcoded gross/net pair.

##### `/tournaments` rebuilt as a setup wizard
- Step 1 game type (Normal Game / Tournament; Reds vs Blues coming soon) →
  Step 2 course + holes (Full 18 / Front 9 / Back 9) → Step 3 game setup with
  the tiered format picker → Step 4 players → create & start.
- `/live` and `/play` updated: leaderboard renders to-par or Stableford points;
  the score-entry card respects the round's hole segment.

##### Scope note
- Phase 3A makes **individual** formats fully playable end-to-end (Stroke Play
  gross/net, Stableford). The **scramble** scoring + team-handicap engine is
  built and unit-tested; team-based play (scramble, best ball, …) wires up in
  Phase 3B, which builds the shared team-setup once.

##### Tests
- 11 new tests (format catalog, team handicaps, Stableford). 83/83 pass.
- End-to-end smoke test verified a Stableford Front-9 casual game.

---

## v3.16.0 — 2026-05-16
### Session 31 — Live Leaderboard Phase 1: full-round stroke-play scoring

First phase of the Golf Genius / Gamebook-class tournament scoring system.
Adds full 18-hole stroke-play scoring (gross + net) alongside the existing
LD/CTP contests — a separate, data-only system (no maps). See
`LEADERBOARD-SPEC.md` for the full feature spec and phased plan.

#### What Changed

##### Course data — golfcourseapi.com integration
- New `lib/golfCourseApi.js` — client for golfcourseapi.com. `searchCourses`,
  `getCourse`, and `normalizeCourse` (provider JSON → JORD's shape). Swapping to
  iGolf later only touches this one file.
- API key in `.env` as `GOLF_COURSE_API_KEY` (placeholder added to `.env.example`).
- Cache-as-you-go: imported courses are stored locally; re-importing the same
  course (matched by `external_id`) returns the cached copy instead of duplicating.
- Manual scorecard entry available for any course not in the API.

##### WHS handicaps — `lib/handicap.js`
- `courseHandicap` (Index × Slope/113 + Course Rating − Par), `playingHandicap`
  (× format allowance), `strokesPerHole` (allocates strokes by hole stroke index,
  handles plus handicaps), `netTotal`. Pure functions, unit-tested.

##### Scoring engine — `lib/scoring.js`
- `buildLeaderboard` ranks a round gross or net by score-to-par for holes
  played (standard live-leaderboard behavior). Golf-style tied positions (T1).
  Pure functions, unit-tested.

##### Database — 9 new tables
- `players`, `courses`, `course_tees`, `tee_holes`, `tournaments`, `rounds`,
  `score_groups`, `round_entries`, `scores`. Existing tables untouched.
- Note: the table was named `tee_holes` (not `course_holes`) — an orphaned
  legacy `course_holes` table already exists in the DB from an abandoned
  scorecard experiment; it is referenced by no code and was left untouched.

##### API routes (server.js)
- Courses: list / search / import / manual-create / detail / delete.
- Tournaments & rounds: create, list, detail, add rounds, round status.
- Round entries: add player (computes WHS course handicap), remove.
- Public score entry: round payload, batch score upsert, leaderboard JSON, SSE
  stream (`/api/rounds/:roundId/stream`) — pushes gross + net on every change.

##### New pages
- `/tournaments` — admin: course setup (online search + manual entry) and
  tournament/round/player management.
- `/play/:roundId` — public score entry. Group-marker style, hole-by-hole
  stepper, offline-capable (scores cached in `localStorage`, auto-sync on
  reconnect), shared via a copyable link.
- `/live/:roundId` — public live leaderboard, SSE-driven, gross/net toggle,
  TV display mode.

##### Admin panel hooks
- "🏆 Live Leaderboards" link added to the events-list header → `/tournaments`.
- LD contest setup: "🔍 Look up from course data" button beside the Hole
  distance field — searches golfcourseapi.com and fills the real tee-to-pin
  yardage for a chosen hole (more accurate OOB penalty math).

##### Tests
- 17 new unit tests for handicap + scoring logic and route presence. 72/72 pass.
- End-to-end smoke test verified the full flow (course → tournament → entries
  → scores → gross/net leaderboard).

---

## v3.15.0 — 2026-05-15
### Session 30 — Course-map setup UX: per-game settings, tooltips, recenter, full-screen

#### What Changed

##### Per-game settings containers (Settings tab)
- The Longest Drive and Closest to Pin scoring rules now live in their own
  bordered containers (`#ld-settings`, `#ctp-settings`) that show only while
  that contest is toggled on. Toggle a game off and its settings disappear.
- "Combined scoring" appears only when both games are on. A note prompts the
  admin to switch on a contest when none is selected. Driven by `syncGameSettings()`.

##### Tooltips across the setup form
- The `ℹ` help-icon pattern is now on every toggle and setting box on the
  Settings tab (game toggles, rough/OOB rules + modes, hole distance, off-green
  penalty, admin phone, starts/ends). Plain-language copy for non-technical admins.
- `.tooltip` CSS fixed — was `white-space: nowrap` (long text ran off-screen);
  now wraps at a fixed width.

##### Recenter button on all three maps
- New shared helper `JORD.fitMapToHole(map, parts)` — builds a bounding box from
  any mix of GeoJSON zone polygons and `[lon,lat]` points (tees, pin) and fits the map.
- 🎯 Recenter button added to the admin course map, the live leaderboard map,
  and the rep monitor map. Snaps the view back around the mapped hole.

##### Full-screen course map
- ⛶ Full screen button on the course-map toolbar. CSS-overlay (z-index 80 — above
  the topbar, below modals so confirm dialogs still surface).
- Layout: toolbar across the top, a tall map filling the screen, and the zone/tee/pin
  settings in a 360px scrollable side panel. Stacks vertically on phones (<720px).
- Leaving the Course map tab exits full-screen automatically.

---

## v3.14.0 — 2026-05-15
### Session 29 — Charity event branding (logo + color mesh)

#### What Changed

##### Signup form ([public/signup.html](public/signup.html))
- New "Charity & branding" section: an **Is this a charity event?** Yes/No toggle, a
  **Charity / event website** URL field, and an optional **logo upload** (read client-side
  to a base64 data URL, 2 MB cap, with preview + remove).
- `POST /api/tournament-signup` accepts `is_charity`, `charity_url`, `logo_data` and stores
  them on `tournament_requests` (validated: URL must be http(s), logo must be an image data URL).

##### Branding extraction (`server.js`)
- `POST /api/admin/tournament-requests/:id/fetch-branding` — best-effort scrape of the org's
  website: pulls logo candidates (apple-touch-icon, favicon, `og:image`, logo-named `<img>`s,
  downloaded server-side → data URLs to dodge CORS) and color candidates (`theme-color` meta +
  most-frequent brandable hexes from inline + linked CSS). Timeout-guarded; failures return a
  friendly error so the super admin falls back to manual upload.
- Helpers: `extractSiteBranding`, `fetchImageAsDataUrl`, `normalizeHex`, `isBrandableColor`.

##### "Mock their admin look" studio ([public/admin/editor.html](public/admin/editor.html))
- The tournament-request review modal gains a **Charity & branding** section (charity badge,
  website link, uploaded-logo preview) and a **🎨 Mock their admin look** button.
- The studio: fetch from the org site, pick a logo candidate or upload one, pick an accent
  (extracted swatches or a color picker), toggle branding on/off, and see a **live preview**
  of the meshed admin look. "Use this look" stores the choice; **Accept** applies it.
- Reject branding (toggle off) → the event uses the standard JORD look.

##### Applying branding
- New `events` columns: `is_charity`, `brand_enabled`, `brand_logo`, `brand_accent`, `brand_url`.
- The accept-request flow stores the chosen branding on the new event.
- `JORD.applyBranding({ logo, accent })` in [public/js/jord.js](public/js/jord.js) — sets the
  accent + a subtle background tint (cream meshed with the brand color) via CSS custom
  properties and swaps the topbar logo. Scopable to a subtree for the studio preview.
- Branding is applied on the **event admin editor** and the **player-facing leaderboard,
  register, and monitor** pages for branded events. `brand_logo` is excluded from SSE
  broadcasts (large base64) — pages fetch it once on load via `/info` or `/public`.
- Express JSON body limit raised to 2 MB to accommodate base64 logo uploads.

##### Dev tooling
- `scripts/test-branding.js` — end-to-end smoke test (spins up a fake charity site;
  17 checks: signup → fetch-branding → accept → branding on event + public endpoint).

---

## v3.13.0 — 2026-05-15
### Session 28 — Rep view permissions: Leaderboard, Ball Codes, Players & Teams

#### What Changed

##### New rep view permissions
- The admin who sets up a rep can now grant three additional **view permissions**,
  chosen per rep in `/admin/reps` (create + edit modals):
  - **Leaderboard** — Hidden / Can view
  - **Ball Codes** — Hidden / View only / View & edit
  - **Players & Teams** — Hidden / View only / View & edit
- Stored as three new `admins` columns (auto-migrate on startup):
  `perm_view_leaderboard` (0–1), `perm_ball_codes` (0–2), `perm_players_teams` (0–2).
  Default `0` (hidden) for new reps. Super/admin rows backfilled to full access.
- `/api/auth/login` + `/api/auth/me` now return the three new fields; `ADMIN_COLS`,
  the rep create (`POST /api/reps`) and update (`PATCH /api/reps/:id`) endpoints all
  carry them. Level values are clamped server-side (0..max).

##### Monitor page (`/monitor/:eventId`)
- New **section nav** under the event title. Buttons appear only for what the rep
  has been granted; reps with none of the new perms see no nav at all.
  - **📡 Monitor** — the existing map / standings / alerts grid.
  - **🎟 Ball Codes** — full ball-code table (code, player, team, status). With
    edit level, each assigned code gets an **Unassign** button.
  - **👥 Players & Teams** — team rosters grouped by team. With edit level, each
    player gets an **Edit** button (fix name / email / phone).
  - **📊 Leaderboard ↗** — opens the live leaderboard in a new tab.
- Ball Codes + Players & Teams panels share one fetch of `GET /api/events/:id/balls`
  and refresh on each SSE tick while visible.

##### Server endpoint gating
- New `requirePermLevel(perm, minLevel)` and `requireRosterView` middleware.
  Super/admin always pass; reps are checked against the level column.
- `GET /api/events/:eventId/balls` — now `requireRosterView` + `requireEventAccess`
  (was `requireAuth` only — also closes a cross-event read gap).
- `PATCH .../balls/:code/unassign` — now `perm_ball_codes` level 2 + event access.
- `PATCH .../balls/:code/player` — now `perm_players_teams` level 2 + event access.
- Ball-pool add/delete and team delete remain `requireAdminOrSuper` — reps still
  never manage the ball pool or delete teams.

---

## v3.12.0 — 2026-05-15
### Session 27 — Per-event admin assignment + editor login-flash fix

#### What Changed

##### Per-event admin assignment
- Events can now have **multiple admins**. `events.admin_id` stays the *creator*; a new
  join table `event_admins (event_id, admin_id, assigned_by, assigned_at)` grants
  additional admins full management access to a specific event.
- `hasEventAccess()` and `GET /api/events` updated: an `admin`-role user now sees events
  they created **or** are assigned to via `event_admins`.
- New endpoints:
  - `GET /api/events/:eventId/admins` — returns the creator + assigned admins (any admin with event access)
  - `POST /api/events/:eventId/admins` — **super only**. Body `{ admin_id }` to assign an
    existing admin, or `{ name, email }` to create a brand-new admin account (temp password)
    and assign it. Existing-email collisions reuse the account instead of duplicating.
  - `DELETE /api/events/:eventId/admins/:adminId` — **super only**. The creator can't be removed.
- **Accept-request flow** (`POST /api/admin/tournament-requests/:id/accept`) now finds-or-creates
  a tournament-admin account for the requester's email and makes the new event **theirs**
  (`events.admin_id` = requester). A new account gets a temp password; the response returns it.
- **Notifications** — new Klaviyo events + direct SMTP emails:
  - `jord_admin_welcome` — new account: login email + temporary password
  - `jord_admin_assigned` — existing admin added to an additional event
  - Builders `msgAdminWelcome` / `msgAdminAssigned`, sent via `notifyAdminAssignment()`.
- **UI** (`public/admin/editor.html`) — new super-only "👤 Admins" tab on the event editor.
  Toggle between "Existing admin" (dropdown) and "New admin" (name + email); newly created
  accounts surface their temp password with a copy button. The accept-request modal shows
  the generated credentials before opening the new event.

##### Editor login-flash fix
- `public/admin/editor.html` shipped its login gate **visible** by default; the async
  `/api/auth/me` check on load briefly displayed it before `showApp()` hid it — a login
  screen flashed when opening an event. The gate is dead markup in editor.html (`showGate()`
  always redirects to `/admin`), so it's now `hidden` by default. No more flash.

##### Dev tooling
- `scripts/seed-stress-tournament.js` / `run-stress-tournament.js` — seed + simulate a
  144-player stress-test tournament. `scripts/test-event-admins.js` — endpoint smoke test.

---

## v3.11.0 — 2026-05-12
### Session 26 — Tournament Rep role

#### What Changed

##### New `rep` role — third tier below super/admin
- Reps log in at the same `/admin` page; after auth, the client checks role and routes them to `/monitor/:eventId` for the event they're assigned to. They never see the admin events list.
- Reps are **per-event** — created in `Manage Reps`, then explicitly assigned to one or more events via a new "Reps" tab on the event editor. Reps with no assignments can't see any event.
- Reps are **read-only by default**. Four new permission toggles (column default `0`):
  - `perm_corrections` — apply corrections from the monitor
  - `perm_resolve_alerts` — clear rep alerts
  - `perm_reset_scans` — let a player rescan after a mistake
  - `perm_register_walkups` — register a missing player to an existing team
- Reps can **never** edit the course map, end/re-open the tournament, delete events, manage other accounts, or touch the ball pool — those endpoints now require `requireAdminOrSuper`.

##### Backend (`server.js`)
- New columns on `admins` (auto-migrated): `perm_resolve_alerts`, `perm_reset_scans`, `perm_register_walkups`, `parent_admin_id`. Existing super/admin rows backfilled to `1` so pre-v3.11.0 admins keep the access they already had.
- New join table `event_reps (event_id, rep_id, assigned_by, assigned_at)` with FK cascades + index on `rep_id`.
- New auth helpers:
  - `requireAdminOrSuper` — blocks reps from admin-tier endpoints
  - `requireEventAccess` + `hasEventAccess(admin, eventId)` — single source of truth for "can this user see this event?" (super → all, admin → owned, rep → assigned via `event_reps`)
- `requirePerm(perm)` now gates admins **and** reps (super still short-circuits).
- New endpoints (all auth + adminOrSuper):
  - `GET /api/reps` — admins see their own reps, super sees all; each rep returns its `assigned_events` + any pending password reset link
  - `POST /api/reps` — create rep with `parent_admin_id` auto-set from creator; returns a generated temp password if none supplied
  - `PATCH /api/reps/:id` — edit name/email/active + the four rep perms
  - `DELETE /api/reps/:id` — cascades through `event_reps` + `sessions`
  - `POST /api/reps/:id/reset-password` — 24-hour reset link
  - `GET /api/events/:eventId/reps` — list reps assigned to event
  - `POST /api/events/:eventId/reps` — assign rep
  - `DELETE /api/events/:eventId/reps/:repId` — unassign
- Hardened existing endpoints with `requireAdminOrSuper`: create/patch/delete events; end/reopen; tee box CRUD; ball pool CRUD; team delete; player edit; ball unassign.
- Hardened monitor endpoints:
  - `POST /api/admin/correct` & `/api/admin/null-ball` → `requirePerm('perm_corrections')` + `hasEventAccess`
  - `PATCH /api/events/:eventId/balls/:code/reset-scan` → `requirePerm('perm_reset_scans')` + `requireEventAccess`
  - `PATCH /api/alerts/:id/resolve` → `requirePerm('perm_resolve_alerts')` + `hasEventAccess`
- `GET /api/events` returns the rep's assigned events when `role='rep'`. `/api/auth/login` and `/api/auth/me` surface all four new perms + `parent_admin_id` + `assigned_event_ids`.

##### Frontend
- `public/admin/reps.html` (new page at `/admin/reps`) — rep list with permission chips, per-rep assigned-events display, create/edit modals with four perm checkboxes, reset-password flow. Admins see only their own reps; super sees all.
- `public/admin/editor.html` — new "🎽 Reps" tab on every event editor. Picks unassigned reps from a dropdown to add; renders assigned reps with their permission summary + an Unassign button. Reps trying to open the editor are bounced to their monitor.
- `public/admin.html` — `🎽 Manage Reps` topbar button (visible to super and admin). Post-login, reps auto-redirect to `/monitor/:eventId`.
- `public/admin/_shared/auth.js` — new `requireAuth({ adminOrSuper: true })` mode bounces reps to their monitor; topbar shows " · Rep" suffix for the rep role.
- `public/monitor.html` — silent sign-in calls `/api/auth/me` and stashes `currentUser`; new `canPerm()` helper. Hides Correct/Reset buttons per-player, hides Resolve buttons on alerts, conditionally renders the correction card (or simplifies it to a reset-only card) based on perms. Topbar shows rep's name + " · Rep" suffix when applicable.

##### Tests
- `tests/regression-tests.js` +12 tests covering `hasEventAccess` / `repIsManageable` / `canPerm` across super/admin-A/admin-B/rep1/rep2 combinations. 87/87 passing.

#### Why
Tournament reps are the bodies on the ground during a tournament — running carts, helping players whose scan won't go through, watching the leaderboard for issues. The founder needs to delegate that work without handing over admin keys that could end a tournament, delete an event, or repaint the course map. Per-event assignment plus opt-in permissions means the admin chooses exactly how much trust each rep gets, and a rep is locked to the one tournament they're working that day.

#### Files Changed
| File | What changed |
|------|-------------|
| `server.js` | New perm columns + event_reps table migration; `requireAdminOrSuper` + `requireEventAccess` + `hasEventAccess` helpers; rep CRUD + assignment endpoints; existing endpoints hardened; auth responses surface new perms + assignments |
| `public/admin/reps.html` | New page — rep list, create/edit/reset modals, four-perm toggle UI |
| `public/admin/editor.html` | New "Reps" tab — assign/unassign reps on the event; bounces reps to monitor |
| `public/admin/_shared/auth.js` | `adminOrSuper` auth mode; " · Rep" role label |
| `public/admin.html` | "Manage Reps" topbar button; post-login rep redirect |
| `public/monitor.html` | `currentUser` + `canPerm()`; per-button gating; correction card conditional layout |
| `tests/regression-tests.js` | +12 tests for rep access/permission helpers |

#### Database Changes (auto-migrated)
```sql
ALTER TABLE admins ADD COLUMN perm_resolve_alerts   INTEGER DEFAULT 0;
ALTER TABLE admins ADD COLUMN perm_reset_scans      INTEGER DEFAULT 0;
ALTER TABLE admins ADD COLUMN perm_register_walkups INTEGER DEFAULT 0;
ALTER TABLE admins ADD COLUMN parent_admin_id TEXT;
UPDATE admins SET perm_resolve_alerts=1, perm_reset_scans=1, perm_register_walkups=1
  WHERE role IN ('super','admin');
CREATE TABLE event_reps (
  event_id    TEXT NOT NULL,
  rep_id      TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, rep_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (rep_id)   REFERENCES admins(id)  ON DELETE CASCADE
);
CREATE INDEX idx_event_reps_rep ON event_reps(rep_id);
```

---

## v3.10.0 — 2026-05-13
### Session 23 (cont.) — Admin modular split: every view is its own URL, back button works

#### Why
Admin panel was a single-URL SPA — 5 views (events list, event editor, manage admins, global LB, requests) all toggled in/out of `admin.html` via JS. Hitting browser back from any inner view escaped straight to the landing page instead of going one step back. Tournament admins running real events need URLs they can share/bookmark and a back button that behaves predictably.

#### What Changed

##### New shared scaffold (`public/admin/_shared/auth.js`)
- `ADMIN.requireAuth({ super: true })` — token check + role check, redirects to `/admin?next=<path>` on failure so the user returns to where they were after login.
- `ADMIN.renderTopbar()` — consistent topbar (name + sign-out) across all extracted pages.

##### New standalone admin module pages
| Route | File | Purpose |
|---|---|---|
| `/admin/admins` | `public/admin/admins.html` | Manage admin accounts |
| `/admin/global` | `public/admin/global.html` | Global leaderboard management |
| `/admin/requests` | `public/admin/requests.html` | Inbound tournament requests |
| `/admin/backups` | `public/admin/backups.html` | Database backups |
| `/admin/events/:id` | `public/admin/editor.html` | Event editor (cloned from admin.html so the 2000+ lines of Mapbox/Mapbox-Draw map logic stay intact and untouched) |
| `/admin/events/:id/:tab` | `public/admin/editor.html` | Same, with specific sub-tab |

##### Updated `public/admin.html`
- Event card click navigates to `/admin/events/:id` (real URL) instead of toggling an in-page view.
- Super-admin nav buttons (Manage Admins / Global LB / Requests / Backups) navigate to the new routes.
- After login, honors `?next=<path>` so deep-link login redirects work.
- Legacy `#hash`-based URLs redirect to the new path-based routes.

##### Phase 2: editor sub-tab pushState routing
- `showPanel(name, { push: true })` — sub-tab clicks push real history entries so back/forward step through Settings/Course Map/Ball Codes/Players/Alerts/QR one at a time.
- `popstate` listener swaps panels in-place (no re-push, so back doesn't spring forward).
- Initial load & internal callers do NOT push, keeping history clean.

##### Server-side
- New page routes in `server.js`. `express.static` configured with `redirect: false` so the new `public/admin/` directory doesn't 301-redirect `/admin` → `/admin/`.

#### Critical bug found during testing
Event IDs in JORD are **strings** (e.g. `EVTD3364277`), not integers. The first version of my routing regex required digits-only (`\d+`), so `editor.html` silently failed to recognize real URLs, fell through to the events-list fallback, and the user had to click twice. Fix: regex now matches `[A-Za-z0-9_-]+`, parseInt removed across the routing logic.

#### Tests
48/48 unit + 75/75 regression pass. Manually verified in browser: single-click on event card opens editor; back/forward through sub-tabs swap panels correctly.

---

## v3.9.3 — 2026-05-13
### Session 25 — Fix delete-admin 500, edit any admin (incl. super)

#### What Changed

##### Fixed 500 on "Remove admin"
- Root cause: `DELETE FROM admins` hit a FOREIGN KEY constraint failure when the admin had any rows in `password_reset_tokens`. The handler cleared `sessions` but missed reset tokens.
- New handler clears `sessions` + `password_reset_tokens` + sets `events.admin_id = NULL` (events.admin_id has no FK constraint but stale ids leave "creator unknown" placeholders) all inside one DB transaction. Failures roll back cleanly and return a real error message instead of crashing the response.
- Also guards: super admins can't delete their own account.

##### Edit any admin (including super) + last-super guard
- "Edit" button used to be hidden on super admin rows (`a.role !== 'super'` gate in admin.html:961). Removed — every admin row now shows the Edit button so super admins can adjust each other's name, email, role, active status, and per-permission toggles.
- `PATCH /api/admins/:id` now refuses to demote-from-super or deactivate the last active super admin (prevents lockout) and refuses to deactivate your own account.

##### Live end-to-end verified
- Same test path that previously 500'd now passes: create admin → issue reset link → admin creates an event → promote to super → demote back → toggle permissions → DELETE returns 200 → event preserved with `admin_id = NULL`.

---

## v3.9.2 — 2026-05-13
### Session 24 — Admin password UX (auto-gen, self-serve change, fix reset link)

#### What Changed

##### Fixed "Reset link is invalid or has expired" on freshly issued links
- Root cause: `password_reset_tokens.expires_at` was stored as ISO 8601 (`2026-05-13T15:30:00.000Z`) but the check query compared against SQLite's `datetime('now')` which returns `2026-05-13 15:30:00`. SQLite compared the two as raw strings — fragile because the `.000Z` suffix length and the `T` vs space at position 10 produced inconsistent results, sometimes rejecting valid tokens.
- New `sqliteDatetimeFromNow(msFromNow)` helper returns `YYYY-MM-DD HH:MM:SS` to match `datetime('now')` exactly. Both forgot-password (line 968) and super-admin reset (line 1054) writes now use it.

##### Auto-generated temporary password on new admin creation
- `POST /api/admins` no longer requires `password`. If absent, server generates a friendly 12-char password (no look-alike chars: 0/O, 1/l/I excluded) and returns it as `temp_password`.
- Super-admin "New Admin Account" modal removed the password field. After submit, a confirmation modal shows the generated password with a Copy button — displayed once, the response payload doesn't include it on subsequent GETs.
- If a password IS supplied (programmatic use), it's still accepted and NOT echoed back.

##### Self-serve password change
- New `POST /api/auth/change-password` — any logged-in admin can change their own password by providing `current_password` + `new_password`. Other sessions for that admin are invalidated; the current session stays alive.
- Topbar now has a 🔐 Password button next to Sign out. Opens a modal with current/new/confirm fields.

##### Regression tests +7 (75/75)
- `sqliteDatetimeFromNow` returns correct format, future > past lexically, 1h-future > current SQLite time.
- Generated admin password is 12 chars, skips look-alikes, unique across samples.

##### End-to-end live test verified
- Full flow proven locally: super login → create admin (no password) → temp_password returned → new admin logs in → super issues reset link → reset link redeemed (used to fail) → login after reset → self-serve change password → login with self-picked password.

---

## v3.9.1 — 2026-05-12
### Session 23 (cont.) — Mobile modal cut off by iOS Safari toolbar

#### What Changed

##### Bottom-sheet modal action buttons now reachable on iOS (`public/css/jord.css`)
- Bug: on iPhone, `JORD.prompt` / `JORD.confirm` / `JORD.modal` modals open as bottom sheets. Action buttons in the footer were hidden behind Safari's bottom toolbar — user couldn't Save/Cancel without scrolling/dismissing the toolbar.
- Root cause: mobile bottom-sheet used `max-height: 88vh`. iOS `vh` does NOT shrink when Safari's chrome appears, so the modal's bottom extended past the visible viewport.
- Fix:
  - `max-height: 85dvh` (dynamic viewport height — automatically respects Safari's toolbar)
  - `.modal-footer` now `position: sticky; bottom: 0` so action buttons are always pinned to the visible bottom edge of the scroll container
  - `padding-bottom: calc(var(--s-4) + env(safe-area-inset-bottom))` so the footer also clears the iOS home-indicator safe area

##### Added `viewport-fit=cover` across all pages (12 HTML files)
- Without `viewport-fit=cover`, `env(safe-area-inset-bottom)` returns 0 on iOS and the home-indicator fix above does nothing.
- Updated in: admin, about, landing, global, signup, register, monitor, test, leaderboard, scan, dashboard, system-summary.

---

## v3.9.0 — 2026-05-12
### Session 23 — Database persistence + daily backups

#### What Changed

##### Database persistence (Railway volume) — `server.js`
- Root cause of past data wipes: every Railway deploy spins up a fresh container, and the DB file at `./data/jord.db` lived inside the container — wiped on every push.
- Fix: DB path now reads from `DB_PATH` env var (defaults to `./data/jord.db` for local dev). Railway service has a volume mounted at `/data` and `DB_PATH=/data/jord.db`.
- First-boot migration: on startup, if the volume DB doesn't exist yet but a legacy `./data/jord.db` is bundled in the image, it's copied onto the volume once. Idempotent — only runs when the target is missing.

##### Daily backup module — `scripts/backup.js`
- Uses better-sqlite3's online backup API (`db.backup()`) — safe with WAL, no lock on the live DB.
- Snapshots stored in `${DB_DIR}/backups/jord-<ISO-timestamp>.db`. Rotation keeps last 14 days; older snapshots auto-deleted.
- Scheduled via `setInterval` in-process (no extra Railway cron service needed) — fires 60s after boot, then every 24 hours.
- Optional S3/R2 upload: if `S3_BUCKET` env var is set, the same snapshot uploads to S3-compatible storage. Provider-agnostic via `S3_ENDPOINT` (Cloudflare R2 supported). Gracefully no-ops if vars are unset — local-only is the default.

##### Admin "💾 Backups" UI — `public/admin.html`
- Super-admin only. New button in the events-list topbar opens a modal showing latest backup file, count of stored snapshots, S3 status, and DB path.
- Buttons: **↻ Run backup now** (manual snapshot), **⬇ Download backup** (streams a fresh snapshot to the browser).

##### Admin API — `server.js`
- `GET  /api/admin/backup/status` — current backup status (super only)
- `POST /api/admin/backup/run` — manual snapshot trigger
- `GET  /api/admin/backup/download` — takes a fresh snapshot and streams it as a file download

##### Deps + docs
- Added `@aws-sdk/client-s3` to dependencies (used only when S3_BUCKET is set).
- `DEPLOY-BACKUPS.md` — one-page Railway dashboard walkthrough for volume creation, env vars, and the optional Cloudflare R2 setup.

---

## v3.8.2 — 2026-05-12
### Session 22 — Mobile pin tap + events-list button cut-off

#### What Changed

##### Mobile pin tap on Course Map (`public/admin.html`)
- "Click the map to place the pin" worked on desktop but not on phones. Two root causes:
  1. Mapbox Draw mode was sometimes left in `draw_polygon` / `direct_select` after a previous action, swallowing the tap before `map.on('click')` could fire.
  2. Mapbox's synthetic `click` from `touchend` requires the finger to land within ~1px of where it started — any drift treats the gesture as a drag, no click event fires.
- Fix 1: `#tool-pin` handler now calls `stopFreehand()`, `stopNodeEdit()`, and `draw.changeMode('simple_select')` before flipping the picker flag.
- Fix 2: new explicit `touchend` listener on the map canvas that, when a pin picker is active, unprojects the touch coordinates directly via `map.unproject([x, y])`. Drift-tolerant — fires even if the finger slid a few pixels.

##### Events list button row no longer cuts off "+ New event" (`public/admin.html`)
- Old `@media (max-width: 640px)` rule used `flex-wrap: nowrap; overflow-x: auto` — buttons formed a horizontal scrollable strip and "+ New event" was off-screen for super admins (who see 3 extra topbar buttons).
- New rule: `flex-wrap: wrap; align-items: stretch`. Buttons stack to multiple rows. `#btn-new-event` is forced to its own row at the top with `flex-basis: 100%; order: -1` so it's always the first thing you see.
- Verified via headless Puppeteer at iPhone 14 viewport: button right edge 378px in a 390px viewport, fully in view.

---

## v3.8.1 — 2026-05-12
### Session 21 — GPS UX fixes, public-page Sign in visibility

#### What Changed

##### GPS — actionable error messages
- New `JORD.gpsError(err)` translator (`public/js/jord.js`) maps `GeolocationPositionError` codes to specific recovery steps: code 1 → exact browser unblock instructions (Chrome address bar / Safari Settings), code 2 → OS Location Services hint, code 3 → open-area hint. Insecure-context check → "GPS requires HTTPS" when page is loaded over `http://`.
- New `JORD.gpsPermissionState()` queries `navigator.permissions` without prompting. Admin's Grab GPS Tee + Grab GPS Pin buttons precheck state — if `denied`, user sees unblock instructions instantly instead of "stand at pin → click OK → silent fail" loop.
- All 4 GPS error handlers (admin tee / admin pin / admin trace / scan) now route through the translator instead of showing raw `err.message`.

##### GPS — desktop / poor-accuracy fallback (`resolveGpsSamples`)
- Old watch loop filtered every reading with `accuracy > 25m` inline. On desktop (IP geolocation ≈ ±100m) every sample was rejected → samples empty → "Could not get a GPS fix" with no recourse.
- Watch loop now collects ALL samples. After timeout, `resolveGpsSamples()` branches:
  1. Good samples (≤25m) exist → aggregate as before.
  2. Only poor samples → confirm "GPS is poor — best was ±Xm. Use rough position anyway?" Lets desktop users place a coarse marker after acknowledging.
  3. Zero samples → specific error: "No GPS signal received. Check Location allowed, try outdoors with phone."

##### Public-page Sign in button visibility (mobile)
- `public/landing.html` `@media (max-width: 480px)` had `.nav .nav-link { display: none }` — hid "Sign in" along with "How It Works". Same bug in `public/about.html`. `public/signup.html` nav was missing Sign in entirely.
- Fix: `data-secondary` attribute marks links to hide on mobile; Sign in keeps showing on every viewport. signup.html nav now includes Sign in.

##### Regression tests +13 (68/68 total)
- `gpsError` per code + insecure-context branch.
- `gpsAggregate` empty / single / outlier-resistant weighting.
- Sample classification — good / poor / mixed / none — drives `resolveGpsSamples` branching.

#### Why
Founder hit "Could not find — try again" on Grab GPS Pin while testing locally on desktop. The 25m filter was right for phone-on-course but dead-ended desktop testing. Also caught that public marketing pages were hiding the Sign in link on phones, defeating the "scan QR → sign in to set up tournament" mobile flow.

---

## v3.8.0 — 2026-05-11
### Session 20 — Platform-wide cream editorial theme

#### What Changed

##### Design system — full cream/editorial re-skin (`public/css/jord.css`)
- `:root` CSS variable palette swapped from Rumble dark-green to the Vessel/Malbon-inspired warm-cream editorial palette that already shipped on `/landing`, `/about`, `/signup`:
  - `--bg #F5F2EB` (cream) · `--surface #FBF9F4` (paper) · `--surface-2 #ECE7DB`
  - `--ink #1A1A1A` near-black · `--ink-2 #5C5852` muted · `--ink-3 #8A8479` tertiary
  - `--primary #1A1A1A` (dark CTA, Vessel/Malbon style) · `--primary-ink #FBF9F4` (cream text on dark)
  - `--accent #B8884D` saffron · `--accent-2 #9A6E3A` (used for leader gradients, italicized highlights, focus rings)
  - `--danger #B33A3A` (deeper red, readable on cream)
- Borders: `rgba(26,26,26,0.10)` / `(0.18)` instead of lime-tinted dark borders. Shadows softened (lighter, smaller blur) for editorial feel.
- `.theme-dark` (leaderboard TV mode) repurposed as editorial near-black `#141312` with brighter saffron `#C99A5E` — still used by `/leaderboard` and `/test`.
- `.btn-primary` is now dark-on-cream (hover `#2A2A2A`); `.btn-accent` is saffron with cream text; `.btn-ghost` darker border on hover.
- `.lb-row.is-leader` gradient swapped to saffron→darker-saffron with cream text. Same applied for `.theme-dark .lb-row.is-leader`.
- Anchor links default to dark with a subtle underline; hover flips to saffron. `.brand`, `.topbar a`, `.nav a`, `.btn` opt out via existing class hooks.
- New global `.eyebrow` utility (matches the marketing pages): 11px / 0.20em letter-spacing / muted color / uppercase.
- `.hero-title em`, `.global-hero h1 em`, `.my-score-num em` etc. now render italic-saffron — matches the landing-page accent treatment.
- Modal backdrop now uses near-black tint at 0.45 with a 2px backdrop blur.
- Input focus ring switched to a 3px saffron tint.

##### Topbar component (`public/js/jord.js`)
- `JORD.renderTopbar` no longer hits the external Shopify CDN for logos. Now references local `/img/logos/logo-script-black.png` (light theme) and `logo-script-white.png` (dark theme).
- Brand markup simplified — just logo + optional subtitle eyebrow on a 1-px vertical rule. No more `JORD GOLF` wordmark next to the script logo.

##### Page-by-page polish
- `admin.html` — login gate uses local logo + eyebrow subtitle; "Forgot password?" link now saffron; `.ended-banner` saffron tint; tee-marker inline styles now `#B8884D` saffron with cream `#FBF9F4` text on both LD and CTP. Print page button is dark-on-cream.
- `monitor.html` — login gate uses local logo; tee markers, map-view toggle, team-filter buttons all switched to saffron with cream text on the active state.
- `leaderboard.html` — topbar uses local white logo with editorial JORD Golf wordmark + uppercase "Live Tournament" eyebrow; tour overlay redesigned (dark with saffron text + saffron border); `.lb-map-team-row.is-active` uses saffron bg with cream text; ball/tee markers in saffron; "live ended" badge in saffron tones; winner card border swapped from primary to accent.
- `scan.html` — local logo + eyebrow header; OTP code-box active/filled states in saffron; location-button selected state has saffron tint; flyover yardage hero, tee marker, ball marker, and shot line all in saffron — pops on satellite imagery.
- `register.html` — QR toggle and add-more hover use saffron; team-code join banner uses saffron tint.
- `dashboard.html` — "My score" hero card is now dark editorial gradient (`#1A1A1A → #2A2724`) with cream text + saffron italic `<em>`; rank-big italicized; rounded corners tightened.
- `global.html` — hero gained a cream gradient, italic "the *longest drives*" headline, local logo, saffron-accented #1 rank badge; #2 / #3 use neutral greys for an editorial podium.
- `test.html` — IP display in saffron; info boxes use saffron-tinted backgrounds. Body keeps `theme-dark` (dev tooling stays editorial dark).
- `qr.html` — full rebuild: cream background, Playfair `Scan to open` heading, eyebrow label, near-black QR border. No more standalone forest-green page.
- `system-summary.html` — print/PDF document: forest greens replaced with dark ink + saffron accents on a `#F5F2EB` cream base; tables use cream paper rows with subtle dark rules; code blocks use cream-2 background; print preserves the editorial look.
- `mapdiag.html` — dev page kept dark; heading recolored to saffron `#C99A5E`.
- `about.html`, `signup.html`, `landing.html` — already on the cream theme; minor consistency tweak: phone-frame placeholder bg `#0C2010` → `#1A1A1A`.

##### Imagery
- Every page now references local images only (`/img/logos/*`, `/img/lifestyle/*`). No external image dependencies anywhere in the platform.
- Landing/about already use lifestyle hero photos. Functional pages stay typographic (logo-only) — clean and on-brand.

#### Why
The marketing pages already shipped in the cream editorial style. The rest of the platform — admin, leaderboard, scan, monitor, register, etc. — was still on the old Rumble-inspired dark forest-green palette, so the experience felt fractured: a player would scan a QR, see a polished cream/saffron landing page, then jump to a dark-green dashboard mid-tournament. Unifying around the cream theme means every screen a player or admin lands on feels like the same brand.

#### Verification
- 55/55 regression tests pass (`node tests/regression-tests.js`)
- 14/14 mobile visual tests pass with 0 layout issues across iPhone 14 + Pixel 7 (`npm run test:mobile`) covering `/`, `/scan`, `/global`, `/qr.html`, `/about.html`, `/signup`, `/admin`

#### Files Changed
| File | What changed |
|------|-------------|
| `public/css/jord.css` | `:root` palette swap; `.theme-dark` reworked; buttons, badges, inputs, modals, leader rows, hero, table-hover, topbar, eyebrow |
| `public/js/jord.js` | `renderTopbar` uses local logos; simplified brand markup |
| `public/admin.html` | Login gate; tee marker colors; ended-banner; print button |
| `public/monitor.html` | Login gate; tee markers; toggle/filter button active colors |
| `public/leaderboard.html` | Topbar with local logo + editorial wordmark; tour overlay; map-team active row; ball/tee marker colors; winner card border |
| `public/scan.html` | Header logo+eyebrow; OTP box active/filled; loc-button selected; flyover yardage, tee, ball, shot-line in saffron |
| `public/register.html` | QR toggle saffron; add-more hover; team-code banner |
| `public/dashboard.html` | Dark editorial score hero with saffron `<em>`; rank-big italic |
| `public/global.html` | Hero gradient + italic headline; rank-1 saffron; local logo |
| `public/test.html` | IP display saffron; info-box tints |
| `public/qr.html` | Full cream rebuild |
| `public/system-summary.html` | Forest greens → ink + saffron + cream paper |
| `public/mapdiag.html` | Heading saffron |
| `public/about.html` | Phone-frame placeholder bg → near-black |

---

## v3.7.0 — 2026-05-10
### Session 19 — Inbound tournament requests management (super admin)

#### What Changed

##### Public `/signup` form upgrades
- **Course autocomplete on venue field** — same `/api/courses/search` (CSV of US golf courses) used in the admin event editor. As you type, dropdown shows up to 10 matches with city/state, hole count, course type. Selecting one fills venue + auto-fills the location field if blank + captures `venue_lat` / `venue_lon` for the future event.
- **New optional `Event URL` field** — admin can paste a link to their event page, registration site, or anything else for review. Validated to start with `http://` or `https://`.

##### Public `/signup` form now persists to DB
- `POST /api/tournament-signup` previously only emailed `SUPPORT_EMAIL` and dropped the data on the floor. Now also `INSERT INTO tournament_requests` so super admins can review later.
- Email send still happens (no behavior change for the support inbox).

##### New `tournament_requests` table
- Auto-migrated on startup. Columns: `id`, all submission fields (`tournament_name`, `event_date`, `venue`, `location`, `contest_type`, `expected_players`, `admin_name`, `admin_email`, `admin_phone`, `notes`), plus `status` (`pending` | `accepted` | `rejected` | `replied`), `created_event_id` (FK back to `events.id` once accepted), `reply_log` (JSON array of email replies sent), `created_at`, `updated_at`.

##### New super-admin section: `📥 Inbound Requests`
- Topbar button visible only when `currentAdmin.role === 'super'`. Shows a pending-count badge.
- List view: filter by status. Each card shows tournament name, status pill, venue, date, contest type, expected players, contact name + email, submission timestamp.
- Detail modal:
  - Editable fields (every column on the request).
  - Status pill + link to created event when accepted.
  - **Accept** → creates a new row in `events` mapped from the request (`contest_type` → `has_longest_drive`/`has_closest_pin`, `event_date` → `starts_at`/`ends_at`), opens the editor on the new event. Status → `accepted`, `created_event_id` linked.
  - **Reject** → status → `rejected`. Re-openable later via PATCH back to `pending`.
  - **Delete** → permanent removal.
  - **Email reply** with template starter (Welcome / More info / Pricing / Polite decline) + free-text editor, merged with request fields server-side. Sends via existing nodemailer transporter, appends to `reply_log`. If status was `pending`, flips to `replied`; preserves `accepted`/`rejected`.

##### New API routes (super admin only)
- `GET    /api/admin/tournament-requests` — list, optional `?status=` filter
- `GET    /api/admin/tournament-requests/:id` — detail with rendered email templates
- `PATCH  /api/admin/tournament-requests/:id` — edit fields, status (state-machine validated)
- `POST   /api/admin/tournament-requests/:id/accept` — creates event, links back
- `POST   /api/admin/tournament-requests/:id/email` — sends reply, logs it
- `DELETE /api/admin/tournament-requests/:id`

##### Regression tests
- `tests/regression-tests.js` +25 tests covering: status-transition state machine, request → event-draft mapper (contest_type → flag mapping, date → starts_at/ends_at, missing fields), email template rendering (welcome/more_info/pricing/reject merge correctness), edit validator (whitelisted fields, email format, integer coercion, contest_type/status enum). Now 47/47 passing.

#### Why
Public signup form already existed but submissions only went to email and were never stored. No way for the super admin to review, edit, accept, or reply from inside the platform — meant a real risk of dropped requests if the support inbox got noisy. Persistence + admin UI closes that gap and turns the form into the start of a sales pipeline.

---

## v3.6.0 — 2026-05-10
### Session 18 — Accuracy-aware zone detection, regression suite, mobile visual tests

#### What Changed

##### Accuracy-aware zone detection (`public/scan.html`)
- `autoSelectZone(lat, lon, accuracyM)` now consults GPS accuracy before locking the player's zone selection.
- Confident reading (zone edge farther from player than GPS accuracy) → same as before: pre-click + hard-lock all other location buttons.
- **Uncertain reading (edge within GPS accuracy)** → new path: yellow warning note `⚠️ Likely <Zone> (GPS ±Xm) — confirm by tapping the right one below.` All 4 location buttons stay tappable. Nothing pre-selected.
- New helpers: `haversineMeters`, `ringDistMeters`, `distToEdgeMeters`, `detectZoneWithConfidence`. Old `detectZone` kept as backwards-compat wrapper.
- Test mode now accepts `?testAcc=N` URL param to simulate any GPS accuracy from desktop.

##### Regression test suite (`tests/regression-tests.js`)
- New file. Pure-logic tests, no DOM/server. Run via `node tests/regression-tests.js`.
- 22 tests covering: QR team-code parameter parsing, tee-box filter shape-tolerance, accuracy-aware zone detection across confident/uncertain/oob paths.

##### Mobile visual test script (`tests/mobile-visual.js`)
- Puppeteer-based screenshot suite. Boots iPhone 14 + Pixel 7 viewports, walks public pages (landing/scan/global/qr/about/signup/admin-login), screenshots full-page to `tests/visual-report/`, runs deterministic overflow + clipping checks, writes `findings.json`.
- Optional `EVENT_ID=<id>` env var also tests `/register/:id`, `/leaderboard/:id`, `/monitor/:id`.
- npm script: `npm run test:mobile`. Server must be running (`npm start`) in another terminal.

##### CLAUDE.md
- New project-level instructions for Claude Code sessions: deployment & testing rules (no live URL access, doc-update gate before push, no HTTPS/ngrok detours), project stack reminders (Mapbox layer order, Klaviyo `|safe`, fonts, Node/sqlite gotcha), secrets & git hygiene.

#### Why
GPS accuracy varies heavily on player phones (±3m clear sky to ±15m near buildings). Old `detectZone` treated every reading as ground truth, hard-locking the location picker even when the GPS reading was unreliable. Two failure modes that bit before: (1) ball genuinely in rough but GPS drifted past admin's polygon → forced into OOB, (2) ball just inside fairway with poor GPS → hard-locked to fairway when actually in rough penalty zone. New path leaves the picker open whenever the reading isn't confident.

---

## v3.5.0 — 2026-05-07
### Session 17 — Dual Registration Flows, Leaderboard Search, Mobile Polish

#### What Changed

##### Dual registration flows (`/register/:eventId`)
- **Normal flow (4-player teams)**: first player enters phone + gets 4 codes by default. QR code generated and displayed for other players to scan. "Add Player 2", "Add Player 3", "Add Player 4" buttons appear. Team name entered as final step.
- **Bulk registration flow**: "Don't have all 4 players?" button opens alternate form. Allows 1–4 players with flexible code distribution (e.g., 1 player with 2 codes + 1 player with 2 codes, or 1 player with all 4). Each player: name + phone + comma-separated codes. Validates exactly 4 codes total. Submits all via `finalize-team` in one API call.
- **QR code generation**: uses `api.qrserver.com` external API. QR encodes team code for easy mobile scanning.
- **Phone/code persistence**: `localStorage` saves `jord_player_phone` + `jord_drop_code` for quick recall across sessions (avoids re-entry for subsequent players joining same team)

##### Leaderboard search & team filter
- Search bar: filters visible teams by team name or player name in real-time. Case-insensitive partial match.
- "My Team" button: detects user's team by matching localStorage `jord_player_phone` against all team player phones. Auto-selects and highlights their team. Clicking again clears filter (shows all teams).
- Filters work independently and can be combined. Respects LD/CTP hole tab selection.

##### Delete pin button (Course Map)
- Pin location box now labeled "LD Pin Location" or "CTP Pin Location" depending on active tab
- Trash icon button inside box deletes the current pin with confirmation
- Pin location displays as "GPS: [lat], [lon]" with delete button inline

##### Mobile UI polish
- Events list buttons: reduced 12px → 11px font, 8px 12px → 6px 9px padding
- Course map toolbar: reduced 12px → 10px font, 8px 10px → 5px 7px padding, gap 4px
- Event editor navigation: gradient overlay on right edge + padding buffer to signal more tabs beyond visible area (Settings, Course Map, Ball Codes, etc.)
- "All Teams" button text: white → dark (var(--primary-ink)) for visibility on lime green background
- Hole Tour animation: zoom to 19.5 at pin approach for closer green view, 17 for orbit height

---

## v3.4.0 — 2026-05-05
### Session 16 — Klaviyo Flows Live, Dethroned Email Redesign, Dashboard Flash Fix

#### What Changed

##### Klaviyo Flows — all 4 now Live
- 4 Klaviyo Flows created and set to Live: `jord_registered`, `jord_ball_scanned`, `jord_tournament_ended`, `jord_dethroned`
- Each flow: Allow re-entry, Smart Sending off, Transactional checked
- Email template uses HTML block with `{{ event.EmailBodyHtml|safe }}` (|safe required to render HTML, not escaped text)
- SMS template uses `{{ event.SmsText }}`
- Preview texts set per flow

##### Dethroned email redesigned
- `checkLeadershipChange()` in `server.js` rebuilt with full JORD dark-theme HTML email
- New layout: red "You've been dethroned! 👑" header, new #1 team card with yards, dark red sarcastic quote block, neon green leaderboard button
- Subject line personalized: `👑 You've been knocked off #1, {firstName}!`
- SMS updated to include leaderboard URL

##### Dashboard page flash fix (`public/dashboard.html`)
- Dashboard subscribes to SSE for live score updates — previously showed a full-page spinner on every SSE event
- Fixed with `loaded` flag: spinner only shown on first load; subsequent SSE-triggered refreshes update silently

---

## v3.3.0 — 2026-05-05
### Session 15 — Full Klaviyo Integration

#### What Changed
- `sendKlaviyo(type, recipient, data)` function — single recipient, fires Klaviyo Events API
- 4 message builders: `msgRegistration()`, `msgLDScan()`, `msgCTPScan()`, `msgTournamentEnded()`
- `jord_registered` fires in `finalize-team` via `setImmediate` for each player
- `jord_ball_scanned` fires in both LD and CTP scan endpoints via `setImmediate`
- `jord_dethroned` fires in `checkLeadershipChange()` when a team loses #1 spot
- `jord_tournament_ended` fires in `/api/events/:id/end` for all players
- Real Klaviyo API key + list IDs set in Railway environment variables
- `courses.csv` moved to project root to avoid Railway volume overlay hiding it

---

## v3.2.0 — 2026-05-05
### Session 15 — Railway Deployment, Rate Limiting, System Docs

#### What Changed
- Deployed to Railway — live at https://tournament.jordgolf.com
- Custom domain: tournament.jordgolf.com (GoDaddy CNAME → Railway)
- In-memory rate limiter added (no external package): login 5/15min, forgot-password 3/15min, reset-password 5/15min
- `railway.toml` created for build/deploy config
- `SYSTEM_UNDERSTANDING.md` created — living 15-section system reference
- `public/system-summary.html` created — printable system summary at `/system-summary`
- `.gitignore` updated: blocks `data/*.db*` only (not whole `data/` dir) so courses.csv deploys

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
