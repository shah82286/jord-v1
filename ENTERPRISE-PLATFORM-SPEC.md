# JORD — Enterprise Tournament Platform Spec

**Working brand name:** "ParFore" *(placeholder — see §5)* · powered by JORD Golf
**Status:** Draft for sign-off · **Date:** 2026-05-17

---

## 1. Vision

A full charity / corporate golf-tournament platform — an organizer sets up a
real event (hundreds of players), publishes a branded sign-up site, collects
registrations and payments online, runs the day with check-in and live scoring,
and raises money through sponsors, donations and a silent auction.

The benchmark is **EventCaddy** (and GolfStatus). The goal: their whole feature
set, done better — anchored by JORD's scoring engine, which is far deeper than
either competitor's.

---

## 2. Product architecture — how the pieces fit

JORD already has two systems. The enterprise platform is a **third layer that
wraps them**, with the existing `events` table as the unifying container:

```
EVENT  (events table — the charity tournament; already has branding columns)
 ├─ Public event site        ← NEW: brandable sign-up site
 ├─ Registration + payments  ← NEW: packages, Stripe
 ├─ Sponsors / donations / auction / store   ← NEW (later phases)
 ├─ Day-of: check-in, pairings, financials   ← NEW
 ├─ Clubhouse tournament      ← EXISTS: full-round scoring (20 formats)
 │                              linked via tournaments.event_id
 └─ LD / CTP contests         ← EXISTS: Mapbox course-map contests
```

- **`events`** is the top-level container. It already carries charity branding
  (`is_charity`, `brand_logo`, `brand_accent`, `brand_url`) and LD/CTP config.
- **Clubhouse scoring** (`tournaments` / `rounds` / `scores`) attaches to an
  event for day-of stroke/scramble/etc. scoring — the `event_id` link exists.
- **LD/CTP contests** stay their own Mapbox-based back end, attached as add-ons.
- The enterprise platform adds the **money + audience + website** layer on top.

One product, three back ends — kept separate where they should be (the
Clubhouse uses scorecards and distances, no maps; LD/CTP uses Mapbox/GPS).

---

## 3. Competitive map — vs. EventCaddy

| Capability | EventCaddy | JORD today | Phase |
|---|---|---|---|
| Live scoring + leaderboards | basic | ✅ **far deeper** (20 formats, flights, multi-round, match play, RvB) | done |
| Player registration | ✅ | ✅ (no payment) | E1 |
| Online payments (cards) | ✅ | ❌ | E1 |
| Brandable tournament website | ✅ drag-drop builder | partial (event branding) | E1 |
| QR codes + sign-up links | ✅ | ✅ (QR infra exists) | E1 |
| Organizer dashboard / registrations | ✅ | partial | E1 |
| Pairings & hole assignments | ✅ | partial (`score_groups`) | E2 |
| Day-of check-in | ✅ | ❌ | E2 |
| Sponsor tiers + recognition | ✅ | ❌ | E3 |
| Donations | ✅ | ❌ | E3 |
| Fundraising goal tracker | ✅ | ❌ | E3 |
| Email blast / SMS | ✅ | ✅ Klaviyo | E3 (leverage) |
| Revenue / expense dashboard | ✅ | ❌ | E3 |
| Donation-item intake (donors submit auction items) | partial | ❌ | E4 |
| Silent auction — fully online bidding | ✅ | ❌ | E4 |
| Event store / raffle (charity sells to attendees) | ✅ | ❌ | E5 |
| Supplies marketplace — JORD Shopify + partner gear, custom quotes | ❌ **(our edge)** | ❌ | E5 |
| Clone past tournaments | ✅ | ❌ | E2 |

---

## 4. Business model

**Free for the organizer. Monetized by a small platform fee on each
transaction** (registration, sponsorship, donation, auction).

- The fee is added at checkout and **registrant-covered by default** — the
  GolfStatus pattern, where ~90% leave it on.
- Free-to-get-in-the-door *and* revenue from day one — no "we're starting to
  charge" moment later.
- Suggested platform fee ≈ **3%** (tunable), on top of Stripe's processing fee.
- Explicitly court **501(c) nonprofits** — the heart of this market.
- Revenue is naturally gated on payments shipping (E1).

---

## 5. Brand & naming

The platform gets its own brand, separate domain, "powered by JORD Golf".

- **Name is not decided** — "ParFore" is a working placeholder.
- The brand name is a **single config value** (`BRAND_NAME`); every title,
  header and event site reads from it. Final name = one-line change.
- **Logo:** a text wordmark placeholder for now; the real logo file drops into
  `img/logos/` later.
- **Colors/fonts:** inherits JORD's design system (cream, saffron, Playfair /
  Inter). A distinct brand guide later is a CSS `:root` variable swap.

---

## 6. Payments — Stripe

- **Stripe Connect** — JORD is a platform collecting on behalf of each charity;
  funds pay out to the organizer's connected account, JORD takes an
  `application_fee`.
- **E1 builds against Stripe test mode** — full registration→payment→confirm
  flow, fake cards, fully demoable. No real money.
- **Going live** = create the Stripe account, enable Connect, organizers
  complete Stripe's identity/bank verification, swap test keys → live keys.
  Same code.

---

## 7. Data model — E1

Builds on the existing `events` table. New tables:

```
event_sites           -- the brandable public sign-up site
  event_id, slug (custom URL), headline, about, hero_image,
  schedule, info_blocks (JSON), published

registration_packages -- ticket types an organizer sells
  id, event_id, name (e.g. "Single Player", "Foursome", "Hole Sponsor"),
  description, price_cents, includes_players, quantity_limit, sort

registrations          -- one sign-up
  id, event_id, package_id, buyer_name, buyer_email, buyer_phone,
  players_json, amount_cents, platform_fee_cents,
  payment_status (pending|paid|refunded), created_at

payments               -- Stripe transactions
  id, registration_id, stripe_payment_intent, amount_cents,
  fee_cents, status, created_at

users                  -- the public account system (account required)
  id, name, email, password_hash, created_at
  (organizers are users; registrants may create one; players.account_id links)
```

**Account architecture (decision needed — see §9):** recommend `users` as the
single public account system — event organizers and Clubhouse users are all
`users`. The existing `admins` table stays for JORD staff + legacy LD/CTP
operators.

---

## 8. Phased plan

**E1 — Sell tickets** *(a sellable product on its own)*
- `users` accounts: sign-up / log-in (personal accounts, separate from organizers).
- Brandable public event site at `/e/:slug` — **a polished, professional standard
  template** covering every section a tournament needs: hero, about, schedule,
  course info, registration packages, sponsors, FAQ, contact. Editable copy +
  organizer's logo/colors.
- Registration packages (organizer defines ticket types + prices).
- Online registration → **Stripe test-mode** payment → confirmation email.
- QR code + share links for the sign-up site.
- Organizer dashboard: registrations list, revenue total, CSV export.

**E2 — Run the day**
- Day-of check-in (search/scan a registrant).
- Pairings & hole assignments; clone a past tournament.
- Wire the Clubhouse scoring engine to the event.
- Attach LD / CTP contests.

**E3 — Raise money**
- Sponsorships — standard catalog (title, hole, cart, beverage cart, food,
  hole-in-one, LD, CTP, scorecard, leaderboard, foursome, …) + **+ Add custom**
  (name, description, price, quantity). Logos and recognition placed on the
  event site automatically. See §9.
- Cash donations (one-off, year-round).
- Fundraising goal tracker bar.
- Email blast via the existing Klaviyo integration.
- Revenue / expense (budget) dashboard.

**E4 — Donations & silent auction**
- Donation-item intake form for donors (see §9).
- Organizer review/approval of submitted items.
- Approved items auto-list into a fully online silent auction.
- Timed bidding, outbid alerts, auto-close, winner checkout via Stripe.

**E5 — Marketplaces**
- Event store — charity sells raffle tickets, mulligans, merch to attendees.
- Supplies marketplace — organizers buy JORD Shopify + partner gear, or
  request custom quotes (see §9).

---

## 9. Donations, auction & marketplaces

### Donation-item intake → silent auction
- A donor-facing **submission form** (linked from the event site): item name,
  description, **photos**, retail value, donor name / business, website and
  contact — everything a charity needs to list and credit the donor.
- The organizer **reviews and approves** each submission.
- Approved items **auto-list** into the event's **silent auction** — no
  re-entry by the organizer.
- The auction runs **fully online**: timed bidding, outbid notifications,
  auto-close, winner checkout via Stripe. *(E4)*

### Event store — the charity sells to attendees
- Raffle tickets, mulligans, add-on games and merch — sold during registration
  and standalone, with checkout upsells. *(E5)*

### Supplies marketplace — the organizer buys
- Tournament supplies in one place: **JORD Golf products** pulled from the
  Shopify store (Shopify Storefront API / Buy Buttons), plus **curated
  golf-industry partner products**.
- A **"request a custom quote"** path for custom items — tee gifts, banners,
  branded merch.
- This is **beyond EventCaddy** — a JORD differentiator, and a direct revenue
  line into every tournament. *(E5)*

### Sponsorships — standard catalog + custom
Organizers configure sponsorships from a **built-in catalog** of common types,
plus an **"+ Add custom sponsorship"** option for anything unique. Every
sponsorship has a **name, description, price** and **quantity available**
(e.g. 18 hole sponsorships).

**Catalog** (one-click enable per type, with sensible default copy):
- **Tiered:** Title / Presenting, Gold, Silver, Bronze
- **On-course:** Hole, Tee Box, Green, Driving Range, Putting Green
- **Mobile:** Cart, Beverage Cart
- **Food / drink:** Breakfast, Lunch, Dinner / Banquet, Snack Shack, Bar
- **Contests:** Hole-in-One, **Longest Drive**, **Closest to Pin** *(direct JORD tie-in)*, Putting Contest
- **Materials:** Scorecard, Leaderboard, Pin Flag, Banner, Photo / Video
- **Player:** Goodie Bag, Tee Gift, Prize, Awards
- **Foursome** — team entry packaged with recognition

Plus **+ Add custom** — fully open: any name, description, price, quantity. *(E3)*

### North star
Touch **every** part of a charity golf event so the organizer's job is easy —
the single biggest pain point in the industry.

---

## 10. Open decisions / risks

- **Accounts (resolved)** — two separate systems, by design:
  - **`users`** = personal accounts for **players** (people who sign up and play).
  - **`admins`** (existing) = tournament organizers + JORD staff. Different
    tooling, different audience.
- **Live payments** — Stripe Connect onboarding/verification is real work and
  involves regulated money movement; E1 ships test-mode only.
- **Event site builder** — E1 is a *template with editable fields*, not a full
  drag-and-drop builder. Drag-drop is a later upgrade if needed.
- **Domain / brand name** — placeholder until chosen; non-blocking.
- **Scope** — EventCaddy is a 10-year-old product; this is a multi-month
  roadmap. E1 alone is a meaningful, sellable milestone.
