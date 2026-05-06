# JORD Golf — Testing Plan

Single-command full test (once built):
```
node tests/stress.js --all
```

Numbers stable — reference by number (e.g. "run #S2").
Mark status as each test is implemented: ⬜ Planned → 🔨 Building → ✅ Done

---

## Stress Tests

**#S1 — Concurrent scan submissions** ⬜
Simulate 20–50 players hitting `POST /api/scan/ld/:code` within the same 2-second window.
- What we're checking: SQLite write locking, SSE broadcast queue, no dropped submissions
- Pass condition: 0 errors, all submissions recorded, leaderboard reflects all scores
- Command: `node tests/stress.js --test S1 --players 30 --window 2000`

**#S2 — SSE connection load** ⬜
Open 50 simultaneous SSE connections to `/api/events/:id/stream`.
- What we're checking: Node connection limit, memory growth, no dropped events
- Pass condition: all 50 clients receive every broadcast within 500ms
- Command: `node tests/stress.js --test S2 --connections 50`

**#S3 — Rapid sequential scans (same event)** ⬜
One ball code scans 100 times as fast as possible.
- What we're checking: DB write path and SSE broadcast loop in isolation
- Pass condition: all writes succeed, no corruption, response times stay under 200ms
- Command: `node tests/stress.js --test S3 --count 100`

**#S4 — Registration flood** ⬜
20 teams all hit `POST /api/events/:id/finalize-team` at the same time.
- What we're checking: concurrent team creation, SSE broadcast on each, no duplicate team IDs
- Pass condition: exactly 20 teams created, no duplicates, all SSE clients notified
- Command: `node tests/stress.js --test S4 --teams 20`

**#S5 — API response time baseline** ⬜
Benchmark every endpoint's median and p95 response time under zero load, then under 20 concurrent users.
- What we're checking: no single endpoint becomes a bottleneck
- Pass condition: all endpoints p95 < 300ms at 20 concurrent
- Command: `node tests/stress.js --test S5`

---

## Security Tests

**#X1 — Admin auth bypass** ⬜
Hit every protected `/api` route with: no token, blank token, wrong token.
- What we're checking: every admin route returns 401/403, none leak data
- Pass condition: 100% of protected routes reject unauthorized requests
- Command: `node tests/stress.js --test X1`

**#X2 — Ball code enumeration** ⬜
Iterate sequential codes (000001, 000002…) to see if the API reveals which exist vs. don't.
- What we're checking: response body/status is identical for both — no oracle leaking pool contents
- Pass condition: responses for valid vs. invalid codes are indistinguishable to an outside observer
- Command: `node tests/stress.js --test X2 --count 100`

**#X3 — Score tampering / double submission** ⬜
Submit a scan for the same ball code twice. Also try submitting with fabricated GPS far outside any zone.
- What we're checking: second submission is blocked or ignored; out-of-range GPS is handled gracefully
- Pass condition: second scan returns a clear rejection; no second score recorded
- Command: `node tests/stress.js --test X3`

**#X4 — Input injection** ⬜
Submit `<script>alert(1)</script>` and `'; DROP TABLE teams; --` as player name, team name, and ball code.
- What we're checking: SQLite parameterized queries (SQL injection), HTML escaping in leaderboard/admin (XSS)
- Pass condition: no JS executes, no DB error, strings stored and rendered safely
- Command: `node tests/stress.js --test X4`

**#X5 — Admin token brute force** ⬜
Rapidly send 200 requests with random tokens to `/api/events`.
- What we're checking: whether rate limiting exists (it doesn't yet — this will expose the gap)
- Pass condition: either rate limiting kicks in after N attempts, or finding is flagged for fix
- Command: `node tests/stress.js --test X5 --attempts 200`

**#X6 — Unauthorized event access** ⬜
Try to read/modify another event by guessing event IDs (1, 2, 3…) without a valid token.
- What we're checking: player-facing routes don't expose cross-event data; admin routes require auth
- Pass condition: no cross-event data returned; admin routes all blocked
- Command: `node tests/stress.js --test X6`

**#X7 — SSE event injection** ⬜
Attempt to push data to an SSE endpoint (POST/PUT to stream URL, malformed event-stream headers).
- What we're checking: SSE is server-push only — no client path can trigger a broadcast
- Pass condition: all injection attempts return 405 or are ignored
- Command: `node tests/stress.js --test X7`

---

## Full Suite

Run everything in order — stress first, security second:
```
node tests/stress.js --all
```

Expected output format:
```
JORD Test Suite — 2026-05-03 14:32:01
======================================
#S1  Concurrent scans (30 players)   ✅ PASS  avg 47ms  p95 112ms
#S2  SSE load (50 connections)       ✅ PASS  all events delivered
#S3  Rapid sequential (100 scans)    ✅ PASS  0 errors
#S4  Registration flood (20 teams)   ✅ PASS  20 teams, 0 duplicates
#S5  API response baseline           ✅ PASS  p95 < 300ms all routes
#X1  Auth bypass                     ✅ PASS  12/12 routes rejected
#X2  Code enumeration                ✅ PASS  identical responses
#X3  Double submission               ✅ PASS  rejected, 0 duplicates
#X4  Input injection                 ✅ PASS  no XSS, no SQL error
#X5  Token brute force               ⚠️ WARN  no rate limiting (see #X5 notes)
#X6  Cross-event access              ✅ PASS  no cross-event leak
#X7  SSE injection                   ✅ PASS  all attempts rejected

11/12 passed  |  1 warning  |  0 failures
```

---

## Notes & Findings

*(Add findings here as tests run — what failed, what was fixed, what needs follow-up)*

- **#X5 Rate limiting**: No rate limiting currently exists on any endpoint. Before going live, add `express-rate-limit` to admin auth routes. Low risk for May 8th event (private URL, tournament-specific access). Flag for v2.1.0.

---

## Test Infrastructure Plan

Once implemented, `tests/stress.js` will:
- Accept `--test`, `--all`, `--event`, `--url` flags
- Default `--url` to `http://localhost:3000` (override to `https://play.jordgolf.com` for prod tests)
- Create its own test event + balls at the start, tear down at the end (no pollution of real data)
- Print results to console AND write a timestamped `tests/results/YYYY-MM-DD-HH-mm.json`

```
node tests/stress.js --all --url https://play.jordgolf.com
```
