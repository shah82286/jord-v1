# JORD Golf Tournament System — Version History

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
