# JORD Golf Tournament System — Session Handoff

Paste everything below the line into your first message when starting a new session.

---

## PROMPT — copy from here

I'm building **JORD Golf Tournament System** — a SaaS web app that started as a Longest Drive / Closest to Pin on-course contest tool and has expanded into a full **enterprise charity-tournament platform** competing with EventCaddy. It now has three layered products:

1. **Original LD/CTP contests** — Mapbox satellite course setup, players scan a QR code on their ball to GPS-submit shots, live leaderboard.
2. **Clubhouse** (`/clubhouse`) — 20-format game scoring engine for casual rounds + tournaments (stroke, scramble, match play, skins, etc.) with full WHS handicap math.
3. **Enterprise tournament platform** — brandable public event sites at `/e/:slug`, online registration with **real Stripe Connect payments**, organizer dashboard, day-of check-in, walk-ups, pairings + hole assignments. Currently sandbox; switches to live keys via #STRIPE-LIVE.

### Tech stack
- **Backend**: Node.js + Express, SQLite via `better-sqlite3`. ~5,000-line `server.js`.
- **Real-time**: Server-Sent Events for leaderboards + monitor.
- **Maps**: Mapbox GL JS (ESRI World Imagery tiles via `JORD.satelliteStyle()`).
- **Payments**: Stripe Connect Express + destination charges (3% platform fee via `application_fee_amount`). Webhook at `/api/stripe/webhook` registered with `express.raw` BEFORE `express.json`.
- **Email/SMS**: Klaviyo (all transactional email routes through it — SMTP dropped). 9 event metrics fire; some need Flows built in Klaviyo dashboard.
- **Auth**: Two separate systems — `admins` (super/admin/rep) with `x-admin-token` header, and `users` (personal player accounts) with `x-user-token` header. `JORD.api` sends both if present.
- **Styling**: cream editorial design system in `public/css/jord.css`. Playfair Display + Inter. Saffron `#B8884D` accent.
- **Deployment**: Railway at `tournament.jordgolf.com`, auto-deploys on push to `main`. Persistent SQLite volume at `/app/data`.

### How to run locally
```
cd jord-v1
npm start         # starts on localhost:3000
```
Admin panel: `http://localhost:3000/admin`
Super admin login: `shah82286@gmail.com` / `jord2026` (password = `ADMIN_PASSWORD` in `.env`).

---

## Current state — v3.47.0 (2026-05-26)

> **Snapshot context**: The entire platform spec (E1–E5) is now
> feature-complete. The last handoff (at v3.43) marked E3 done; since
> then the **scoring↔pairings bridge** (v3.44), the **full E4 silent
> auction MVP** (v3.45), and **both halves of E5 — event store +
> supplies marketplace** (v3.46–v3.47) shipped. Plus a hotfix pass
> (v3.43.1) caught four bugs from the post-deploy review.
> **319/319 unit tests passing.**

### What's shipped since v3.43 (this session arc)

- **v3.43.1** — Hotfix pass. Fixed: editor stuck on Loading (nested
  IIFE-in-template-literal syntax error), donation package leaking
  into the public Register grid, donor messages becoming phantom
  players in scoring/pairings, clone-tournament endpoint dropping
  sponsor + fundraising + donation config. Added an
  inline-script-syntax test category that runs `new Function()` over
  every `<script>` under `public/` on every CI run.
- **v3.44.0** — Pairings → score-groups bridge. New columns
  `score_groups.pairing_group_id` + `round_entries.source_registration_id`
  / `source_player_index`. `_syncPairingsToScoreGroups()` mirrors
  pairing_groups into score_groups, refreshes name/hole/tee changes,
  deletes orphans, and re-walks every round_entry to set its group_id
  from the source registration's pairing assignment. Team-card formats
  force every team member into the captain's group. Wired into both
  existing endpoints + new explicit `POST /sync-pairings-to-scoring`.
  Pairings page sync button renamed "↻ Sync to leaderboard".
- **v3.45.0** — **E4: Silent auction (full MVP)**. New tables
  `auction_items` + `auction_bids`. Lifecycle:
  `pending → live → ended → paid` (+`rejected`). Endpoints for CRUD,
  close, checkout-winner; public list + bid + intake. Three new pages:
  `/admin/events/:id/auction`, `/e/:slug/auction`, `/e/:slug/donate-item`.
  Winner checkout lazy-creates a per-item `package_kind='auction_item'`
  row and goes through Stripe Connect. Stripe webhook flips items to
  `paid` on `metadata.auction_item_id`. Photo uploads on items + intake.
  Editor card + nav button + teaser on `/e/:slug`.
- **v3.46.0** — **E5 phase 1: Event store**. New `package_kind='event_item'`
  joins the existing four. `registration_packages.image_data` for
  product photos. Editor card with 10-tile quick-add catalog (🔁
  mulligans, 🎟️ raffle bundles, 🥏 CTP, 🚀 LD, 🍻 drinks, 👕 shirts,
  🧢 hats). Public "Shop the event" section on /e/:slug. Register page
  recognizes event_item kind (0-player flow, "Check out: <item>" framing).
- **v3.47.0** — **E5 phase 2: Supplies marketplace** (JORD as seller).
  First flow on the platform that uses **direct Stripe charges** instead
  of Connect destination charges. New `lib/stripe.js` helper
  `createDirectCheckoutSession` (no `application_fee`, no
  `transfer_data`, US shipping address + phone collected at Checkout).
  Two new tables (`supply_products`, `supply_orders`). Four new admin
  pages: catalog (`/admin/shop`), order detail
  (`/admin/shop/orders/:id`), buyer order list
  (`/admin/shop/orders`), super-admin product mgmt
  (`/admin/shop/products`). Webhook captures the shipping address.
  Super-admin "Mark shipped" with optional tracking URL. 🛒 JORD Shop
  button in the main admin nav.

### What's shipped since v3.37 (carried from the prior handoff)

- **v3.38.0** — Time zones across the system (`tz-lookup`,
  `events.time_zone` auto-resolved from venue lat/lon, displayed as
  CDT/EDT/PDT abbreviations); free-text cart numbers on pairing groups;
  24×36 in print poster at `/admin/events/:id/pairings/poster`.
- **v3.38.1** — Editor header layout fix (was squeezing the title into
  one word past 8 action buttons); event logo upload in the site editor;
  logo rendered on the poster.
- **v3.39.0** — **Scoring bridge** — biggest piece. Closes the
  registrations → tournament leaderboard gap. New endpoints
  `GET/POST /api/admin/events/:id/{scoring, start-scoring, sync-scoring}`.
  Each paid registration's player roster auto-materializes into
  `round_entries` (or a `round_teams` row for scramble formats).
  "🏆 Start scoring" button on the pairings page; flips to
  "📺 Leaderboard →" + "↻ Sync" after kickoff.
- **v3.39.1** — `#HELP-BUBBLES` shipped. 25+ info tooltips across
  event-site editor + pairings page; `.help-icon` CSS now lives in
  `jord.css` for site-wide use.
- **v3.40.0** — Clone past tournament. New endpoint
  `POST /api/admin/events/:sourceId/clone` copies settings, polygons,
  packages, event-site content, and tee boxes in one transaction. New-
  event modal with a "Copy from" dropdown.
- **v3.41.0** — Sponsorships (E3 phase 1). New columns `package_kind` +
  `sponsor_type` on `registration_packages`. 11-tile quick-add catalog
  (title, hole, cart, beverage, food, hole-in-one, LD, CTP, scorecard,
  leaderboard, foursome). Public site renders a Sponsorships section
  with type emoji chips + "Become a sponsor →" CTAs.
- **v3.42.0** — Fundraising goal bar + revenue dashboard (E3 phase 2).
  `events.fundraising_goal_cents` + `_visible`. Public page renders an
  animated progress bar. Admin registrations dashboard shows
  revenue-by-kind (tickets vs sponsorships) bars and the goal-progress
  card (always visible to admins).
- **v3.43.0** — Standalone cash donations (E3 phase 3). Four new
  `event_sites` columns (`donations_enabled`, `donation_suggested_json`,
  `donation_min_cents`, `donation_prompt`). New `POST /api/donations`
  endpoint with lazy donation-package creation. Public Give section
  with preset amounts + custom input + Stripe Checkout redirect.

### What's shipped since v3.8.0 (kept from the prior handoff)

#### Clubhouse (`/clubhouse`) — game-scoring platform
- **20 game formats** in [lib/formats.js](lib/formats.js): stroke gross/net, stableford, skins, erado, duplicate, match play, scramble (2/4-person), best ball, better ball, foursomes, greensome, low gross/net, Irish rumble, duplicate scramble.
- **WHS handicap math** in [lib/handicap.js](lib/handicap.js): `courseHandicap`, `playingHandicap`, `strokesPerHole`, `teamHandicap` (scramble allowances 35/15 + 25/20/15/10, foursomes 50%, greensome 60/40), `applyAllowance`.
- **Scoring engines** in [lib/scoring.js](lib/scoring.js): `buildLeaderboard`, `scoreEntry`, `buildSkins`, `buildErado`, `buildDuplicate`, `scoreMatch`, `buildMatchPlay`, `scoreTeamBestball`, `buildLowNet`, `buildRumble`, `applyFlights`.
- **Hash-routed wizard** at [/clubhouse](public/tournaments.html) — `#new/type|course|setup|players`, `#game/:id`. Three entry points: Normal round / Tournament / Reds vs Blues. Format picker as clickable blocks with tooltips.
- **Score entry** at [/scorecard/:roundId](public/scorecard.html) with stroke-allocation dots.
- **Round leaderboard** at [/live/:roundId](public/live.html), tournament cumulative at [/tournament/:id](public/tournament-live.html).
- **External course data** via [lib/golfCourseApi.js](lib/golfCourseApi.js) (golfcourseapi.com client).

#### Enterprise platform — E1 (sell tickets)
- **User accounts** at [/login](public/login.html) — separate from admins. Endpoints: `/api/users/signup|login|logout|me`. Optional `handicap_index` + `ghin_id` at signup.
- **Brandable event site** at [/e/:slug](public/event-site.html) — hero, About, Schedule timeline, Course, Register grid, Sponsorship pitch, FAQ accordion, Contact, "Powered by JORD Golf" footer.
- **Organizer-side editor** at [/admin/events/:id/site/edit](public/admin/event-site-editor.html) — slug + publish toggle, headline/subhead/date/hero, About, dynamic Schedule + FAQ rows, Course info, Contact, Registration-packages CRUD.
- **Registration + payments**:
  - Page: [/e/:slug/register?pkg=:pkgId](public/event-register.html) — buyer info form + player roster sized by `includes_players`, sticky order summary, 3% fee shown separately.
  - Confirmation: [/e/:slug/confirmation/:regId](public/event-confirmation.html) — handles `?session_id=…` redirect from Stripe, polls if pending.
  - Endpoint `POST /api/registrations` creates Stripe Checkout Session on organizer's Connect account.
- **Stripe Connect Express** ([lib/stripe.js](lib/stripe.js)):
  - Onboarding UI at [/admin/stripe-connect](public/admin/stripe-connect.html) — status badges (none/restricted/pending/active), flag tiles, "Connect with Stripe" / "Finish onboarding" CTAs.
  - Endpoints: `GET /api/admin/stripe/account`, `POST /api/admin/stripe/connect/onboard`, `POST /api/admin/stripe/connect/sync`.
  - Webhook handles `checkout.session.completed` (marks paid, auto-checks-in walk-ups) + `account.updated` (updates Connect status).
  - Auto-falls-back to mock mode when `STRIPE_SECRET_KEY` is unset.
- **Organizer registrations dashboard** at [/admin/events/:id/registrations](public/admin/event-registrations.html) — stat cards (revenue, fees, net), searchable + filterable table, click-to-expand row showing player roster + Stripe session id, CSV export (`?token=` auth so `<a download>` works without headers).
- **Refunds + add-on charges**:
  - Refund modal: full or partial with reason. Uses `refunds.create` with `refund_application_fee:true` + `reverse_transfer:true`.
  - Add-on modal: description + amount + "email buyer" checkbox. Creates child registration with `parent_registration_id`. Add-on rows nest under parent with `↳` prefix.
  - Endpoints: `POST .../refund` and `POST .../addon`. Klaviyo `jord_addon_charge` metric fires (Flow not built yet — see TODO #KLAVIYO-FLOWS).

#### Enterprise platform — E2 (run the day) — partial
- **Mobile-first check-in** at [/admin/events/:id/check-in](public/admin/event-checkin.html):
  - Big progress card with animated bar, fat 44px tap targets, optimistic state updates.
  - Search + filter pills (Remaining / Checked in / All).
  - **Walk-up FAB** opens bottom-sheet (mobile) / centered (desktop) modal. Supports cash / check / Venmo / external card / comp / other (with optional reference field for check#/handle/comp reason) AND a real **Stripe path**: pick "Stripe — card / Apple Pay (QR code)" → submit → modal swaps to a 240×240 QR rendered via `api.qrserver.com` + copy-link. Polls every 3s and updates to "✓ Paid" when the webhook flips the walk-up. Auto-check-in fires via webhook metadata `walkup:'1'`.
  - Schema: `checkins` table keyed on `(registration_id, player_index)` with snapshotted `player_name` + audit (`checked_in_by`, `checked_in_at`).
- **Pairings + hole assignments** at [/admin/events/:id/pairings](public/admin/event-pairings.html):
  - Two-column layout (sticky 320px pool left, group grid right; collapses on mobile under 900px).
  - Tap-to-assign (mobile) + drag-and-drop (desktop). Player shows green dot for checked-in.
  - Inline edit of group name, starting hole (1-18), tee time (free text).
  - **Auto-assign modal**: sequential (keep foursomes together) / random / alphabetical. Configurable group size 1-8. Optional shotgun toggle assigns holes 1-18 cyclically.
  - **Print sheet** via `@media print` (no PDF library, no popup).
  - Schema: `pairing_groups` (id, event_id, name, starting_hole, tee_time, sort_order, notes) + `pairing_members` (UNIQUE on event+reg+player so a player is in at most one group per event).

#### Klaviyo integration (full)
- All transactional email routes through Klaviyo (SMTP dropped — Railway blocks outbound SMTP). `sendKlaviyo(type, recipient, data)` helper builds event with pre-rendered `EmailSubject` + `EmailBodyHtml`.
- 4 Flows already Live in Klaviyo dashboard (`registered`, `ball_scanned`, `tournament_ended`, `dethroned`, `team_created`).
- 6 Flows pending (see TODO #KLAVIYO-FLOWS): `jord_password_reset`, `jord_account_welcome`, `jord_admin_welcome`, `jord_admin_assigned`, `jord_tournament_signup`, `jord_addon_charge`.

#### Infrastructure
- **Railway auto-deploy from GitHub** confirmed working (#RAILWAY-AUTODEPLOY closed). Every `git push origin main` triggers a build.
- **`APP_URL` env var** MUST be set to `https://tournament.jordgolf.com` on Railway (used for Stripe Checkout success/cancel URLs).
- **Stripe** sandbox keys live in Railway env. Webhook configured at `https://tournament.jordgolf.com/api/stripe/webhook` listening for `checkout.session.completed` + `account.updated`.

### Test suite — 139/139 passing
Run: `node tests/run-tests.js`. Route presence checks + handicap/scoring/Stripe logic.
Mobile visual: `node tests/mobile-visual.js` (Puppeteer iPhone 14 + Pixel 7 viewports).

---

## What was in-flight when we stopped

Nothing — the v3.47 session ended on a clean push of the full E5 arc.
There is no pending work to resume.

---

## Roadmap status — E1 through E5

| Phase | Status | Notes |
|------|--------|-------|
| E1 — sell tickets | ✅ done | Brandable site, packages, Stripe Connect, registrations dashboard, refunds + add-ons |
| E2 — run the day | ✅ done | Check-in, walk-ups (incl. Stripe QR), pairings + poster, scoring bridge, pairings↔scoring sync |
| E3 — raise money | ✅ done | Sponsorships, fundraising goal bar, revenue dashboard, standalone donations |
| E4 — silent auction | ✅ done | Item intake (donor + admin), public bidding, close, winner Stripe Checkout, photo uploads |
| E5 — marketplaces | ✅ done | Event store (raffle tickets / mulligans / merch) + Supplies marketplace (JORD as seller) |

---

## Next priorities (post-roadmap)

### Deferred / blocked
- **Klaviyo email blast for donations + sponsors + auction** — deferred
  behind `#KLAVIYO-FLOWS` until the 6 dashboard flows are built.
- **`#STRIPE-LIVE`** — still on sandbox keys. Flipping to live needs a
  fresh `whsec_`, a re-onboarded JORD platform Connect account, and an
  end-to-end test with a real card + refund.
- **`#STRIPE-TERMINAL`** — Tap-to-Pay / BBPOS reader for in-person card
  payments at the registration desk.
- **`#OAUTH-1`** — Google + Microsoft SSO, waiting on client app
  registration in Google Cloud + Azure AD.
- **`#KLAVIYO-TRANSACTIONAL`** — Klaviyo support ticket still open on
  transactional-status approval for a JORD email.

### Smaller polish items worth picking up
- **Sponsorship logos on poster + public site** — the catalog is in
  place but we still only render names, not images. ~1 hr.
- **Reps invite flow** — `/admin/events/:id/reps` UI exists; one-click
  "Invite by email" with magic-link onboarding is the next step.
- **Multi-product cart for the supplies marketplace** — phase 1 is
  single-product-per-checkout. Cart deferred to phase 3.
- **Sponsorship logo display on event-site cards** — sponsor section
  could lead with logos instead of emoji chips when an image is uploaded.
- **International shipping for the JORD shop** — currently US-only;
  one-line change to the `allowed_countries` whitelist.

### Bigger directions (if the platform pivots)
- Mobile PWA / offline scoring for the on-course experience.
- Golfer-facing app (live leaderboard subscriptions, push notifications
  when they're outbid in the auction, etc.).
- Partner integrations: GHIN handicap verification, USGA event
  registration import, Square / Clover POS sync for in-person sales.

### Operational TODOs (in TODO.md)
See the "Deferred / blocked" subsection above for details. Pending IDs:
- **#STRIPE-LIVE** — flip from sandbox to live keys.
- **#STRIPE-TERMINAL** — in-person card payments at the registration desk.
- **#KLAVIYO-FLOWS** — 6 Flows pending in the Klaviyo dashboard.
- **#KLAVIYO-TRANSACTIONAL** — Klaviyo transactional-status approval.
- **#OAUTH-1** — Google + Microsoft SSO client IDs.
- **#HELP-BUBBLES** — ✅ Shipped in v3.39.1.

---

## How I like to work
- Targeted edits — don't rewrite files unless necessary
- Show specific changes + explain the *why* briefly
- Ask before destructive ops (deleting files, dropping tables)
- Mobile-first: any UI change should work at 375px width — test in browser before declaring done (caught two silent UI bugs in recent sessions: an escaped-apostrophe in event-register.html and an id mismatch in event-checkin.html, both would have been caught by clicking through the new page once)
- Pre-push: verify CHANGELOG.md is up to date, scan staged diff for secrets, ask if I want to review screenshots first
- NEVER commit real tokens (test keys included) — `.env` is gitignored, `.env.example` uses placeholders like `YOUR_STRIPE_SECRET_KEY_HERE`
- Stripe: Connect Express + destination charges always (never direct charges) — see [memory/project_stripe.md](C:\Users\shah8\.claude\projects\c--Users-shah8-OneDrive-Desktop-jord-v1\memory\project_stripe.md)

---

## Files map (current state)
| File / dir | Purpose |
|------|---------|
| `server.js` | All API routes, SSE, DB schema, Stripe webhook (raw-body BEFORE express.json), middleware. ~5,000 lines. |
| `lib/formats.js` | 20-format game catalog |
| `lib/handicap.js` | WHS handicap math |
| `lib/scoring.js` | Scoring engines for all 20 formats |
| `lib/stripe.js` | Stripe Connect helper (createConnectAccount, createCheckoutSession, verifyWebhook, mapAccountStatus) |
| `lib/golfCourseApi.js` | golfcourseapi.com client |
| `public/admin/event-site-editor.html` | Organizer event-site + packages editor |
| `public/admin/stripe-connect.html` | Stripe Connect onboarding UI |
| `public/admin/event-registrations.html` | Registrations dashboard + refunds + add-ons |
| `public/admin/event-checkin.html` | Mobile-first check-in + walk-ups (incl. Stripe QR) |
| `public/admin/event-pairings.html` | Pairings + hole assignments + auto-assign + print + scoring bridge |
| `public/admin/event-pairings-poster.html` | 24×36 in print poster for the pairings sheet |
| `public/admin/event-auction.html` | Silent-auction console — items, bids, close, winner checkout |
| `public/event-auction.html` | Public auction page — bid modal + Closed lots |
| `public/event-donate-item.html` | Public donor intake form for the auction |
| `public/admin/shop.html` | JORD Shop catalog (any admin) |
| `public/admin/shop-orders.html` | Buyer's own supply orders |
| `public/admin/shop-order.html` | Supply-order detail + super-admin Ship form |
| `public/admin/shop-products.html` | Super-admin product CRUD for the JORD shop |
| `public/event-site.html` | Public brandable event site at `/e/:slug` |
| `public/event-register.html` | Public registration form at `/e/:slug/register` |
| `public/event-confirmation.html` | Post-checkout thank-you at `/e/:slug/confirmation/:regId` |
| `public/login.html` | Personal user (player) sign-in / sign-up |
| `public/tournaments.html` | `/clubhouse` hub — create games via hash-routed wizard |
| `public/scorecard.html` | Score entry with stroke-allocation dots |
| `public/live.html` | Round leaderboard |
| `public/tournament-live.html` | Cumulative tournament leaderboard |
| `public/admin.html` | Admin panel (original) — event CRUD, course map, ball pool |
| `public/leaderboard.html` | Original LD/CTP live leaderboard |
| `public/scan.html` | Player on-course shot scan |
| `public/css/jord.css` | Shared cream editorial design system |
| `public/js/jord.js` | Frontend library — API client (dual-token), toasts, helpers |
| `scripts/seed-event-site.js` | Idempotent demo event-site seed (Fairway Fund) |
| `tests/run-tests.js` | 319 unit tests — routes, scoring, sponsorships, donations, auction, marketplace, plus inline-script syntax check across every public HTML page |
| `tests/mobile-visual.js` | Puppeteer iPhone 14 + Pixel 7 mobile visual regression |
| `CHANGELOG.md` | Full version history; v3.43.1 through v3.47 cover the latest session arc (post-v3.43 hotfix + E4 + E5) |
| `TODO.md` | Numbered backlog — reference by # (e.g. "let's do #STRIPE-LIVE") |
| `ENTERPRISE-PLATFORM-SPEC.md` | E1-E5 phased plan + competitive map vs EventCaddy |
| `LEADERBOARD-SPEC.md` | Clubhouse scoring spec |
| `memory/project_stripe.md` | Stripe Connect setup notes (in auto-memory) |
