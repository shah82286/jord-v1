/**
 * JORD Golf Tournament System — Server
 * Version: 3.5.0 | Built: 2026-05-07
 *
 * Supports: Team Longest Drive + Closest to the Pin
 * Stack: Node.js / Express / SQLite / Mapbox GL
 */

const express  = require('express');
const Database = require('better-sqlite3');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const nodemailer = require('nodemailer');
const backup    = require('./scripts/backup');
const golfApi   = require('./lib/golfCourseApi');   // golfcourseapi.com client
const handicap  = require('./lib/handicap');         // WHS handicap math
const scoring   = require('./lib/scoring');          // scoring engine
const formats   = require('./lib/formats');          // game-format catalog
const stripeHelper = require('./lib/stripe');        // Stripe Connect + Checkout
const tzLookup     = require('tz-lookup');           // IANA time zone from lat/lon

// Resolve IANA time zone (e.g. "America/Chicago") from venue coordinates.
// Returns null when lat/lon are missing or out of range so callers can leave
// the column NULL instead of writing a misleading default.
function detectTimeZone(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  try { return tzLookup(la, lo); } catch { return null; }
}

// Railway's container network has no working IPv6 outbound. Node 17+ resolves
// DNS "verbatim" (IPv6 first), so smtp.gmail.com → an IPv6 address → ENETUNREACH.
// Force IPv4-first so SMTP and other outbound connections actually connect.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

// Load env
const env = {};
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim();
  });
} catch {}

const PORT           = env.PORT           || process.env.PORT           || 3000;
const APP_URL        = env.APP_URL        || process.env.APP_URL         || `http://localhost:${PORT}`;
// Admin password MUST be set - no hardcoded defaults for security
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD  || (() => {
  const pwd = crypto.randomBytes(16).toString('hex');
  console.log(`[Auth] Generated random admin password (set ADMIN_PASSWORD env to use a custom one): ${pwd}`);
  return pwd;
})();
const MAPBOX_TOKEN   = env.MAPBOX_TOKEN   || process.env.MAPBOX_TOKEN    || '';
const KLAVIYO_KEY          = env.KLAVIYO_API_KEY     || process.env.KLAVIYO_API_KEY      || '';
const KLAVIYO_EMAIL_LIST   = env.KLAVIYO_EMAIL_LIST_ID|| process.env.KLAVIYO_EMAIL_LIST_ID || '';
const KLAVIYO_SMS_LIST     = env.KLAVIYO_SMS_LIST_ID  || process.env.KLAVIYO_SMS_LIST_ID   || '';
const SMTP_HOST      = env.SMTP_HOST      || process.env.SMTP_HOST       || '';
const SMTP_PORT      = parseInt(env.SMTP_PORT || process.env.SMTP_PORT || '587');
const SMTP_USER      = env.SMTP_USER      || process.env.SMTP_USER       || '';
const SMTP_PASS      = env.SMTP_PASS      || process.env.SMTP_PASS       || '';
const SUPPORT_EMAIL  = env.SUPPORT_EMAIL  || process.env.SUPPORT_EMAIL   || 'support@jordgolf.com';
const GOLF_COURSE_API_KEY = env.GOLF_COURSE_API_KEY || process.env.GOLF_COURSE_API_KEY || '';

const app = express();

// DB_PATH points at the persistent volume in production (e.g. /data/jord.db on Railway).
// Defaults to ./data/jord.db for local dev.
const DB_PATH = env.DB_PATH || process.env.DB_PATH || './data/jord.db';
const DB_DIR  = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// First-boot migration: if the volume DB doesn't exist yet but a legacy ./data/jord.db
// is bundled in the image, copy it over so a one-time deploy doesn't lose history.
// Idempotent: only runs when the target file is missing.
const LEGACY_DB = './data/jord.db';
if (!fs.existsSync(DB_PATH) && LEGACY_DB !== DB_PATH && fs.existsSync(LEGACY_DB)) {
  try {
    fs.copyFileSync(LEGACY_DB, DB_PATH);
    console.log(`[DB] First-boot: copied legacy DB ${LEGACY_DB} -> ${DB_PATH}`);
  } catch (err) {
    console.warn('[DB] Legacy copy failed (continuing with fresh DB):', err.message);
  }
}

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  console.log(`[DB] Connected to SQLite at ${DB_PATH}`);
} catch (err) {
  console.error('[FATAL] Database initialization failed:', err.message);
  process.exit(1);
}

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    venue           TEXT,
    starts_at       DATETIME NOT NULL,
    ends_at         DATETIME NOT NULL,
    status          TEXT DEFAULT 'setup',   -- setup | active | ended
    -- Hole configuration
    has_longest_drive   INTEGER DEFAULT 1,
    has_closest_pin     INTEGER DEFAULT 0,
    combined_scoring    INTEGER DEFAULT 0,
    -- Scoring toggles (longest drive)
    allow_rough         INTEGER DEFAULT 0,
    rough_penalty_mode  TEXT DEFAULT 'perpendicular', -- perpendicular | fixed
    rough_fixed_yards   REAL DEFAULT 0,
    allow_oob           INTEGER DEFAULT 0,
    oob_penalty_mode    TEXT DEFAULT 'half_hole',     -- half_hole | fixed
    oob_fixed_yards     REAL DEFAULT 0,
    hole_distance_yards REAL DEFAULT 300,             -- used for OOB calc
    -- Fairway polygon (GeoJSON string)
    fairway_polygon     TEXT,
    green_polygon       TEXT,
    -- Pin location (closest to pin)
    pin_lat             REAL,
    pin_lon             REAL,
    -- Contact
    admin_phone         TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tournament_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_name   TEXT NOT NULL,
    event_date        TEXT NOT NULL,
    venue             TEXT NOT NULL,
    location          TEXT NOT NULL,
    contest_type      TEXT NOT NULL,    -- ld | ctp | both
    expected_players  INTEGER NOT NULL,
    admin_name        TEXT NOT NULL,
    admin_email       TEXT NOT NULL,
    admin_phone       TEXT NOT NULL,
    notes             TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | replied
    created_event_id  TEXT,                              -- FK events.id when accepted
    reply_log         TEXT,                              -- JSON array of {at, by, subject, body}
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tee_boxes (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL,
    name        TEXT NOT NULL,   -- e.g. "Men's", "Women's", "Senior"
    color       TEXT DEFAULT 'white',
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    hole_type   TEXT DEFAULT 'longest_drive', -- longest_drive | closest_pin
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS teams (
    id            TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL,
    team_name     TEXT NOT NULL,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified_lead INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS balls (
    drop_code        TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    team_id          TEXT,
    player_index     INTEGER,
    first_name       TEXT,
    last_name        TEXT,
    email            TEXT,
    phone            TEXT,
    tee_box_id       TEXT,
    -- Longest drive data
    ld_lat           REAL,
    ld_lon           REAL,
    ld_raw_yards     REAL,
    ld_penalty_yards REAL DEFAULT 0,
    ld_final_yards   REAL,
    ld_location_type TEXT,   -- fairway | rough | oob | lost | manual
    ld_scanned_at    DATETIME,
    ld_manual_entry  INTEGER DEFAULT 0,
    -- Closest to pin data
    cp_lat           REAL,
    cp_lon           REAL,
    cp_distance_ft   REAL,
    cp_valid         INTEGER DEFAULT 1,
    cp_scanned_at    DATETIME,
    -- Status
    status           TEXT DEFAULT 'pre_tournament', -- pre_tournament | tournament | drop | available
    tournament_name  TEXT,
    tournament_venue TEXT,
    tournament_date  TEXT,
    added_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (drop_code, event_id),
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (team_id)  REFERENCES teams(id),
    FOREIGN KEY (tee_box_id) REFERENCES tee_boxes(id)
  );

  CREATE TABLE IF NOT EXISTS admin_corrections (
    id          TEXT PRIMARY KEY,
    drop_code   TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    corrected_by TEXT DEFAULT 'admin',
    old_value   TEXT,
    new_value   TEXT,
    reason      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rep_alerts (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL,
    drop_code   TEXT,
    team_name   TEXT,
    player_name TEXT,
    lat         REAL,
    lon         REAL,
    message     TEXT,
    resolved    INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sms_log (
    id          TEXT PRIMARY KEY,
    event_id    TEXT,
    recipient   TEXT,
    message     TEXT,
    type        TEXT,
    sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    role                TEXT DEFAULT 'admin',   -- super | admin
    active              INTEGER DEFAULT 1,
    perm_corrections    INTEGER DEFAULT 1,
    perm_end_tournament INTEGER DEFAULT 1,
    perm_manage_players INTEGER DEFAULT 1,
    perm_manage_balls   INTEGER DEFAULT 1,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    admin_id    TEXT NOT NULL,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token       TEXT PRIMARY KEY,
    admin_id    TEXT NOT NULL,
    used        INTEGER DEFAULT 0,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  );
`);

// Add rough/oob polygon columns to existing DBs that predate this feature
try { db.exec("ALTER TABLE events ADD COLUMN rough_polygon TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN oob_polygon TEXT");   } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN admin_phone TEXT");   } catch {}

// CTP-specific hole columns (separate from LD hole)
try { db.exec("ALTER TABLE events ADD COLUMN ctp_pin_lat REAL"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN ctp_pin_lon REAL"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN ctp_green_polygon TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN ctp_hole_distance_yards REAL DEFAULT 0"); } catch {}

// CTP off-green penalty
try { db.exec("ALTER TABLE events ADD COLUMN cp_off_green_penalty_ft REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE balls ADD COLUMN cp_penalty_ft REAL DEFAULT 0"); } catch {}

// Venue coordinates (set when admin selects course from autocomplete)
try { db.exec("ALTER TABLE events ADD COLUMN venue_lat REAL"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN venue_lon REAL"); } catch {}

// IANA time zone (e.g. "America/Chicago"). Auto-set from venue_lat/lon via
// tz-lookup whenever those coords change, so tee times display in the
// course's actual local zone instead of the server's.
try { db.exec("ALTER TABLE events ADD COLUMN time_zone TEXT"); } catch {}

// Pairings: free-text cart-number field per group ("12, 13" for two carts,
// "Walking" for none, etc.). Free-form on purpose — every event numbers
// carts differently.
try { db.exec("ALTER TABLE pairing_groups ADD COLUMN cart_numbers TEXT"); } catch {}

// Sponsorships (E3): registration_packages doubles as the sponsorship
// catalog. `package_kind` discriminates the two; `sponsor_type` picks
// from a known catalog (hole, cart, beverage, etc.) so the public site
// can render a recognizable sponsor card.
try { db.exec("ALTER TABLE registration_packages ADD COLUMN package_kind TEXT DEFAULT 'registration'"); } catch {}
try { db.exec("ALTER TABLE registration_packages ADD COLUMN sponsor_type TEXT"); } catch {}

// Event store (E5 phase 1): a fifth package_kind 'event_item' lets the
// charity sell things to attendees alongside player tickets — raffle
// tickets, mulligans, merch, contest entries. image_data carries an
// optional product photo (~2.5 MB cap, same rule as auction items).
try { db.exec("ALTER TABLE registration_packages ADD COLUMN image_data TEXT"); } catch {}

// Fundraising goal (E3 phase 2): optional target the public site shows
// as an animated progress bar. `_visible` is a separate toggle so an
// organizer can set a goal privately before deciding to show it.
try { db.exec("ALTER TABLE events ADD COLUMN fundraising_goal_cents INTEGER"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN fundraising_visible INTEGER DEFAULT 0"); } catch {}

// Standalone donations (E3 phase 3): visitors can give any amount without
// buying a package. Stored on event_sites since they're public-page
// configuration. A lazy 'donation' package is auto-created per event the
// first time someone donates (cleaner than upfront seeding).
try { db.exec("ALTER TABLE event_sites ADD COLUMN donations_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE event_sites ADD COLUMN donation_suggested_json TEXT"); } catch {}
try { db.exec("ALTER TABLE event_sites ADD COLUMN donation_min_cents INTEGER DEFAULT 500"); } catch {}
try { db.exec("ALTER TABLE event_sites ADD COLUMN donation_prompt TEXT"); } catch {}

// Pairings ↔ scoring bridge (v3.44): mirror pairing_groups into score_groups
// so the live leaderboard groups players by foursome. score_groups.pairing_group_id
// is the link; round_entries.source_registration_id/source_player_index let
// us re-sync group assignments after the pairings change.
try { db.exec("ALTER TABLE score_groups ADD COLUMN pairing_group_id TEXT"); } catch {}
try { db.exec("ALTER TABLE round_entries ADD COLUMN source_registration_id TEXT"); } catch {}
try { db.exec("ALTER TABLE round_entries ADD COLUMN source_player_index INTEGER"); } catch {}

// Silent auction (E4): an event can run a timed silent auction alongside
// registrations. Items live in `auction_items`, bids in `auction_bids`.
// The lazy 'auction_item' package_kind is created per-item at winner
// checkout (same lazy pattern as donations).
db.exec(`
  CREATE TABLE IF NOT EXISTS auction_items (
    id                     TEXT PRIMARY KEY,
    event_id               TEXT NOT NULL,
    title                  TEXT NOT NULL,
    description            TEXT,
    image_data             TEXT,          -- base64 data URL, ~2.5 MB cap
    starting_bid_cents     INTEGER NOT NULL DEFAULT 0,
    min_increment_cents    INTEGER DEFAULT 500,
    fair_value_cents       INTEGER,       -- estimated value, shown publicly
    donor_name             TEXT,          -- who donated the item
    status                 TEXT DEFAULT 'pending',
       -- pending  → submitted via intake form, awaiting organizer approval
       -- live     → approved + accepting bids during [opens_at, closes_at]
       -- ended    → closes_at passed, winner picked, awaiting payment
       -- paid     → winner paid via Stripe
       -- rejected → admin declined to list
    opens_at               TEXT,          -- ISO datetime; bidding starts
    closes_at              TEXT,          -- ISO datetime; bidding ends
    winner_email           TEXT,
    winner_name            TEXT,
    winner_bid_cents       INTEGER,
    winner_registration_id TEXT,          -- FK once they checkout
    sort_order             INTEGER DEFAULT 0,
    created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auction_items_event ON auction_items(event_id, status, sort_order);

  CREATE TABLE IF NOT EXISTS auction_bids (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    event_id     TEXT NOT NULL,         -- denormalized for fast per-event aggregates
    bidder_name  TEXT NOT NULL,
    bidder_email TEXT NOT NULL,
    bidder_phone TEXT,
    amount_cents INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES auction_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auction_bids_item ON auction_bids(item_id, amount_cents DESC, created_at);
`);

// Public toggles — same opt-in pattern as donations. `auction_enabled`
// controls the public listing/bidding pages; `auction_intake_enabled`
// controls whether visitors can also submit items via the intake form.
try { db.exec("ALTER TABLE event_sites ADD COLUMN auction_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE event_sites ADD COLUMN auction_intake_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE event_sites ADD COLUMN auction_intro TEXT"); } catch {}

// Team share code (6-char code from registration; lets players join via QR after team is finalized)
try { db.exec("ALTER TABLE teams ADD COLUMN share_code TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_teams_share_code ON teams(share_code)"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN zone_visibility TEXT"); } catch {}

// Multi-admin: link events to the admin who created them
try { db.exec("ALTER TABLE events ADD COLUMN admin_id TEXT"); } catch {}

// Global leaderboard: opt-in flag per event
try { db.exec("ALTER TABLE events ADD COLUMN global_published INTEGER DEFAULT 0"); } catch {}

// Marketing opt-ins collected at registration
try { db.exec("ALTER TABLE balls ADD COLUMN email_opt_in INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE balls ADD COLUMN sms_opt_in INTEGER DEFAULT 0"); } catch {}

// Inbound tournament requests — additional fields
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN event_url TEXT"); } catch {}
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN venue_lat REAL"); } catch {}
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN venue_lon REAL"); } catch {}

// ─── Tournament Rep role (v3.9.0) ────────────────────────────────────────────
// New permission columns gate actions a rep can perform from /monitor.
// Column default 0 (OFF) so a freshly-INSERTed rep is read-only.
// We then bump existing admin/super rows to 1 so the new gates don't lock
// pre-v3.9.0 admins out of actions they already had.
try { db.exec("ALTER TABLE admins ADD COLUMN perm_resolve_alerts INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN perm_reset_scans INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN perm_register_walkups INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN parent_admin_id TEXT"); } catch {}
// Rep view permissions — what a rep can see from /monitor.
//   perm_view_leaderboard: 0 = hidden, 1 = can view
//   perm_ball_codes / perm_players_teams: 0 = hidden, 1 = view only, 2 = can edit
try { db.exec("ALTER TABLE admins ADD COLUMN perm_view_leaderboard INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN perm_ball_codes INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN perm_players_teams INTEGER DEFAULT 0"); } catch {}
// Backfill: existing super/admin rows opt-in to all three new perms.
// (Idempotent — a rerun on already-1 rows is a no-op.)
db.prepare("UPDATE admins SET perm_resolve_alerts=1, perm_reset_scans=1, perm_register_walkups=1 WHERE role IN ('super','admin')").run();
// Super/admin always have full leaderboard/ball-code/player visibility (level 2).
db.prepare("UPDATE admins SET perm_view_leaderboard=1, perm_ball_codes=2, perm_players_teams=2 WHERE role IN ('super','admin')").run();

// ─── Stripe Connect (v3.31) ───────────────────────────────────────────────────
// Each organizer onboards their own Stripe Connect Express account. Funds for
// their events flow directly to that account; JORD takes a platform fee
// (STRIPE_PLATFORM_FEE_BPS, default 300bp = 3%) via Stripe's
// `application_fee_amount` on the Checkout Session.
//   stripe_account_id        — acct_… returned by stripe.accounts.create
//   stripe_account_status    — 'pending' | 'active' | 'restricted'
//   stripe_charges_enabled   — 1 if Stripe will accept charges for this account
//   stripe_payouts_enabled   — 1 if Stripe will pay out to the connected bank
//   stripe_details_submitted — 1 once organizer finishes onboarding form
//   stripe_connected_at      — first time the account became active
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_account_id TEXT"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_account_status TEXT"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_charges_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_payouts_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_details_submitted INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN stripe_connected_at DATETIME"); } catch {}

// ─── Refunds + add-on charges (v3.34) ─────────────────────────────────────────
// `refund_amount_cents`     — running total refunded so far (allows multiple
//                              partials). 0 = no refund. Equal to amount_cents
//                              = fully refunded.
// `refund_reason`            — organizer's note (for audit / dispute defense).
// `refunded_at`              — first refund timestamp.
// `refunded_by_admin_id`     — who clicked the refund button.
// `parent_registration_id`   — non-null on add-on charges; points at the
//                              original registration this add-on belongs to.
// `description`              — for add-ons, what the buyer is paying for
//                              ("Mulligan pack", "5th player", etc.). NULL on
//                              regular package registrations (package name
//                              already describes them).
try { db.exec("ALTER TABLE registrations ADD COLUMN refund_amount_cents INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE registrations ADD COLUMN refund_reason TEXT"); } catch {}
try { db.exec("ALTER TABLE registrations ADD COLUMN refunded_at DATETIME"); } catch {}
try { db.exec("ALTER TABLE registrations ADD COLUMN refunded_by_admin_id TEXT"); } catch {}
try { db.exec("ALTER TABLE registrations ADD COLUMN parent_registration_id TEXT"); } catch {}
try { db.exec("ALTER TABLE registrations ADD COLUMN description TEXT"); } catch {}
// Per-event rep assignments (many-to-many)
db.exec(`
  CREATE TABLE IF NOT EXISTS event_reps (
    event_id      TEXT NOT NULL,
    rep_id        TEXT NOT NULL,
    assigned_by   TEXT,
    assigned_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, rep_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (rep_id) REFERENCES admins(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_event_reps_rep ON event_reps(rep_id);
`);

// Per-event admin assignments (many-to-many). events.admin_id remains the
// CREATOR; event_admins grants additional admins management access to an event.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_admins (
    event_id      TEXT NOT NULL,
    admin_id      TEXT NOT NULL,
    assigned_by   TEXT,
    assigned_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, admin_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_event_admins_admin ON event_admins(admin_id);
`);

// ─── Event branding (charity events) ─────────────────────────────────────────
// Signup form collects a charity flag, org URL, and an optional uploaded logo.
// On accept, a super admin can extract branding from the org's site and apply a
// "meshed" look (their logo + accent color) to the event's admin + player pages.
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN is_charity INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN charity_url TEXT"); } catch {}
try { db.exec("ALTER TABLE tournament_requests ADD COLUMN logo_data TEXT"); } catch {}   // base64 data URL
try { db.exec("ALTER TABLE events ADD COLUMN is_charity INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN brand_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN brand_logo TEXT"); } catch {}               // base64 data URL
try { db.exec("ALTER TABLE events ADD COLUMN brand_accent TEXT"); } catch {}             // hex color
try { db.exec("ALTER TABLE events ADD COLUMN brand_url TEXT"); } catch {}

// ═══ TOURNAMENT SCORING — Live Leaderboard (Phase 1) ═════════════════════════
// Full-round stroke-play scoring, separate from the LD/CTP contest system.
// A `round` is the core unit; a `tournament` wraps one or more rounds. Casual
// buddy rounds reuse the same tables with type='casual'. Pure data — no maps.
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    handicap_index  REAL,
    account_id      TEXT,                       -- reserved for future app accounts
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS courses (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    club_name     TEXT,
    city          TEXT,
    state         TEXT,
    country       TEXT,
    lat           REAL,
    lon           REAL,
    num_holes     INTEGER DEFAULT 18,
    source        TEXT DEFAULT 'manual',        -- manual | golfcourseapi | igolf
    external_id   TEXT,                         -- provider course id (cache key)
    created_by    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS course_tees (
    id              TEXT PRIMARY KEY,
    course_id       TEXT NOT NULL,
    name            TEXT NOT NULL,              -- "Blue", "White", "Gold"
    gender          TEXT DEFAULT 'male',        -- male | female
    par_total       INTEGER,
    yardage_total   INTEGER,
    course_rating   REAL,
    slope_rating    INTEGER,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tee_holes (
    id              TEXT PRIMARY KEY,
    tee_id          TEXT NOT NULL,
    hole_number     INTEGER NOT NULL,
    par             INTEGER NOT NULL,
    stroke_index    INTEGER,                    -- 1..18, handicap-stroke allocation
    yardage         INTEGER,
    FOREIGN KEY (tee_id) REFERENCES course_tees(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tournaments (
    id              TEXT PRIMARY KEY,
    type            TEXT DEFAULT 'tournament',  -- tournament | casual
    name            TEXT NOT NULL,
    admin_id        TEXT,                       -- null for casual rounds
    event_id        TEXT,                       -- optional link to events table
    default_format  TEXT DEFAULT 'stroke_gross',
    num_rounds      INTEGER DEFAULT 1,
    flights_enabled INTEGER DEFAULT 0,
    num_flights     INTEGER DEFAULT 1,
    banter_enabled  INTEGER DEFAULT 1,
    status          TEXT DEFAULT 'setup',       -- setup | active | ended
    share_code      TEXT,                       -- short code for the join link
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id              TEXT PRIMARY KEY,
    tournament_id   TEXT NOT NULL,
    round_number    INTEGER DEFAULT 1,
    course_id       TEXT,
    round_date      TEXT,
    format          TEXT DEFAULT 'stroke_gross',
    status          TEXT DEFAULT 'setup',       -- setup | active | ended
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS score_groups (
    id              TEXT PRIMARY KEY,
    round_id        TEXT NOT NULL,
    name            TEXT,                       -- "Group 1"
    tee_time        TEXT,
    starting_hole   INTEGER DEFAULT 1,
    FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS round_entries (
    id              TEXT PRIMARY KEY,
    round_id        TEXT NOT NULL,
    player_id       TEXT NOT NULL,
    tee_id          TEXT,
    group_id        TEXT,
    course_handicap INTEGER,                    -- computed at setup from WHS
    FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scores (
    id              TEXT PRIMARY KEY,
    round_entry_id  TEXT NOT NULL,
    hole_number     INTEGER NOT NULL,
    strokes         INTEGER,
    entered_by      TEXT,
    entered_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(round_entry_id, hole_number),
    FOREIGN KEY (round_entry_id) REFERENCES round_entries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_course_tees_course  ON course_tees(course_id);
  CREATE INDEX IF NOT EXISTS idx_tee_holes_tee    ON tee_holes(tee_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_tournament   ON rounds(tournament_id);
  CREATE INDEX IF NOT EXISTS idx_round_entries_round ON round_entries(round_id);
  CREATE INDEX IF NOT EXISTS idx_scores_entry        ON scores(round_entry_id);
`);

// Which holes a round plays — all 18, front 9, or back 9.
try { db.exec("ALTER TABLE rounds ADD COLUMN holes_segment TEXT DEFAULT 'all'"); } catch {}
// Per-hole point multipliers (Duplicate format) — JSON array of 18 values.
try { db.exec("ALTER TABLE rounds ADD COLUMN hole_multipliers TEXT"); } catch {}

// Phase 3B — team formats: a competitor can be a team of players.
db.exec(`
  CREATE TABLE IF NOT EXISTS round_teams (
    id            TEXT PRIMARY KEY,
    round_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    team_handicap INTEGER,
    FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_round_teams_round ON round_teams(round_id);
`);
// team_id groups a player entry into a team; is_team_card flags the single
// shared scorecard used by one-ball formats (scramble / foursomes / greensome).
try { db.exec("ALTER TABLE round_entries ADD COLUMN team_id TEXT"); } catch {}
try { db.exec("ALTER TABLE round_entries ADD COLUMN is_team_card INTEGER DEFAULT 0"); } catch {}
// Reds vs Blues: which side a player is on, and the match number that pairs a
// Red competitor against a Blue one.
try { db.exec("ALTER TABLE round_entries ADD COLUMN side TEXT"); } catch {}
try { db.exec("ALTER TABLE round_entries ADD COLUMN match_no INTEGER"); } catch {}

// ═══ ENTERPRISE TOURNAMENT PLATFORM — Phase E1 ══════════════════════════════
// Personal user accounts (for players). Separate from `admins` (the organizer
// + staff system) — see ENTERPRISE-PLATFORM-SPEC.md §10.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
`);
// Optional self-reported WHS handicap index; ghin_id reserved for USGA / GHIN sync.
try { db.exec("ALTER TABLE users ADD COLUMN handicap_index REAL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN ghin_id TEXT"); } catch {}

// Public event site (the brandable sign-up page at /e/:slug) and the
// ticket types the organizer sells.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_sites (
    event_id      TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    headline      TEXT,
    subhead       TEXT,
    hero_image    TEXT,
    starts_at     TEXT,
    location_name TEXT,
    about_html    TEXT,
    schedule_json TEXT,
    course_info   TEXT,
    faq_json      TEXT,
    contact_name  TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    published     INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_event_sites_slug ON event_sites(slug);

  CREATE TABLE IF NOT EXISTS registration_packages (
    id               TEXT PRIMARY KEY,
    event_id         TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT,
    price_cents      INTEGER NOT NULL DEFAULT 0,
    includes_players INTEGER DEFAULT 1,
    quantity_limit   INTEGER,
    sort_order       INTEGER DEFAULT 0,
    active           INTEGER DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_packages_event ON registration_packages(event_id, sort_order);

  CREATE TABLE IF NOT EXISTS registrations (
    id                  TEXT PRIMARY KEY,
    event_id            TEXT NOT NULL,
    package_id          TEXT NOT NULL,
    buyer_name          TEXT NOT NULL,
    buyer_email         TEXT NOT NULL,
    buyer_phone         TEXT,
    players_json        TEXT,                     -- JSON: [{name}, ...]
    amount_cents        INTEGER NOT NULL DEFAULT 0,
    platform_fee_cents  INTEGER DEFAULT 0,
    payment_status      TEXT DEFAULT 'pending',   -- pending | paid | refunded | failed
    payment_mode        TEXT,                     -- mock | stripe
    stripe_session_id   TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at             DATETIME,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS checkins (
    registration_id  TEXT NOT NULL,
    player_index     INTEGER NOT NULL,    -- position in registrations.players_json
    player_name      TEXT,                -- snapshotted so renaming a player doesn't break the link
    checked_in_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    checked_in_by    TEXT,                -- admin id
    PRIMARY KEY (registration_id, player_index),
    FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pairing_groups (
    id              TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL,
    name            TEXT NOT NULL,        -- "Group 1" / "Smith Foursome"
    starting_hole   INTEGER,              -- 1..18 (NULL for tee-time events)
    tee_time        TEXT,                 -- "08:15 AM" — free text so we don't fight time-zone math
    sort_order      INTEGER DEFAULT 0,    -- for manual reordering
    notes           TEXT,                 -- cart pairing, dietary, etc.
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by      TEXT,                 -- admin id
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pairing_groups_event ON pairing_groups(event_id, sort_order, starting_hole);

  CREATE TABLE IF NOT EXISTS pairing_members (
    group_id         TEXT NOT NULL,
    event_id         TEXT NOT NULL,        -- denormalized for the uniqueness constraint
    registration_id  TEXT NOT NULL,
    player_index     INTEGER NOT NULL,
    player_name      TEXT,                 -- snapshotted
    position         INTEGER DEFAULT 0,    -- order within the group (1st, 2nd, ...)
    PRIMARY KEY (group_id, registration_id, player_index),
    UNIQUE (event_id, registration_id, player_index),  -- a player is in at most one group per event
    FOREIGN KEY (group_id) REFERENCES pairing_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pairing_members_event ON pairing_members(event_id);
`);

// ─── AUTH HELPERS ────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return check === hash;
  } catch { return false; }
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token,admin_id,expires_at) VALUES (?,?,?)').run(token, adminId, expires);
  return token;
}

function getSessionAdmin(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT a.* FROM sessions s
    JOIN admins a ON a.id=s.admin_id
    WHERE s.token=? AND s.expires_at > datetime('now') AND a.active=1
  `).get(token) || null;
}

// Seed super admin on first run if no admins exist
(function seedSuperAdmin() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM admins').get();
  if (n > 0) return;
  const email = env.SUPER_ADMIN_EMAIL || process.env.SUPER_ADMIN_EMAIL || 'shah82286@gmail.com';
  db.prepare('INSERT INTO admins (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(uid('ADM'), 'JORD Super Admin', email, hashPassword(ADMIN_PASSWORD), 'super');
  console.log(`[Auth] Super admin created: ${email} / password from ADMIN_PASSWORD env`);
})();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// ─── HEALTHCHECK (must be BEFORE HTTPS redirect) ──────────────────────────────
// Railway probes the container directly on its internal port, without going
// through the proxy. That means no x-forwarded-proto: https header, so the
// HTTPS redirect below would 301 the healthcheck and Railway would mark the
// deployment unhealthy. Register these routes first so they always return 200.
app.get(['/ping', '/healthz'], (req, res) => res.status(200).send('OK'));

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────
// Must be before express.static so headers are applied to all responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=(self)');

  // Enforce HTTPS in production
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});

// ─── STRIPE WEBHOOK (raw body — MUST be before express.json) ─────────────────
// Stripe signs the raw request body. Once express.json() parses it, the bytes
// no longer match the signature and `constructEvent` rejects every request.
// Register this route with `express.raw` BEFORE the json middleware below.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (stripeHelper.mode !== 'stripe') return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeHelper.verifyWebhook(req.body, sig);
  } catch (e) {
    console.error('[Stripe webhook] signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const regId = session.metadata && session.metadata.registration_id;
        if (regId) {
          db.prepare(`UPDATE registrations
                      SET payment_status='paid',
                          payment_mode='stripe',
                          stripe_session_id=?,
                          paid_at=CURRENT_TIMESTAMP
                      WHERE id=? AND payment_status!='paid'`)
            .run(session.id, regId);
          console.log(`[Stripe] Registration ${regId} marked paid (session ${session.id})`);

          // Auction winner paid — flip the linked auction_item to 'paid'
          // so it disappears from the public listing and shows as settled
          // in the admin auction console.
          if (session.metadata.auction_item_id) {
            db.prepare("UPDATE auction_items SET status='paid' WHERE id=? AND event_id=?")
              .run(session.metadata.auction_item_id, session.metadata.event_id);
            console.log(`[Stripe] Auction item ${session.metadata.auction_item_id} marked paid`);
          }

          // Walk-up Stripe payments: buyer is standing at the desk, auto-
          // check-in their roster (skip if any check-ins already exist so
          // a repeated webhook fire doesn't duplicate).
          if (session.metadata.walkup === '1') {
            const reg = db.prepare('SELECT players_json FROM registrations WHERE id=?').get(regId);
            const existing = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE registration_id=?').get(regId).n;
            if (reg && existing === 0) {
              let players = [];
              try { players = JSON.parse(reg.players_json || '[]'); } catch {}
              const ins = db.prepare(`INSERT INTO checkins (registration_id, player_index, player_name)
                                      VALUES (?, ?, ?)`);
              players.forEach((p, i) => ins.run(regId, i, p.name));
              console.log(`[Stripe] Walk-up ${regId} auto-checked-in ${players.length} player(s)`);
            }
          }
        }
        break;
      }
      case 'account.updated': {
        const account = event.data.object;
        const adminId = account.metadata && account.metadata.jord_admin_id;
        if (adminId) {
          const s = stripeHelper.mapAccountStatus(account);
          const wasActive = db.prepare('SELECT stripe_account_status FROM admins WHERE id=?').get(adminId)?.stripe_account_status === 'active';
          db.prepare(`UPDATE admins SET
                        stripe_account_status=?,
                        stripe_charges_enabled=?,
                        stripe_payouts_enabled=?,
                        stripe_details_submitted=?,
                        stripe_connected_at = COALESCE(stripe_connected_at, CASE WHEN ?='active' THEN CURRENT_TIMESTAMP END)
                      WHERE id=?`).run(
            s.stripe_account_status, s.stripe_charges_enabled, s.stripe_payouts_enabled,
            s.stripe_details_submitted, s.stripe_account_status, adminId
          );
          if (!wasActive && s.stripe_account_status === 'active') {
            console.log(`[Stripe] Admin ${adminId} Connect account ACTIVATED`);
          }
        }
        break;
      }
      default:
        // No-op for events we don't care about.
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[Stripe webhook] handler failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// 2mb limit so base64-encoded logo uploads (signup + accept) fit in the JSON body.
app.use(express.json({ limit: '2mb' }));
// redirect:false → don't 301 /admin → /admin/ when public/admin/ exists as a dir;
// page routes below handle clean URLs like /admin and /admin/backups themselves.
app.use(express.static('public', { redirect: false }));

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const transporter = SMTP_HOST && SMTP_USER ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
// In-memory store: { key → { count, resetAt } }
// No external package needed — resets on server restart (acceptable for this scale).
const rateLimitStore = new Map();

function rateLimit({ max, windowMs, message }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (entry && now < entry.resetAt) {
      if (entry.count >= max) {
        const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
        res.setHeader('Retry-After', retryAfterSec);
        return res.status(429).json({ error: message, retryAfter: retryAfterSec });
      }
      entry.count++;
    } else {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    }
    next();
  };
}

// Clean up expired entries every 10 minutes so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now >= entry.resetAt) rateLimitStore.delete(key);
  }
}, 10 * 60 * 1000);

const loginLimiter    = rateLimit({ max: 5,  windowMs: 15 * 60 * 1000, message: 'Too many login attempts. Please wait 15 minutes and try again.' });
const forgotLimiter   = rateLimit({ max: 3,  windowMs: 15 * 60 * 1000, message: 'Too many requests. Please wait 15 minutes and try again.' });
const resetLimiter    = rateLimit({ max: 5,  windowMs: 15 * 60 * 1000, message: 'Too many reset attempts. Please wait 15 minutes and try again.' });
const scanLimiter     = rateLimit({ max: 30, windowMs: 60 * 1000, message: 'Too many scans from your device. Please wait 1 minute before scanning again.' });
const registerLimiter = rateLimit({ max: 15, windowMs: 60 * 1000, message: 'Too many registration attempts. Please wait 1 minute before trying again.' });
const alertLimiter    = rateLimit({ max: 20, windowMs: 60 * 1000, message: 'Too many alerts. Please wait 1 minute before reporting another issue.' });

function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const admin = getSessionAdmin(token);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });
  req.admin = admin;
  next();
}

function requireSuper(req, res, next) {
  if (!req.admin || req.admin.role !== 'super') return res.status(403).json({ error: 'Super admin access required' });
  next();
}

// Tournament reps can NEVER perform admin-tier actions (course map edits,
// ending tournaments, deleting events, managing other accounts).
function requireAdminOrSuper(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
  if (req.admin.role !== 'super' && req.admin.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
    if (req.admin.role === 'super') return next();
    if (!req.admin[perm]) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

// Level-aware permission gate for rep view perms (perm_ball_codes, perm_players_teams).
// Levels: 0 = hidden, 1 = view only, 2 = can edit.
//   super / admin → always pass (they manage events through the editor)
//   rep           → passes only if req.admin[perm] >= minLevel
function requirePermLevel(perm, minLevel) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
    if (req.admin.role === 'super' || req.admin.role === 'admin') return next();
    if ((req.admin[perm] || 0) >= minLevel) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}

// ─── USER (personal) AUTH ─────────────────────────────────────────────────────
// Separate from the admin/organizer system above. Token in `x-user-token` header.
function createUserSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO user_sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return token;
}
function getSessionUser(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > datetime('now')
  `).get(token) || null;
}
function requireUser(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.user_token;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
}

// The ball roster powers both the Ball Codes and Players & Teams rep panels,
// so either view permission grants read access to it.
function requireRosterView(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
  if (req.admin.role === 'super' || req.admin.role === 'admin') return next();
  if ((req.admin.perm_ball_codes || 0) >= 1 || (req.admin.perm_players_teams || 0) >= 1) return next();
  return res.status(403).json({ error: 'Permission denied' });
}

// Is `req.admin` allowed to access event `:eventId`?
//   super → always
//   admin → if they own it
//   rep   → if they're assigned to it via event_reps
// Resolves :eventId / :id / :eid path params, or accepts eventId arg.
function hasEventAccess(admin, eventId) {
  if (!admin || !eventId) return false;
  if (admin.role === 'super') return true;
  if (admin.role === 'admin') {
    const ev = db.prepare('SELECT admin_id FROM events WHERE id=?').get(eventId);
    if (ev && ev.admin_id === admin.id) return true;
    // Also granted if explicitly assigned to the event via event_admins
    const row = db.prepare('SELECT 1 FROM event_admins WHERE event_id=? AND admin_id=?').get(eventId, admin.id);
    return !!row;
  }
  if (admin.role === 'rep') {
    const row = db.prepare('SELECT 1 FROM event_reps WHERE event_id=? AND rep_id=?').get(eventId, admin.id);
    return !!row;
  }
  return false;
}

function requireEventAccess(req, res, next) {
  const eventId = req.params.eventId || req.params.id || req.params.eid;
  if (!hasEventAccess(req.admin, eventId)) {
    return res.status(403).json({ error: 'You do not have access to this event' });
  }
  next();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function uid(prefix = '') {
  return prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" (no T, no Z, no ms).
// Comparing against an ISO string is lexically unstable — match the format.
function sqliteDatetimeFromNow(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
}

// Friendly random password — 12 chars, mix of letters + digits, no
// look-alike characters (0/O, 1/l/I) so a tired admin can type it.
function generateAdminPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const buf = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[buf[i] % chars.length];
  return out;
}

function haversineYards(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.09361;
}

function haversineFeet(lat1, lon1, lat2, lon2) {
  return haversineYards(lat1, lon1, lat2, lon2) * 3;
}

/**
 * Calculate perpendicular distance from point to nearest edge of polygon
 * polygon: array of [lon, lat] pairs (GeoJSON order)
 * Returns yards
 */
function perpendicularDistanceToPolygon(pointLat, pointLon, polygonGeoJSON) {
  try {
    const geo = JSON.parse(polygonGeoJSON);
    const rings = [];
    if (geo.type === 'FeatureCollection') {
      for (const f of geo.features) { if (f.geometry?.type === 'Polygon') rings.push(f.geometry.coordinates[0]); }
    } else if (geo.type === 'Polygon') { rings.push(geo.coordinates[0]); }
    let minDist = Infinity;
    for (const coords of rings) {
      for (let i = 0; i < coords.length - 1; i++) {
        const [lon1, lat1] = coords[i];
        const [lon2, lat2] = coords[i+1];
        const dx = lon2 - lon1, dy = lat2 - lat1;
        const lenSq = dx*dx + dy*dy;
        let t = lenSq > 0 ? ((pointLon - lon1)*dx + (pointLat - lat1)*dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const nearLon = lon1 + t*dx, nearLat = lat1 + t*dy;
        const dist = haversineYards(pointLat, pointLon, nearLat, nearLon);
        if (dist < minDist) minDist = dist;
      }
    }
    return minDist === Infinity ? 0 : minDist;
  } catch { return 0; }
}

function pointInPolygon(lat, lon, polygonGeoJSON) {
  try {
    const geo = JSON.parse(polygonGeoJSON);
    const rings = [];
    if (geo.type === 'FeatureCollection') {
      for (const f of geo.features) { if (f.geometry?.type === 'Polygon') rings.push(f.geometry.coordinates[0]); }
    } else if (geo.type === 'Polygon') { rings.push(geo.coordinates[0]); }
    for (const coords of rings) {
      let inside = false;
      for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const [xi, yi] = coords[i];
        const [xj, yj] = coords[j];
        const intersect = ((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  } catch { return false; }
}

/**
 * Calculate final longest drive score
 */
function calcLDScore(event, rawYards, locationType) {
  let penalty = 0;
  if (locationType === 'oob' || locationType === 'lost') {
    if (event.allow_oob) {
      penalty = event.oob_penalty_mode === 'half_hole'
        ? (event.hole_distance_yards / 2)
        : event.oob_fixed_yards;
      return { final: Math.max(0, rawYards - penalty), penalty, raw: rawYards };
    }
    return { final: 0, penalty: 0, raw: rawYards };
  }
  if (locationType === 'rough' && event.allow_rough) {
    // penalty computed at scan time (perpendicular distance)
    return { final: Math.max(0, rawYards - penalty), penalty, raw: rawYards };
  }
  if (locationType === 'fairway') {
    return { final: rawYards, penalty: 0, raw: rawYards };
  }
  return { final: 0, penalty: 0, raw: rawYards };
}

// ─── LEADERBOARD CALCULATION ─────────────────────────────────────────────────
function getLDLeaderboard(eventId) {
  const rows = db.prepare(`
    SELECT t.id, t.team_name, t.registered_at,
      COALESCE(SUM(b.ld_final_yards), 0)                         AS total_yards,
      COALESCE(SUM(b.ld_penalty_yards), 0)                       AS total_penalty,
      COUNT(CASE WHEN b.ld_scanned_at IS NOT NULL THEN 1 END)    AS scanned_count,
      COUNT(CASE WHEN b.ld_location_type='fairway' THEN 1 END)   AS fairway_count,
      COUNT(CASE WHEN b.ld_location_type='rough' THEN 1 END)     AS rough_count,
      COUNT(CASE WHEN b.ld_location_type IN ('oob','lost') THEN 1 END) AS oob_count,
      COUNT(b.drop_code)                                          AS total_balls,
      json_group_array(json_object(
        'drop_code',      b.drop_code,
        'first_name',     b.first_name,
        'last_name',      b.last_name,
        'player_index',   b.player_index,
        'raw_yards',      b.ld_raw_yards,
        'penalty_yards',  b.ld_penalty_yards,
        'final_yards',    b.ld_final_yards,
        'location_type',  b.ld_location_type,
        'lat',            b.ld_lat,
        'lon',            b.ld_lon,
        'scanned',        CASE WHEN b.ld_scanned_at IS NOT NULL THEN 1 ELSE 0 END,
        'manual',         b.ld_manual_entry
      )) AS balls_json
    FROM teams t
    LEFT JOIN balls b ON b.team_id=t.id AND b.event_id=t.event_id
    WHERE t.event_id=?
    GROUP BY t.id
    ORDER BY total_yards DESC
  `).all(eventId);

  return rows.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    team_name: r.team_name,
    total_yards: Math.round(r.total_yards),
    total_penalty: Math.round(r.total_penalty),
    scanned_count: r.scanned_count,
    fairway_count: r.fairway_count,
    rough_count: r.rough_count,
    oob_count: r.oob_count,
    total_balls: r.total_balls,
    balls: JSON.parse(r.balls_json)
      .filter(b => b.drop_code)
      .sort((a, b) => (a.player_index||0) - (b.player_index||0))
      .map(b => ({
        ...b,
        player_name: `${b.first_name||''} ${b.last_name||''}`.trim(),
        final_yards: b.final_yards ? Math.round(b.final_yards) : null,
        raw_yards:   b.raw_yards   ? Math.round(b.raw_yards)   : null,
      }))
  }));
}

function getCPLeaderboard(eventId) {
  const rows = db.prepare(`
    SELECT t.id, t.team_name,
      MIN(CASE WHEN b.cp_valid=1 THEN b.cp_distance_ft END) AS best_ft,
      COUNT(CASE WHEN b.cp_scanned_at IS NOT NULL THEN 1 END) AS scanned,
      COUNT(b.drop_code) AS total,
      json_group_array(json_object(
        'drop_code',    b.drop_code,
        'first_name',   b.first_name,
        'last_name',    b.last_name,
        'player_index', b.player_index,
        'distance_ft',  b.cp_distance_ft,
        'penalty_ft',   COALESCE(b.cp_penalty_ft, 0),
        'valid',        b.cp_valid,
        'lat',          b.cp_lat,
        'lon',          b.cp_lon,
        'scanned',      CASE WHEN b.cp_scanned_at IS NOT NULL THEN 1 ELSE 0 END
      )) AS balls_json
    FROM teams t
    LEFT JOIN balls b ON b.team_id=t.id AND b.event_id=t.event_id
    WHERE t.event_id=?
    GROUP BY t.id
    ORDER BY best_ft ASC NULLS LAST
  `).all(eventId);

  return rows.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    team_name: r.team_name,
    best_ft: r.best_ft ? parseFloat(r.best_ft.toFixed(1)) : null,
    scanned: r.scanned,
    total: r.total,
    balls: JSON.parse(r.balls_json)
      .filter(b => b.drop_code)
      .sort((a, b) => (a.player_index||0) - (b.player_index||0))
      .map(b => ({
        ...b,
        player_name: `${b.first_name||''} ${b.last_name||''}`.trim(),
        distance_ft: b.distance_ft ? parseFloat(b.distance_ft.toFixed(1)) : null,
        penalty_ft:  b.penalty_ft  ? parseFloat(b.penalty_ft.toFixed(1))  : 0,
        raw_ft:      b.distance_ft && b.penalty_ft ? parseFloat((b.distance_ft - b.penalty_ft).toFixed(1)) : (b.distance_ft ? parseFloat(b.distance_ft.toFixed(1)) : null)
      }))
  }));
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Map(); // eventId → Set<res>
function broadcast(eventId) {
  const clients = sseClients.get(eventId);
  if (!clients?.size) return;
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const tee_boxes = db.prepare('SELECT * FROM tee_boxes WHERE event_id=?').all(eventId);
  // brand_logo is a large base64 string — exclude it from the SSE payload (sent
  // on every scan). Pages fetch the logo once on load via /info or /public.
  const { brand_logo, ...eventLite } = event;
  const payload = JSON.stringify({
    event: { ...eventLite, tee_boxes },
    ld:  event.has_longest_drive ? getLDLeaderboard(eventId) : [],
    cp:  event.has_closest_pin   ? getCPLeaderboard(eventId) : [],
    alerts: db.prepare(`SELECT * FROM rep_alerts WHERE event_id=? AND resolved=0 ORDER BY created_at DESC`).all(eventId)
  });
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

// ─── KLAVIYO ─────────────────────────────────────────────────────────────────

// Send a Klaviyo event for one recipient. The event properties carry both the
// raw data AND pre-built SmsText / EmailSubject / EmailBodyHtml so that a
// simple Klaviyo Flow can deliver the message without any template logic.
async function sendEmailDirect(to, subject, html) {
  if (!transporter) {
    console.log(`[Email MOCK] to=${to} subject="${subject}" (set SMTP_HOST/SMTP_USER/SMTP_PASS to enable)`);
    return;
  }
  try {
    await transporter.sendMail({ from: SMTP_USER, to, subject, html });
  } catch (e) { console.error('[Email] send error:', e.message); }
}

async function sendKlaviyo(type, recipient, data) {
  if (!KLAVIYO_KEY) {
    console.log(`[Klaviyo MOCK] ${type} → ${recipient.email || recipient.phone}:`, data.SmsText || data.EmailSubject || '(no message)');
    return;
  }
  try {
    const fetch = require('node-fetch');
    await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-02-15'
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            properties: { ...data, app: 'JORD Golf Tournament' },
            metric: { data: { type: 'metric', attributes: { name: `jord_${type}` } } },
            profile: { data: { type: 'profile', attributes: {
              email:        recipient.email        || undefined,
              phone_number: recipient.phone        || undefined,
              first_name:   recipient.first_name   || undefined,
              last_name:    recipient.last_name     || undefined,
            }}}
          }
        }
      })
    });
    db.prepare('INSERT INTO sms_log (id,event_id,recipient,message,type) VALUES (?,?,?,?,?)')
      .run(uid(), data.event_id || '', recipient.email || recipient.phone || '', data.SmsText || data.EmailSubject || type, type);
  } catch (e) { console.error('[Klaviyo] error:', e.message); }
}

// ── Email design system — cream editorial, matches the live site ────────────
// Email clients don't reliably load web fonts, so display text uses Georgia
// (a serif that stands in for Playfair Display); body uses Helvetica/Arial.
// Palette mirrors public/css/jord.css: cream bg, near-black ink, saffron accent.
function emailBtn(href, label, opts) {
  opts = opts || {};
  const dark = !opts.secondary;
  return `<a href="${href}" style="display:block;background:${dark ? '#1A1A1A' : '#FBF9F4'};`
       + `color:${dark ? '#FBF9F4' : '#1A1A1A'};border:1px solid #1A1A1A;text-align:center;`
       + `padding:15px 18px;border-radius:4px;font-weight:bold;font-size:13px;letter-spacing:0.06em;`
       + `text-transform:uppercase;text-decoration:none;margin:0 0 12px;`
       + `font-family:Helvetica,Arial,sans-serif">${label}</a>`;
}

function emailBox(opts) {
  // opts: { label, value, note, big, accent, mono }
  const valColor = opts.accent ? '#B8884D' : '#1A1A1A';
  const valSize  = opts.big ? '46px' : '24px';
  const valFont  = opts.mono ? "'Courier New',monospace" : "Georgia,'Times New Roman',serif";
  return `<div style="background:#ECE7DB;border-radius:6px;padding:20px;margin:0 0 14px;text-align:center">`
       + `<div style="font-size:11px;font-weight:bold;letter-spacing:0.16em;text-transform:uppercase;color:#8A8479;margin:0 0 6px">${opts.label}</div>`
       + `<div style="font-family:${valFont};font-size:${valSize};font-weight:bold;color:${valColor};line-height:1.15;${opts.mono ? 'letter-spacing:2px;' : ''}">${opts.value}</div>`
       + (opts.note ? `<div style="font-size:13px;color:#5C5852;line-height:1.5;margin:8px 0 0">${opts.note}</div>` : '')
       + `</div>`;
}

function emailShell(opts) {
  // opts: { eyebrow, heading, subhead, bodyHtml }
  return `
<div style="margin:0;padding:0;background:#F5F2EB;width:100%">
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 18px">
    <div style="text-align:center;margin:0 0 22px">
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;color:#1A1A1A;letter-spacing:0.02em">JORD <span style="font-style:italic;color:#B8884D">Golf</span></span>
    </div>
    <div style="background:#FBF9F4;border:1px solid #E4DDCE;border-radius:8px;padding:30px 26px">
      ${opts.eyebrow ? `<div style="font-size:11px;font-weight:bold;letter-spacing:0.18em;text-transform:uppercase;color:#8A8479;margin:0 0 10px">${opts.eyebrow}</div>` : ''}
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:bold;color:#1A1A1A;line-height:1.25;margin:0 0 ${opts.subhead ? '8px' : '20px'}">${opts.heading}</h1>
      ${opts.subhead ? `<p style="font-size:14px;color:#5C5852;line-height:1.5;margin:0 0 22px">${opts.subhead}</p>` : ''}
      ${opts.bodyHtml}
    </div>
    <p style="text-align:center;color:#8A8479;font-size:12px;margin:18px 0 0">JORD Golf &middot; <span style="font-style:italic">The new traditional</span><span style="color:#B8884D">*</span></p>
  </div>
</div>`.trim();
}

// ── Message builders ────────────────────────────────────────────────────────

function msgRegistration({ firstName, teamName, eventName, venue, dropCode, leaderboardUrl, scanUrl, adminPhone }) {
  const sms =
    `⛳ You're in, ${firstName}! "${teamName}" is registered for ${eventName} at ${venue}. ` +
    `Submit your shot when at the ball: ${scanUrl} | Live leaderboard: ${leaderboardUrl}` +
    (adminPhone ? ` | Questions? Call: ${adminPhone}` : '');

  const bodyHtml =
      emailBox({ label: 'Your Team', value: teamName })
    + emailBox({ label: 'Your Ball Code', value: dropCode, mono: true, note: 'You\'ll need this on course to submit your shot — keep it handy.' })
    + `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">When you reach your ball on course, tap below to capture your GPS location.</p>`
    + emailBtn(scanUrl, '📍 Get My Ball Location')
    + emailBtn(leaderboardUrl, 'Watch the Live Leaderboard', { secondary: true })
    + (adminPhone ? `<p style="text-align:center;color:#8A8479;font-size:13px;margin:14px 0 0">Need help on course? Call your JORD rep: <strong style="color:#1A1A1A">${adminPhone}</strong></p>` : '');

  const emailHtml = emailShell({
    eyebrow: `${eventName} · ${venue}`,
    heading: `You're in, <span style="font-style:italic;color:#B8884D">${firstName}</span>.`,
    subhead: 'Your team is registered. Here\'s everything you need for the day.',
    bodyHtml,
  });

  return { SmsText: sms, EmailSubject: `You're registered for ${eventName}`, EmailBodyHtml: emailHtml };
}

// New admin account created + assigned to an event — includes temp password.
function msgAdminWelcome({ name, eventName, venue, email, tempPassword, loginUrl }) {
  const sms =
    `Welcome to JORD Golf, ${name}! Your tournament admin account for ${eventName} is ready. ` +
    `Sign in at ${loginUrl} — email: ${email}, temporary password: ${tempPassword}. Please change it after your first login.`;
  const bodyHtml =
      `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">You're set up to manage <strong style="color:#1A1A1A">${eventName}</strong>${venue ? ` — ${venue}` : ''}. Sign in below, then change your password from the account menu.</p>`
    + emailBox({ label: 'Your Login Email', value: `<span style="font-size:17px">${email}</span>` })
    + emailBox({ label: 'Temporary Password', value: tempPassword, mono: true, accent: true, note: 'Change this right after your first sign-in (🔐 Password in the admin panel).' })
    + emailBtn(loginUrl, 'Sign In to the Admin Panel');
  const emailHtml = emailShell({
    eyebrow: 'Welcome to JORD Golf',
    heading: `Welcome aboard, <span style="font-style:italic;color:#B8884D">${name}</span>.`,
    bodyHtml,
  });
  return { SmsText: sms, EmailSubject: `Your JORD Golf admin account — ${eventName}`, EmailBodyHtml: emailHtml };
}

// Existing admin assigned to an additional event — no password (they already have one).
function msgAdminAssigned({ name, eventName, venue, loginUrl }) {
  const sms =
    `${name}, you've been added as an admin for ${eventName}${venue ? ` at ${venue}` : ''}. ` +
    `It's now in your events list — sign in at ${loginUrl}.`;
  const bodyHtml =
      `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">You've been added as an admin for <strong style="color:#1A1A1A">${eventName}</strong>${venue ? ` — ${venue}` : ''}. It now appears in your events list — sign in with your existing credentials to manage it.</p>`
    + emailBtn(loginUrl, 'Open the Admin Panel');
  const emailHtml = emailShell({
    eyebrow: 'New event assigned',
    heading: `You've got a new event, <span style="font-style:italic;color:#B8884D">${name}</span>.`,
    bodyHtml,
  });
  return { SmsText: sms, EmailSubject: `You've been added to ${eventName} on JORD Golf`, EmailBodyHtml: emailHtml };
}

// Generic account welcome (used for tournament reps) — temp password + login.
function msgAccountWelcome({ name, roleLabel, email, tempPassword, loginUrl }) {
  const sms =
    `Welcome to JORD Golf, ${name}! Your ${roleLabel} account is ready. ` +
    `Sign in at ${loginUrl} — email: ${email}, temporary password: ${tempPassword}. Please change it after your first login.`;
  const bodyHtml =
      `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">A <strong style="color:#1A1A1A">${roleLabel}</strong> account has been created for you on JORD Golf Tournaments. Sign in below, then change your password from the account menu.</p>`
    + emailBox({ label: 'Your Login Email', value: `<span style="font-size:17px">${email}</span>` })
    + emailBox({ label: 'Temporary Password', value: tempPassword, mono: true, accent: true, note: 'Change this right after your first sign-in.' })
    + emailBtn(loginUrl, 'Sign In');
  const emailHtml = emailShell({
    eyebrow: 'Welcome to JORD Golf',
    heading: `Welcome aboard, <span style="font-style:italic;color:#B8884D">${name}</span>.`,
    bodyHtml,
  });
  return { SmsText: sms, EmailSubject: `Your JORD Golf ${roleLabel} account`, EmailBodyHtml: emailHtml };
}

// Password reset link (admins + reps).
function msgPasswordReset({ name, resetUrl }) {
  const bodyHtml =
      `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 20px">Tap below to set a new password. This link expires in 24 hours. If you didn't request a reset, you can safely ignore this email.</p>`
    + emailBtn(resetUrl, 'Reset My Password')
    + `<p style="font-size:12px;color:#8A8479;line-height:1.5;margin:14px 0 0;word-break:break-all">Or paste this link into your browser:<br>${resetUrl}</p>`;
  const emailHtml = emailShell({
    eyebrow: 'Account security',
    heading: 'Reset your password',
    subhead: name ? `Hi ${name},` : '',
    bodyHtml,
  });
  return { EmailSubject: 'Reset your JORD Golf password', EmailBodyHtml: emailHtml };
}

// Public /signup form — auto-reply to the person who submitted the request.
function msgSignupReceived({ name, tournamentName }) {
  const bodyHtml =
      `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 16px">Thanks${name ? ', ' + name : ''} — we've received your request to run <strong style="color:#1A1A1A">${tournamentName}</strong> on JORD Golf.</p>`
    + `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 16px">Our team will review it and reach out shortly to get you set up before your first tee time.</p>`
    + `<p style="font-size:13px;color:#8A8479;line-height:1.5;margin:0">Questions in the meantime? Just reply to this email.</p>`;
  const emailHtml = emailShell({
    eyebrow: 'Tournament request received',
    heading: 'Thanks for reaching out.',
    bodyHtml,
  });
  return { EmailSubject: `We got your request — ${tournamentName}`, EmailBodyHtml: emailHtml };
}

// Player 1 just created a team — receipt with the join code so they can invite teammates.
function msgTeamCreated({ firstName, teamName, eventName, shareCode, joinUrl, teamPageUrl }) {
  const sms =
    `⛳ ${firstName}, team "${teamName}" is created for ${eventName}! ` +
    `Teammates join with code ${shareCode} or this link: ${joinUrl}`;
  const bodyHtml =
      emailBox({ label: 'Your Team', value: teamName })
    + emailBox({ label: 'Team Join Code', value: shareCode, mono: true, accent: true, note: 'Teammates enter this code — or scan your team QR — to join.' })
    + `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">Open your team page to see who's joined, share the invite link, and pull up the QR code.</p>`
    + emailBtn(teamPageUrl, '👥 View Team Page & Invite Players')
    + `<p style="font-size:12px;color:#8A8479;line-height:1.5;margin:14px 0 0;word-break:break-all">Invite link:<br>${joinUrl}</p>`;
  const emailHtml = emailShell({
    eyebrow: eventName,
    heading: `Team <span style="font-style:italic;color:#B8884D">${teamName}</span> is set.`,
    subhead: 'Now bring your teammates in.',
    bodyHtml,
  });
  return { SmsText: sms, EmailSubject: `Team "${teamName}" is ready — invite your players`, EmailBodyHtml: emailHtml };
}

// Notify an admin that they've been added to an event (Klaviyo event + direct email).
// `kind` is 'welcome' (new account, temp password) or 'assigned' (existing admin).
async function notifyAdminAssignment(kind, { name, email, eventName, venue, eventId, tempPassword }) {
  if (!email) return;
  const loginUrl = `${APP_URL}/admin`;
  const msg = kind === 'welcome'
    ? msgAdminWelcome({ name, eventName, venue, email, tempPassword, loginUrl })
    : msgAdminAssigned({ name, eventName, venue, loginUrl });
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  try {
    await sendKlaviyo(kind === 'welcome' ? 'admin_welcome' : 'admin_assigned',
      { email, first_name: first || name, last_name: rest.join(' ') },
      { ...msg, event_id: eventId });
  } catch (e) { console.error('[Notify] admin assignment error:', e.message); }
}

function msgLDScan({ firstName, teamName, eventName, venue, finalYards, rawYards, penaltyYards, locationType, teamRank, teamTotalYards, leaderboardUrl }) {
  const locLabel = { fairway: 'fairway ✅', rough: 'rough', oob: 'out of bounds', lost: 'lost ball' }[locationType] || locationType;
  const scored   = Math.round(finalYards);
  const raw      = Math.round(rawYards);
  const pen      = Math.round(penaltyYards);
  const rankText = teamRank === 1 ? '🥇 Your team is LEADING!' : `Your team is ranked #${teamRank}`;
  const penNote  = pen > 0 ? ` (${raw} raw − ${pen} penalty)` : '';

  const sms =
    `📍 ${firstName}, you hit ${scored} yards${penNote} in the ${locLabel} at ${eventName}! ` +
    `${rankText} with ${Math.round(teamTotalYards)} total yards. ` +
    `Leaderboard: ${leaderboardUrl}`;

  const subject = `Your drive: ${scored} yards at ${eventName}`;

  const penNoteHtml = pen > 0 ? `${raw} yd raw − ${pen} yd penalty (${locLabel})` : null;
  const bodyHtml =
      emailBox({ label: 'Your Distance', value: scored + ' <span style="font-size:18px;font-weight:normal;color:#5C5852">yd</span>', big: true, accent: true, note: penNoteHtml })
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr>`
    + `<td width="33%" style="padding:0 5px"><div style="background:#ECE7DB;border-radius:6px;padding:14px 8px;text-align:center"><div style="font-size:10px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#8A8479;margin:0 0 4px">Location</div><div style="font-size:14px;font-weight:bold;color:#1A1A1A">${locLabel}</div></div></td>`
    + `<td width="33%" style="padding:0 5px"><div style="background:#ECE7DB;border-radius:6px;padding:14px 8px;text-align:center"><div style="font-size:10px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#8A8479;margin:0 0 4px">Team Rank</div><div style="font-size:14px;font-weight:bold;color:${teamRank === 1 ? '#B8884D' : '#1A1A1A'}">${teamRank === 1 ? '🥇 #1' : '#' + teamRank}</div></div></td>`
    + `<td width="33%" style="padding:0 5px"><div style="background:#ECE7DB;border-radius:6px;padding:14px 8px;text-align:center"><div style="font-size:10px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#8A8479;margin:0 0 4px">Team Total</div><div style="font-size:14px;font-weight:bold;color:#1A1A1A">${Math.round(teamTotalYards)} yd</div></div></td>`
    + `</tr></table>`
    + emailBtn(leaderboardUrl, '📊 View Live Leaderboard');

  const emailHtml = emailShell({
    eyebrow: `${eventName} · ${venue}`,
    heading: `Nice swing, <span style="font-style:italic;color:#B8884D">${firstName}</span>.`,
    subhead: teamRank === 1 ? 'Your team is leading — keep it going.' : 'Your drive is on the board.',
    bodyHtml,
  });

  return { SmsText: sms, EmailSubject: subject, EmailBodyHtml: emailHtml };
}

function msgCTPScan({ firstName, teamName, eventName, venue, distanceFt, onGreen, isLeader, teamRank, leaderboardUrl }) {
  const ft       = distanceFt.toFixed(1);
  const greenNote = onGreen ? '' : ' (off green — penalty applied)';
  const rankText  = isLeader ? '🥇 Your team is leading!' : `Your team is ranked #${teamRank}`;

  const sms =
    `📍 ${firstName}, you landed ${ft} feet from the pin${greenNote} at ${eventName}! ` +
    `${rankText} Leaderboard: ${leaderboardUrl}`;

  const subject = `Your CTP result: ${ft} ft at ${eventName}`;

  const bodyHtml =
      emailBox({ label: 'Distance to Pin', value: ft + ' <span style="font-size:18px;font-weight:normal;color:#5C5852">ft</span>', big: true, accent: true,
                 note: onGreen ? null : '⚠️ Off green — penalty applied' })
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr>`
    + `<td width="50%" style="padding:0 5px"><div style="background:#ECE7DB;border-radius:6px;padding:14px 8px;text-align:center"><div style="font-size:10px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#8A8479;margin:0 0 4px">Team</div><div style="font-size:14px;font-weight:bold;color:#1A1A1A">${teamName}</div></div></td>`
    + `<td width="50%" style="padding:0 5px"><div style="background:#ECE7DB;border-radius:6px;padding:14px 8px;text-align:center"><div style="font-size:10px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#8A8479;margin:0 0 4px">Standing</div><div style="font-size:14px;font-weight:bold;color:${isLeader ? '#B8884D' : '#1A1A1A'}">${isLeader ? '🥇 Leading' : '#' + teamRank}</div></div></td>`
    + `</tr></table>`
    + emailBtn(leaderboardUrl, '📊 View Live Leaderboard');

  const emailHtml = emailShell({
    eyebrow: `${eventName} · ${venue}`,
    heading: `Closest to the pin, <span style="font-style:italic;color:#B8884D">${firstName}</span>.`,
    subhead: isLeader ? 'Your team is leading the pin contest.' : 'Your shot is on the board.',
    bodyHtml,
  });

  return { SmsText: sms, EmailSubject: subject, EmailBodyHtml: emailHtml };
}

function msgTournamentEnded({ firstName, teamName, eventName, venue, winnerTeam, playerYards, playerFt, dashboardUrl, isLD }) {
  const resultText = isLD
    ? (playerYards ? `You hit ${Math.round(playerYards)} yards.` : '')
    : (playerFt    ? `You finished ${playerFt.toFixed(1)} feet from the pin.` : '');

  const sms =
    `🏆 ${eventName} is a wrap! "${winnerTeam}" took the title. ${resultText} ` +
    `See your full results: ${dashboardUrl}`;

  const subject = `Your results from ${eventName}`;

  const bodyHtml =
      emailBox({ label: 'Champion', value: '🥇 ' + winnerTeam, accent: true })
    + (resultText
        ? emailBox({ label: `Your Result, ${firstName}`, value: resultText, note: 'Team: ' + teamName })
        : '')
    + emailBtn(dashboardUrl, '📊 See Your Full Results')
    + `<p style="text-align:center;color:#5C5852;font-size:14px;margin:14px 0 0">Thanks for playing with JORD Golf.</p>`;

  const emailHtml = emailShell({
    eyebrow: `${eventName} · ${venue}`,
    heading: `That's a <span style="font-style:italic;color:#B8884D">wrap</span>.`,
    subhead: 'The tournament is complete — here\'s how it finished.',
    bodyHtml,
  });

  return { SmsText: sms, EmailSubject: subject, EmailBodyHtml: emailHtml };
}

async function subscribeKlaviyo({ email, phone, firstName, lastName, emailOptIn, smsOptIn }) {
  if (!KLAVIYO_KEY) {
    console.log(`[Klaviyo MOCK] subscribe email=${emailOptIn} sms=${smsOptIn} for ${email || phone}`);
    return;
  }
  const jobs = [];
  if (emailOptIn && email && KLAVIYO_EMAIL_LIST) {
    jobs.push(fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: { 'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`, 'Content-Type': 'application/json', 'revision': '2024-02-15' },
      body: JSON.stringify({ data: { type: 'profile-subscription-bulk-create-job',
        attributes: { profiles: { data: [{ type: 'profile', attributes: {
          email, first_name: firstName, last_name: lastName,
          subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } }
        }}]}},
        relationships: { list: { data: { type: 'list', id: KLAVIYO_EMAIL_LIST } } }
      }})
    }).catch(e => console.error('Klaviyo email sub error:', e.message)));
  }
  if (smsOptIn && phone && KLAVIYO_SMS_LIST) {
    jobs.push(fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: { 'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`, 'Content-Type': 'application/json', 'revision': '2024-02-15' },
      body: JSON.stringify({ data: { type: 'profile-subscription-bulk-create-job',
        attributes: { profiles: { data: [{ type: 'profile', attributes: {
          phone_number: phone, first_name: firstName, last_name: lastName,
          subscriptions: { sms: { marketing: { consent: 'SUBSCRIBED' } } }
        }}]}},
        relationships: { list: { data: { type: 'list', id: KLAVIYO_SMS_LIST } } }
      }})
    }).catch(e => console.error('Klaviyo SMS sub error:', e.message)));
  }
  await Promise.all(jobs);
}

async function checkLeadershipChange(eventId, newLB) {
  if (!newLB.length) return;
  const leader = newLB[0];
  const prev   = db.prepare('SELECT notified_lead FROM teams WHERE id=?').get(leader.id);
  if (!prev) return;

  const lbUrl = `${APP_URL}/leaderboard/${eventId}`;

  const allTeams = db.prepare('SELECT * FROM teams WHERE event_id=?').all(eventId);
  for (const team of allTeams) {
    if (team.id !== leader.id && team.notified_lead) {
      const balls = db.prepare('SELECT * FROM balls WHERE team_id=? AND event_id=?').all(team.id, eventId);
      const taunts = [
        `Rough news — they might have had a tailwind... or maybe they're just better. Either way, time to regroup.`,
        `Your reign was beautiful while it lasted. The leaderboard waits for no one.`,
        `They'd like you to know they hit it farther. We're just the messenger. Don't shoot us.`,
      ];
      const taunt = taunts[Math.floor(Math.random() * taunts.length)];
      const yards  = Math.round(leader.total_yards);

      for (const b of balls.filter(b => b.email || b.phone)) {
        const sms = `👑 ${b.first_name}, you've been knocked off #1! "${leader.team_name}" just took the lead with ${yards} total yards. Fight back: ${lbUrl}`;

        const emailHtml = emailShell({
          eyebrow: 'Leaderboard update',
          heading: `You've been <span style="font-style:italic;color:#B8884D">dethroned</span>.`,
          subhead: `Hey ${b.first_name} — someone just took the top spot.`,
          bodyHtml:
              emailBox({ label: 'New #1 Team', value: leader.team_name, note: yards + ' total yards', accent: true })
            + `<div style="background:#ECE7DB;border-left:3px solid #B8884D;border-radius:4px;padding:16px 18px;margin:0 0 16px"><p style="font-size:14px;color:#5C5852;font-style:italic;line-height:1.5;margin:0">"${taunt}"</p></div>`
            + emailBtn(lbUrl, '📊 See the Live Leaderboard'),
        });

        await sendKlaviyo('dethroned',
          { email: b.email, phone: b.phone, first_name: b.first_name, last_name: b.last_name },
          { SmsText: sms, EmailSubject: `👑 You've been knocked off #1, ${b.first_name}!`, EmailBodyHtml: emailHtml, event_id: eventId }
        );
      }
      db.prepare('UPDATE teams SET notified_lead=0 WHERE id=?').run(team.id);
    }
  }
  db.prepare('UPDATE teams SET notified_lead=1 WHERE id=?').run(leader.id);
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const admin = db.prepare('SELECT * FROM admins WHERE email=? AND active=1').get(email.toLowerCase().trim());
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = createSession(admin.id);
  res.json({
    token,
    id:   admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    perm_corrections:      admin.perm_corrections,
    perm_end_tournament:   admin.perm_end_tournament,
    perm_manage_players:   admin.perm_manage_players,
    perm_manage_balls:     admin.perm_manage_balls,
    perm_resolve_alerts:   admin.perm_resolve_alerts,
    perm_reset_scans:      admin.perm_reset_scans,
    perm_register_walkups: admin.perm_register_walkups,
    perm_view_leaderboard: admin.perm_view_leaderboard,
    perm_ball_codes:       admin.perm_ball_codes,
    perm_players_teams:    admin.perm_players_teams,
    parent_admin_id:       admin.parent_admin_id || null,
    // For reps: list of event IDs they're assigned to (lets the frontend route them on login)
    assigned_event_ids: admin.role === 'rep'
      ? db.prepare('SELECT event_id FROM event_reps WHERE rep_id=?').all(admin.id).map(r => r.event_id)
      : null,
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const a = req.admin;
  res.json({
    id: a.id, name: a.name, email: a.email, role: a.role,
    perm_corrections:      a.perm_corrections,
    perm_end_tournament:   a.perm_end_tournament,
    perm_manage_players:   a.perm_manage_players,
    perm_manage_balls:     a.perm_manage_balls,
    perm_resolve_alerts:   a.perm_resolve_alerts,
    perm_reset_scans:      a.perm_reset_scans,
    perm_register_walkups: a.perm_register_walkups,
    perm_view_leaderboard: a.perm_view_leaderboard,
    perm_ball_codes:       a.perm_ball_codes,
    perm_players_teams:    a.perm_players_teams,
    parent_admin_id:       a.parent_admin_id || null,
    assigned_event_ids: a.role === 'rep'
      ? db.prepare('SELECT event_id FROM event_reps WHERE rep_id=?').all(a.id).map(r => r.event_id)
      : null,
  });
});

app.post('/api/auth/forgot-password', forgotLimiter, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const admin = db.prepare('SELECT * FROM admins WHERE email=? AND active=1').get(email.toLowerCase().trim());
  if (!admin) return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = sqliteDatetimeFromNow(60 * 60 * 1000); // 1 hour
  db.prepare('INSERT INTO password_reset_tokens (token,admin_id,expires_at) VALUES (?,?,?)').run(token, admin.id, expires);
  const resetUrl = `${APP_URL}/admin?reset_token=${token}`;
  // Fire a Klaviyo event so the jord_password_reset Flow emails the link
  // (non-blocking). _reset_url is still returned so a super admin can share
  // it manually as a fallback.
  setImmediate(async () => {
    try {
      const m = msgPasswordReset({ name: admin.name, resetUrl });
      const [first, ...rest] = String(admin.name || '').trim().split(/\s+/);
      await sendKlaviyo('password_reset',
        { email: admin.email, first_name: first || admin.name, last_name: rest.join(' ') },
        { ...m, reset_url: resetUrl });
    } catch (e) { console.error('[Klaviyo] password-reset send error:', e.message); }
  });
  res.json({ success: true, message: 'If that email exists, a reset link has been sent.', _reset_url: resetUrl });
});

app.post('/api/auth/forgot-username', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const admin = db.prepare("SELECT email FROM admins WHERE name LIKE ? AND active=1").get(`%${name.trim()}%`);
  if (!admin) return res.json({ success: true, hint: null });
  const [user, domain] = admin.email.split('@');
  const masked = user.slice(0, 2) + '***@' + domain;
  res.json({ success: true, hint: masked });
});

// Self-serve password change — any logged-in admin can change their own password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const fullAdmin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
  if (!fullAdmin || !verifyPassword(current_password, fullAdmin.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(new_password), req.admin.id);
  // Keep current session alive — only invalidate OTHER sessions for this admin.
  const currentToken = req.headers['x-admin-token'] || req.query.token;
  db.prepare('DELETE FROM sessions WHERE admin_id=? AND token!=?').run(req.admin.id, currentToken);
  res.json({ success: true });
});

app.post('/api/auth/reset-password', resetLimiter, (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token=? AND used=0 AND expires_at > datetime('now')").get(token);
  if (!row) return res.status(400).json({ error: 'Reset link is invalid or has expired' });
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(password), row.admin_id);
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE token=?').run(token);
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(row.admin_id); // invalidate all sessions
  res.json({ success: true, message: 'Password updated. Please log in again.' });
});

// ─── ADMIN MANAGEMENT (super only) ───────────────────────────────────────────

// Column sets used in admin/rep SELECTs and PATCH validators
const ADMIN_COLS = 'id,name,email,role,active,perm_corrections,perm_end_tournament,perm_manage_players,perm_manage_balls,perm_resolve_alerts,perm_reset_scans,perm_register_walkups,perm_view_leaderboard,perm_ball_codes,perm_players_teams,parent_admin_id,created_at';

app.get('/api/admins', requireAuth, requireSuper, (req, res) => {
  // Super-admin view: super + admin rows only. Reps are managed under /api/reps.
  const admins = db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE role IN ('super','admin') ORDER BY created_at ASC`).all();
  const resets = db.prepare("SELECT * FROM password_reset_tokens WHERE used=0 AND expires_at > datetime('now') ORDER BY created_at DESC").all();
  const resetMap = {};
  for (const r of resets) resetMap[r.admin_id] = r;
  res.json(admins.map(a => ({ ...a, pending_reset: resetMap[a.id] || null })));
});

app.post('/api/admins', requireAuth, requireSuper, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  // Password is optional — if absent, generate a temp one and return it so super admin can share it.
  let finalPassword = password;
  let generated = false;
  if (!finalPassword) {
    finalPassword = generateAdminPassword();
    generated = true;
  } else if (finalPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = db.prepare('SELECT id FROM admins WHERE email=?').get(email.toLowerCase().trim());
  if (existing) return res.status(400).json({ error: 'An admin with that email already exists' });
  const id = uid('ADM');
  // This endpoint is super-only and creates super/admin. Rep creation goes through /api/reps.
  db.prepare('INSERT INTO admins (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), email.toLowerCase().trim(), hashPassword(finalPassword), role === 'super' ? 'super' : 'admin');
  const created = db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(id);
  // Only echo the password when we generated it — never echo back a password the caller supplied.
  res.json({ ...created, ...(generated ? { temp_password: finalPassword } : {}) });
});

app.patch('/api/admins/:id', requireAuth, requireSuper, (req, res) => {
  const allowed = ['name','email','role','active','perm_corrections','perm_end_tournament','perm_manage_players','perm_manage_balls','perm_resolve_alerts','perm_reset_scans','perm_register_walkups'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  const target = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found' });

  // Guard: can't demote or deactivate the last active super admin
  const newRole = updates.find(([k]) => k === 'role')?.[1];
  const newActive = updates.find(([k]) => k === 'active')?.[1];
  const wouldLoseSuper = (newRole !== undefined && newRole !== 'super' && target.role === 'super')
                     || (newActive !== undefined && !newActive && target.role === 'super');
  if (wouldLoseSuper) {
    const otherSupers = db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role='super' AND active=1 AND id!=?").get(req.params.id).n;
    if (otherSupers === 0) return res.status(400).json({ error: 'Cannot change role or deactivate the last super admin' });
  }
  // Guard: can't deactivate yourself (would lock you out)
  if (target.id === req.admin.id && newActive !== undefined && !newActive) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  db.prepare(`UPDATE admins SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v]) => v), req.params.id);
  res.json(db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(req.params.id));
});

app.delete('/api/admins/:id', requireAuth, requireSuper, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  if (admin.id === req.admin.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (admin.role === 'super' && db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role='super' AND active=1").get().n <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last super admin' });
  }
  // Clear every row that references this admin BEFORE deleting (FK constraint).
  // events.admin_id has no FK constraint but we still null it out so events
  // owned by the deleted admin show "creator unknown" instead of a stale id.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE admin_id=?').run(req.params.id);
    db.prepare('DELETE FROM password_reset_tokens WHERE admin_id=?').run(req.params.id);
    db.prepare('UPDATE events SET admin_id=NULL WHERE admin_id=?').run(req.params.id);
    db.prepare('DELETE FROM admins WHERE id=?').run(req.params.id);
  });
  try {
    tx();
    res.json({ success: true });
  } catch (e) {
    console.error('[Admin Delete Error]', e);
    res.status(500).json({ error: 'Failed to delete admin: ' + e.message });
  }
});

app.post('/api/admins/:id/reset-password', requireAuth, requireSuper, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = sqliteDatetimeFromNow(24 * 60 * 60 * 1000); // 24 hours
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE admin_id=? AND used=0').run(req.params.id); // invalidate old tokens
  db.prepare('INSERT INTO password_reset_tokens (token,admin_id,expires_at) VALUES (?,?,?)').run(token, req.params.id, expires);
  const resetUrl = `${APP_URL}/admin?reset_token=${token}`;
  setImmediate(async () => {
    try {
      const m = msgPasswordReset({ name: admin.name, resetUrl });
      const [first, ...rest] = String(admin.name || '').trim().split(/\s+/);
      await sendKlaviyo('password_reset',
        { email: admin.email, first_name: first || admin.name, last_name: rest.join(' ') },
        { ...m, reset_url: resetUrl });
    } catch (e) { console.error('[Klaviyo] admin password-reset send error:', e.message); }
  });
  res.json({ success: true, reset_url: resetUrl });
});

app.patch('/api/admins/:id/password', requireAuth, requireSuper, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(password), req.params.id);
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── TOURNAMENT REPS (admin or super) ────────────────────────────────────────
// Admins can manage reps they created (parent_admin_id = self).
// Supers can manage all reps.

// Scope helper — reps `req.admin` is allowed to see/edit.
function repIsManageable(admin, repRow) {
  if (!repRow || repRow.role !== 'rep') return false;
  if (admin.role === 'super') return true;
  if (admin.role === 'admin' && repRow.parent_admin_id === admin.id) return true;
  return false;
}

// List reps (admins see only their own; super sees all)
app.get('/api/reps', requireAuth, requireAdminOrSuper, (req, res) => {
  const isSuper = req.admin.role === 'super';
  const reps = isSuper
    ? db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE role='rep' ORDER BY created_at ASC`).all()
    : db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE role='rep' AND parent_admin_id=? ORDER BY created_at ASC`).all(req.admin.id);
  // For each rep, attach the events they're assigned to (names + ids)
  const assignStmt = db.prepare('SELECT er.event_id, e.name FROM event_reps er LEFT JOIN events e ON e.id=er.event_id WHERE er.rep_id=?');
  const resetStmt  = db.prepare("SELECT * FROM password_reset_tokens WHERE admin_id=? AND used=0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1");
  res.json(reps.map(r => ({
    ...r,
    assigned_events: assignStmt.all(r.id),
    pending_reset:   resetStmt.get(r.id) || null,
  })));
});

// Create a rep
app.post('/api/reps', requireAuth, requireAdminOrSuper, (req, res) => {
  const { name, email, password,
          perm_corrections, perm_resolve_alerts, perm_reset_scans, perm_register_walkups,
          perm_view_leaderboard, perm_ball_codes, perm_players_teams } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  // Clamp a level perm to 0..max (0 = off, 1 = view, 2 = edit)
  const lvl = (v, max) => Math.min(Math.max(parseInt(v, 10) || 0, 0), max);

  let finalPassword = password;
  let generated = false;
  if (!finalPassword) {
    finalPassword = generateAdminPassword();
    generated = true;
  } else if (finalPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM admins WHERE email=?').get(email.toLowerCase().trim());
  if (existing) return res.status(400).json({ error: 'An account with that email already exists' });

  const id = uid('REP');
  // parent_admin_id: if super created the rep, parent stays null (or could be specified later).
  // If admin created, parent = self.
  const parent = req.admin.role === 'admin' ? req.admin.id : (req.body.parent_admin_id || null);
  db.prepare(`INSERT INTO admins
    (id, name, email, password_hash, role, parent_admin_id,
     perm_corrections, perm_end_tournament, perm_manage_players, perm_manage_balls,
     perm_resolve_alerts, perm_reset_scans, perm_register_walkups,
     perm_view_leaderboard, perm_ball_codes, perm_players_teams)
    VALUES (?,?,?,?, 'rep', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      name.trim(),
      email.toLowerCase().trim(),
      hashPassword(finalPassword),
      parent,
      perm_corrections      ? 1 : 0,
      perm_resolve_alerts   ? 1 : 0,
      perm_reset_scans      ? 1 : 0,
      perm_register_walkups ? 1 : 0,
      lvl(perm_view_leaderboard, 1),
      lvl(perm_ball_codes, 2),
      lvl(perm_players_teams, 2),
    );

  const created = db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(id);

  // Email the new rep their welcome + temp password via Klaviyo (non-blocking).
  setImmediate(async () => {
    try {
      const m = msgAccountWelcome({
        name: name.trim(), roleLabel: 'Tournament Rep',
        email: email.toLowerCase().trim(), tempPassword: finalPassword,
        loginUrl: `${APP_URL}/admin`,
      });
      const [first, ...rest] = name.trim().split(/\s+/);
      await sendKlaviyo('account_welcome',
        { email: email.toLowerCase().trim(), first_name: first || name.trim(), last_name: rest.join(' ') },
        { ...m, role: 'rep' });
    } catch (e) { console.error('[Klaviyo] rep welcome send error:', e.message); }
  });

  res.json({ ...created, ...(generated ? { temp_password: finalPassword } : {}) });
});

// Update rep fields (name, email, active, the four rep perms)
app.patch('/api/reps/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!repIsManageable(req.admin, target)) return res.status(404).json({ error: 'Rep not found' });
  const allowed = ['name','email','active','perm_corrections','perm_resolve_alerts','perm_reset_scans','perm_register_walkups',
                   'perm_view_leaderboard','perm_ball_codes','perm_players_teams'];
  const levelMax = { perm_view_leaderboard: 1, perm_ball_codes: 2, perm_players_teams: 2 };
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  const coerce = (k, v) => {
    if (k in levelMax) return Math.min(Math.max(parseInt(v, 10) || 0, 0), levelMax[k]);
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  };
  db.prepare(`UPDATE admins SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([k, v]) => coerce(k, v)), req.params.id);
  res.json(db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(req.params.id));
});

// Delete a rep
app.delete('/api/reps/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!repIsManageable(req.admin, target)) return res.status(404).json({ error: 'Rep not found' });
  db.prepare('DELETE FROM event_reps WHERE rep_id=?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(req.params.id);
  db.prepare('DELETE FROM admins WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Reset rep password (generates a reset link / temp pwd, same pattern as admin reset)
app.post('/api/reps/:id/reset-password', requireAuth, requireAdminOrSuper, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!repIsManageable(req.admin, target)) return res.status(404).json({ error: 'Rep not found' });
  const token = require('crypto').randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO password_reset_tokens (token, admin_id, expires_at) VALUES (?,?,?)')
    .run(token, req.params.id, expires);
  const resetUrl = `${APP_URL}/admin?reset_token=${token}`;
  setImmediate(async () => {
    try {
      const m = msgPasswordReset({ name: target.name, resetUrl });
      const [first, ...rest] = String(target.name || '').trim().split(/\s+/);
      await sendKlaviyo('password_reset',
        { email: target.email, first_name: first || target.name, last_name: rest.join(' ') },
        { ...m, reset_url: resetUrl });
    } catch (e) { console.error('[Klaviyo] rep password-reset send error:', e.message); }
  });
  res.json({ token, reset_url: resetUrl, expires_at: expires });
});

// ─── PER-EVENT REP ASSIGNMENTS ───────────────────────────────────────────────
// List reps assigned to an event (admins see if they own event; super sees all)
app.get('/api/events/:eventId/reps', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const reps = db.prepare(`
    SELECT a.id, a.name, a.email, a.role, a.active,
           a.perm_corrections, a.perm_resolve_alerts, a.perm_reset_scans, a.perm_register_walkups,
           a.parent_admin_id, a.created_at,
           er.assigned_at, er.assigned_by
    FROM event_reps er
    JOIN admins a ON a.id = er.rep_id
    WHERE er.event_id = ?
    ORDER BY a.name ASC
  `).all(req.params.eventId);
  res.json(reps);
});

// Assign a rep to an event
app.post('/api/events/:eventId/reps', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const { rep_id } = req.body;
  if (!rep_id) return res.status(400).json({ error: 'rep_id required' });
  const rep = db.prepare('SELECT * FROM admins WHERE id=? AND role=\'rep\'').get(rep_id);
  if (!repIsManageable(req.admin, rep)) return res.status(403).json({ error: 'You cannot assign that rep' });
  db.prepare('INSERT OR IGNORE INTO event_reps (event_id, rep_id, assigned_by) VALUES (?,?,?)')
    .run(req.params.eventId, rep_id, req.admin.id);
  res.json({ success: true });
});

// Unassign a rep from an event
app.delete('/api/events/:eventId/reps/:repId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const rep = db.prepare('SELECT * FROM admins WHERE id=? AND role=\'rep\'').get(req.params.repId);
  if (!repIsManageable(req.admin, rep)) return res.status(403).json({ error: 'You cannot manage that rep' });
  db.prepare('DELETE FROM event_reps WHERE event_id=? AND rep_id=?').run(req.params.eventId, req.params.repId);
  res.json({ success: true });
});

// ─── PER-EVENT ADMINS ─────────────────────────────────────────────────────────
// events.admin_id is the CREATOR. event_admins holds additional admins who can
// manage the event. Assigning is super-only; any admin with access can view.

// List the creator + assigned admins for an event.
app.get('/api/events/:eventId/admins', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const event = db.prepare('SELECT id, admin_id FROM events WHERE id=?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const creator = event.admin_id
    ? db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(event.admin_id)
    : null;
  const assigned = db.prepare(`
    SELECT a.id, a.name, a.email, a.role, a.active, a.created_at,
           ea.assigned_at, ea.assigned_by
    FROM event_admins ea
    JOIN admins a ON a.id = ea.admin_id
    WHERE ea.event_id = ?
    ORDER BY a.name ASC
  `).all(req.params.eventId);
  res.json({ creator: creator ? { ...creator, is_creator: 1 } : null, assigned });
});

// Assign an admin to an event — super only.
// Body: { admin_id }  (assign an existing admin/super)
//   OR  { name, email }  (create a new admin account, then assign)
app.post('/api/events/:eventId/admins', requireAuth, requireSuper, (req, res) => {
  const { eventId } = req.params;
  const { admin_id, name, email } = req.body;
  const event = db.prepare('SELECT id, name, venue, admin_id FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  let target;          // the admin row to assign
  let tempPassword = null;
  let createdNew = false;

  if (admin_id) {
    target = db.prepare('SELECT * FROM admins WHERE id=?').get(admin_id);
    if (!target) return res.status(404).json({ error: 'Admin not found' });
    if (target.role === 'rep') return res.status(400).json({ error: 'Reps are assigned from the Reps tab, not here' });
  } else if (name && email) {
    const cleanEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'A valid email is required' });
    const existing = db.prepare('SELECT * FROM admins WHERE email=?').get(cleanEmail);
    if (existing) {
      // Email already belongs to an account — assign that one instead of duplicating.
      if (existing.role === 'rep') return res.status(400).json({ error: 'That email belongs to a rep account' });
      target = existing;
    } else {
      // Create a fresh tournament-admin account with a temp password.
      tempPassword = generateAdminPassword();
      createdNew = true;
      const id = uid('ADM');
      db.prepare('INSERT INTO admins (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
        .run(id, String(name).trim(), cleanEmail, hashPassword(tempPassword), 'admin');
      target = db.prepare('SELECT * FROM admins WHERE id=?').get(id);
    }
  } else {
    return res.status(400).json({ error: 'Provide either an existing admin_id, or a name and email for a new admin' });
  }

  if (target.id === event.admin_id) {
    return res.status(400).json({ error: 'That admin already owns this event' });
  }
  const already = db.prepare('SELECT 1 FROM event_admins WHERE event_id=? AND admin_id=?').get(eventId, target.id);
  if (already) return res.status(400).json({ error: 'That admin is already assigned to this event' });

  db.prepare('INSERT INTO event_admins (event_id, admin_id, assigned_by) VALUES (?,?,?)')
    .run(eventId, target.id, req.admin.id);

  // Notify (non-blocking) — welcome email w/ temp password for new accounts,
  // otherwise a plain "you've been added" notice.
  setImmediate(() => notifyAdminAssignment(createdNew ? 'welcome' : 'assigned', {
    name: target.name, email: target.email,
    eventName: event.name, venue: event.venue, eventId,
    tempPassword,
  }));

  res.json({
    success: true,
    admin: db.prepare(`SELECT ${ADMIN_COLS} FROM admins WHERE id=?`).get(target.id),
    created_new: createdNew,
    ...(tempPassword ? { temp_password: tempPassword } : {}),
  });
});

// Unassign an admin from an event — super only. The creator cannot be removed.
app.delete('/api/events/:eventId/admins/:adminId', requireAuth, requireSuper, (req, res) => {
  const { eventId, adminId } = req.params;
  const event = db.prepare('SELECT admin_id FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.admin_id === adminId) {
    return res.status(400).json({ error: 'This admin created the event and cannot be removed' });
  }
  db.prepare('DELETE FROM event_admins WHERE event_id=? AND admin_id=?').run(eventId, adminId);
  res.json({ success: true });
});

// ─── API: BACKUPS (super admin) ──────────────────────────────────────────────
app.get('/api/admin/backup/status', requireAuth, requireSuper, (_req, res) => {
  const list   = backup.listBackups(DB_PATH);
  const latest = list[0] || null;
  res.json({
    dbPath:     DB_PATH,
    backupDir:  backup.backupDir(DB_PATH),
    count:      list.length,
    latest,
    s3Enabled:  !!process.env.S3_BUCKET,
    s3Bucket:   process.env.S3_BUCKET || null,
  });
});

app.post('/api/admin/backup/run', requireAuth, requireSuper, async (_req, res) => {
  try {
    const result = await backup.runBackupNow(db, DB_PATH);
    res.json({ success: true, file: path.basename(result.file), bytes: result.bytes, uploaded: result.uploaded });
  } catch (err) {
    console.error('[Backup] Manual run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/backup/download', requireAuth, requireSuper, async (_req, res) => {
  try {
    // Always take a fresh snapshot for download so it's the live state
    const result = await backup.runBackupNow(db, DB_PATH);
    res.download(result.file, path.basename(result.file));
  } catch (err) {
    console.error('[Backup] Download failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: EVENTS ─────────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  const role = req.admin.role;
  const baseSelect = `
    SELECT e.*,
      a.name  AS creator_name,
      a.email AS creator_email,
      a.role  AS creator_role,
      COUNT(DISTINCT t.id)        AS team_count,
      COUNT(DISTINCT b.drop_code) AS ball_count
    FROM events e
    LEFT JOIN admins a ON a.id=e.admin_id
    LEFT JOIN teams t ON t.event_id=e.id
    LEFT JOIN balls b ON b.event_id=e.id
  `;
  let events;
  if (role === 'super') {
    events = db.prepare(`${baseSelect} GROUP BY e.id ORDER BY e.starts_at DESC`).all();
  } else if (role === 'admin') {
    // Admins see events they created OR are explicitly assigned to via event_admins
    events = db.prepare(`${baseSelect}
      WHERE e.admin_id=?
         OR e.id IN (SELECT event_id FROM event_admins WHERE admin_id=?)
      GROUP BY e.id ORDER BY e.starts_at DESC`).all(req.admin.id, req.admin.id);
  } else if (role === 'rep') {
    // Reps see only the events they're explicitly assigned to via event_reps
    events = db.prepare(`${baseSelect}
      INNER JOIN event_reps er ON er.event_id=e.id AND er.rep_id=?
      GROUP BY e.id ORDER BY e.starts_at DESC`).all(req.admin.id);
  } else {
    events = [];
  }
  res.json(events);
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  if (!hasEventAccess(req.admin, req.params.id)) return res.status(403).json({ error: 'You do not have access to this event' });
  const ev = db.prepare(`
    SELECT e.*, a.name AS creator_name, a.email AS creator_email, a.role AS creator_role
    FROM events e
    LEFT JOIN admins a ON a.id=e.admin_id
    WHERE e.id=?
  `).get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const tee_boxes = db.prepare('SELECT * FROM tee_boxes WHERE event_id=?').all(req.params.id);
  res.json({ ...ev, tee_boxes });
});

// Public event info — no auth — used by demo scan mode on scan page
app.get('/api/events/:id/public', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const tee_boxes = db.prepare('SELECT * FROM tee_boxes WHERE event_id=?').all(req.params.id);
  const { id, name, venue, status, has_longest_drive, has_closest_pin,
          allow_rough, rough_penalty_mode, rough_fixed_yards,
          allow_oob, oob_penalty_mode, oob_fixed_yards, hole_distance_yards,
          fairway_polygon, rough_polygon, oob_polygon, green_polygon, ctp_green_polygon,
          pin_lat, pin_lon, admin_phone,
          ctp_pin_lat, ctp_pin_lon, cp_off_green_penalty_ft,
          is_charity, brand_enabled, brand_logo, brand_accent } = ev;
  res.json({ id, name, venue, status, has_longest_drive, has_closest_pin,
             allow_rough, rough_penalty_mode, rough_fixed_yards: rough_fixed_yards || 0,
             allow_oob, oob_penalty_mode, oob_fixed_yards: oob_fixed_yards || 0,
             hole_distance_yards: hole_distance_yards || 300,
             fairway_polygon: fairway_polygon || null, rough_polygon: rough_polygon || null,
             oob_polygon: oob_polygon || null, green_polygon: green_polygon || null,
             ctp_green_polygon: ctp_green_polygon || null,
             pin_lat: pin_lat || null, pin_lon: pin_lon || null,
             ctp_pin_lat: ctp_pin_lat || null, ctp_pin_lon: ctp_pin_lon || null,
             cp_off_green_penalty_ft: cp_off_green_penalty_ft || 0,
             admin_phone: admin_phone || null, tee_boxes,
             // Branding — only sent when enabled, so player pages can mesh the look.
             is_charity: is_charity ? 1 : 0,
             branding: brand_enabled
               ? { logo: brand_logo || null, accent: brand_accent || null }
               : null });
});

app.post('/api/events', requireAuth, requireAdminOrSuper, (req, res) => {
  const { name, venue, starts_at, ends_at, has_longest_drive, has_closest_pin,
          combined_scoring, allow_rough, rough_penalty_mode, rough_fixed_yards,
          allow_oob, oob_penalty_mode, oob_fixed_yards, hole_distance_yards } = req.body;
  if (!name || !starts_at || !ends_at) return res.status(400).json({ error: 'name, starts_at, ends_at required' });
  const id = uid('EVT');
  db.prepare(`INSERT INTO events
    (id,name,venue,starts_at,ends_at,has_longest_drive,has_closest_pin,combined_scoring,
     allow_rough,rough_penalty_mode,rough_fixed_yards,allow_oob,oob_penalty_mode,oob_fixed_yards,hole_distance_yards,admin_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, venue||null, starts_at, ends_at,
      has_longest_drive?1:0, has_closest_pin?1:0, combined_scoring?1:0,
      allow_rough?1:0, rough_penalty_mode||'perpendicular', rough_fixed_yards||0,
      allow_oob?1:0, oob_penalty_mode||'half_hole', oob_fixed_yards||0,
      hole_distance_yards||300, req.admin.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(id));
});

// Clone an existing event into a new one — for organizers running the same
// tournament year after year. Copies the *configuration* (contest toggles,
// scoring rules, polygons, branding, optionally the public site + packages)
// but NOT the live data (registrations, balls, scoring rounds, pairings).
//
// The new event always starts in 'setup' status; the slug is regenerated
// with a suffix and the cloned site is unpublished by default so the org
// can review before going live.
app.post('/api/admin/events/:sourceId/clone', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const src = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.sourceId);
  if (!src) return res.status(404).json({ error: 'Source event not found' });

  const { name, starts_at, ends_at, copy_packages = true, copy_site = true } = req.body || {};
  if (!name || !starts_at || !ends_at) return res.status(400).json({ error: 'name, starts_at, ends_at required' });

  const newId = uid('EVT');
  // Re-resolve tz on the new event from the same venue coords as the source.
  const newTz = detectTimeZone(src.venue_lat, src.venue_lon);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO events
      (id, name, venue, starts_at, ends_at, status,
       has_longest_drive, has_closest_pin, combined_scoring,
       allow_rough, rough_penalty_mode, rough_fixed_yards,
       allow_oob, oob_penalty_mode, oob_fixed_yards, hole_distance_yards,
       fairway_polygon, rough_polygon, oob_polygon, green_polygon,
       pin_lat, pin_lon,
       ctp_pin_lat, ctp_pin_lon, ctp_green_polygon, ctp_hole_distance_yards,
       cp_off_green_penalty_ft, admin_phone, admin_id,
       venue_lat, venue_lon, time_zone,
       is_charity, brand_enabled, brand_logo, brand_accent, brand_url,
       fundraising_goal_cents, fundraising_visible)
      VALUES (?, ?, ?, ?, ?, 'setup',
              ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?)`).run(
      newId, name, src.venue, starts_at, ends_at,
      src.has_longest_drive, src.has_closest_pin, src.combined_scoring,
      src.allow_rough, src.rough_penalty_mode, src.rough_fixed_yards,
      src.allow_oob, src.oob_penalty_mode, src.oob_fixed_yards, src.hole_distance_yards,
      src.fairway_polygon, src.rough_polygon, src.oob_polygon, src.green_polygon,
      src.pin_lat, src.pin_lon,
      src.ctp_pin_lat, src.ctp_pin_lon, src.ctp_green_polygon, src.ctp_hole_distance_yards,
      src.cp_off_green_penalty_ft, src.admin_phone, req.admin.id,
      src.venue_lat, src.venue_lon, newTz,
      src.is_charity, src.brand_enabled, src.brand_logo, src.brand_accent, src.brand_url,
      src.fundraising_goal_cents, src.fundraising_visible
    );

    // Copy tee_boxes (course map's tee positions for LD).
    const teeRows = db.prepare('SELECT * FROM tee_boxes WHERE event_id=?').all(src.id);
    const teeStmt = db.prepare(`INSERT INTO tee_boxes (id, event_id, name, color, lat, lon, hole_type)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of teeRows) teeStmt.run(uid('TEE'), newId, t.name, t.color, t.lat, t.lon, t.hole_type);

    if (copy_site) {
      const site = db.prepare('SELECT * FROM event_sites WHERE event_id=?').get(src.id);
      if (site) {
        // Generate a unique slug by appending a 4-char suffix. If somehow
        // that collides too, the UNIQUE constraint will throw and the
        // whole transaction rolls back — caller can retry.
        const baseSlug = (site.slug || 'event').slice(0, 60);
        const newSlug = `${baseSlug}-${uid('').slice(0, 4).toLowerCase()}`;
        db.prepare(`INSERT INTO event_sites
          (event_id, slug, headline, subhead, hero_image, starts_at, location_name,
           about_html, schedule_json, course_info, faq_json,
           contact_name, contact_email, contact_phone, published,
           donations_enabled, donation_suggested_json, donation_min_cents, donation_prompt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                  ?, ?, ?, ?)`).run(
          newId, newSlug, site.headline, site.subhead, site.hero_image,
          starts_at, site.location_name,
          site.about_html, site.schedule_json, site.course_info, site.faq_json,
          site.contact_name, site.contact_email, site.contact_phone,
          site.donations_enabled || 0, site.donation_suggested_json,
          site.donation_min_cents || 500, site.donation_prompt
        );
      }
    }

    let packagesCloned = 0;
    if (copy_packages) {
      // Skip the auto-created 'donation' package — donations get a fresh
      // one lazily on the new event when the first donor checks out.
      const pkgs = db.prepare(`SELECT * FROM registration_packages
                               WHERE event_id=?
                                 AND COALESCE(package_kind, 'registration') != 'donation'
                               ORDER BY sort_order`).all(src.id);
      const pkgStmt = db.prepare(`INSERT INTO registration_packages
        (id, event_id, name, description, price_cents, includes_players, quantity_limit, sort_order, active, package_kind, sponsor_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of pkgs) {
        pkgStmt.run(uid('PKG'), newId, p.name, p.description, p.price_cents,
                    p.includes_players, p.quantity_limit, p.sort_order, p.active,
                    p.package_kind || 'registration', p.sponsor_type || null);
        packagesCloned++;
      }
    }

    return { packages_cloned: packagesCloned, tees_cloned: teeRows.length };
  });

  let counts;
  try {
    counts = tx();
  } catch (e) {
    console.error('[Clone event]', e);
    return res.status(500).json({ error: 'Clone failed: ' + e.message });
  }

  res.json({
    event_id: newId,
    event: db.prepare('SELECT * FROM events WHERE id=?').get(newId),
    ...counts,
  });
});

app.patch('/api/events/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const allowed = ['name','venue','starts_at','ends_at','status','has_longest_drive','has_closest_pin',
    'combined_scoring','allow_rough','rough_penalty_mode','rough_fixed_yards','allow_oob',
    'oob_penalty_mode','oob_fixed_yards','hole_distance_yards',
    'fairway_polygon','rough_polygon','oob_polygon','green_polygon',
    'pin_lat','pin_lon',
    'ctp_green_polygon','ctp_pin_lat','ctp_pin_lon','ctp_hole_distance_yards',
    'cp_off_green_penalty_ft','admin_phone','venue_lat','venue_lon','zone_visibility',
    'is_charity','brand_enabled','brand_logo','brand_accent','brand_url',
    'fundraising_goal_cents','fundraising_visible'];
  // Guard the logo payload: only accept a base64 image data URL under the
  // SQLite-friendly ceiling. An empty/null value clears the logo. Anything
  // else (random strings, oversized blobs) is rejected so we never write
  // garbage into the events row.
  if (Object.prototype.hasOwnProperty.call(req.body, 'brand_logo')) {
    const v = req.body.brand_logo;
    if (v == null || v === '') {
      req.body.brand_logo = null;
    } else if (typeof v === 'string' && /^data:image\//i.test(v) && v.length < 2_800_000) {
      // valid; pass through
    } else {
      return res.status(400).json({ error: 'brand_logo must be an image data URL under 2.5 MB.' });
    }
  }
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE events SET ${updates.map(([k])=>`${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v])=>v), req.params.id);
  // If venue coords changed, re-resolve the IANA time zone from the new
  // lat/lon so tee times render in the course's local zone.
  if (Object.prototype.hasOwnProperty.call(req.body, 'venue_lat') ||
      Object.prototype.hasOwnProperty.call(req.body, 'venue_lon')) {
    const row = db.prepare('SELECT venue_lat, venue_lon FROM events WHERE id=?').get(req.params.id);
    const tz = detectTimeZone(row?.venue_lat, row?.venue_lon);
    db.prepare('UPDATE events SET time_zone=? WHERE id=?').run(tz, req.params.id);
  }
  broadcast(req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});

// Delete event (cascade)
app.delete('/api/events/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM admin_corrections WHERE event_id=?').run(id);
  db.prepare('DELETE FROM rep_alerts WHERE event_id=?').run(id);
  db.prepare('DELETE FROM sms_log WHERE event_id=?').run(id);
  db.prepare('DELETE FROM balls WHERE event_id=?').run(id);
  db.prepare('DELETE FROM teams WHERE event_id=?').run(id);
  db.prepare('DELETE FROM tee_boxes WHERE event_id=?').run(id);
  db.prepare('DELETE FROM events WHERE id=?').run(id);
  res.json({ success: true });
});

// Reopen an ended tournament
app.post('/api/events/:id/reopen', requireAuth, requireAdminOrSuper, (req, res) => {
  db.prepare("UPDATE events SET status='active' WHERE id=?").run(req.params.id);
  broadcast(req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});

// End tournament
app.post('/api/events/:id/end', requireAuth, requireAdminOrSuper, async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });

  db.prepare(`UPDATE events SET status='ended' WHERE id=?`).run(req.params.id);

  // Convert used balls to drop mode
  db.prepare(`UPDATE balls SET status='drop', tournament_name=?, tournament_venue=?, tournament_date=?
              WHERE event_id=? AND team_id IS NOT NULL`)
    .run(event.name, event.venue, event.starts_at?.split('T')[0], req.params.id);

  // Return unused balls to available
  db.prepare(`UPDATE balls SET status='available' WHERE event_id=? AND team_id IS NULL`)
    .run(req.params.id);

  // Send end-of-tournament notifications
  const allBalls = db.prepare(`SELECT * FROM balls WHERE event_id=? AND team_id IS NOT NULL`).all(req.params.id);
  const ldLB = event.has_longest_drive ? getLDLeaderboard(req.params.id) : [];
  const cpLB = event.has_closest_pin   ? getCPLeaderboard(req.params.id) : [];
  const winner = ldLB[0] || cpLB[0];

  for (const ball of allBalls) {
    if (!ball.email && !ball.phone) continue;
    const dashUrl  = `${APP_URL}/dashboard/${req.params.id}/${encodeURIComponent(ball.drop_code)}`;
    const myTeamLD = ldLB.find(t => t.balls?.some(b => b.drop_code === ball.drop_code));
    const myBallLD = myTeamLD?.balls?.find(b => b.drop_code === ball.drop_code);
    const myTeamCP = cpLB.find(t => t.balls?.some(b => b.drop_code === ball.drop_code));
    const myBallCP = myTeamCP?.balls?.find(b => b.drop_code === ball.drop_code);
    const msg = msgTournamentEnded({
      firstName:   ball.first_name,
      teamName:    ball.team_name || '',
      eventName:   event.name,
      venue:       event.venue || '',
      winnerTeam:  winner?.team_name || 'TBD',
      playerYards: myBallLD?.ld_final_yards || null,
      playerFt:    myBallCP?.cp_distance_ft || null,
      dashboardUrl: dashUrl,
      isLD:        !!event.has_longest_drive,
    });
    await sendKlaviyo('tournament_ended',
      { email: ball.email, phone: ball.phone, first_name: ball.first_name, last_name: ball.last_name },
      { ...msg, event_id: req.params.id, dashboard_url: dashUrl, winner_team: winner?.team_name || 'TBD' });
  }

  broadcast(req.params.id);
  res.json({ success: true, message: 'Tournament ended. Balls converted. Notifications sent.' });
});

// ─── TEE BOXES ───────────────────────────────────────────────────────────────
app.post('/api/events/:eventId/tee-boxes', requireAuth, requireAdminOrSuper, (req, res) => {
  const { name, color, lat, lon, hole_type } = req.body;
  if (!name || !lat || !lon) return res.status(400).json({ error: 'name, lat, lon required' });
  const id = uid('TEE');
  db.prepare('INSERT INTO tee_boxes (id,event_id,name,color,lat,lon,hole_type) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.eventId, name, color||'white', lat, lon, hole_type||'longest_drive');
  res.json(db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(id));
});

app.patch('/api/tee-boxes/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const allowed = ['lat', 'lon', 'name', 'color', 'hole_type'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE tee_boxes SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v]) => v), req.params.id);
  res.json(db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(req.params.id));
});

app.delete('/api/tee-boxes/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  db.prepare('DELETE FROM tee_boxes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── BALL POOL ────────────────────────────────────────────────────────────────
app.post('/api/events/:eventId/balls', requireAuth, requireAdminOrSuper, (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: 'codes array required' });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  let added = 0, dupes = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO balls
    (drop_code,event_id,status,tournament_name,tournament_venue,tournament_date)
    VALUES (?,?,'tournament',?,?,?)`);
  const tx = db.transaction(() => {
    for (const code of codes) {
      const clean = code.trim().toUpperCase();
      if (clean.length < 4) continue;
      const result = insert.run(clean, req.params.eventId, event.name, event.venue, event.starts_at?.split('T')[0]);
      if (result.changes) added++; else dupes++;
    }
  });
  tx();
  res.json({ added, dupes, message: `${added} codes added to tournament pool` });
});

// Remove a ball from the pool. Add ?force=1 to also remove assigned balls.
app.delete('/api/events/:eventId/balls/:code', requireAuth, requireAdminOrSuper, (req, res) => {
  const code  = req.params.code.toUpperCase();
  const force = req.query.force === '1' || req.query.force === 'true';
  const ball  = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, req.params.eventId);
  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  if (ball.team_id && !force) return res.status(400).json({ error: 'Ball is assigned. Pass ?force=1 to remove anyway.' });
  db.prepare('DELETE FROM balls WHERE drop_code=? AND event_id=?').run(code, req.params.eventId);
  broadcast(req.params.eventId);
  res.json({ success: true });
});

// Unassign a ball from its team — clears player info + team_id, keeps ball in pool
// Auto-deletes the team record if no balls remain on it
app.patch('/api/events/:eventId/balls/:code/unassign', requireAuth, requirePermLevel('perm_ball_codes', 2), requireEventAccess, (req, res) => {
  const code = req.params.code.toUpperCase();
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, req.params.eventId);
  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  const teamId = ball.team_id;
  db.prepare('UPDATE balls SET team_id=NULL, first_name=NULL, last_name=NULL, email=NULL, phone=NULL, player_index=NULL WHERE drop_code=? AND event_id=?')
    .run(code, req.params.eventId);
  if (teamId) {
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM balls WHERE team_id=?').get(teamId);
    if (cnt === 0) db.prepare('DELETE FROM teams WHERE id=?').run(teamId);
  }
  broadcast(req.params.eventId);
  res.json({ success: true });
});

// Delete an entire team — unassigns all its balls, then removes the team record
app.delete('/api/events/:eventId/teams/:teamId', requireAuth, requireAdminOrSuper, (req, res) => {
  const { eventId, teamId } = req.params;
  const team = db.prepare('SELECT * FROM teams WHERE id=? AND event_id=?').get(teamId, eventId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  db.prepare('UPDATE balls SET team_id=NULL, first_name=NULL, last_name=NULL, email=NULL, phone=NULL, player_index=NULL WHERE team_id=? AND event_id=?')
    .run(teamId, eventId);
  db.prepare('DELETE FROM teams WHERE id=?').run(teamId);
  broadcast(eventId);
  res.json({ success: true });
});

// Edit player info on a ball (name, email, phone)
app.patch('/api/events/:eventId/balls/:code/player', requireAuth, requirePermLevel('perm_players_teams', 2), requireEventAccess, (req, res) => {
  const code = req.params.code.toUpperCase();
  const { first_name, last_name, email, phone } = req.body;
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, req.params.eventId);
  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  db.prepare('UPDATE balls SET first_name=?, last_name=?, email=?, phone=? WHERE drop_code=? AND event_id=?')
    .run(
      first_name !== undefined ? String(first_name || '').trim() : ball.first_name,
      last_name  !== undefined ? String(last_name  || '').trim() : ball.last_name,
      email !== undefined ? (email || null)  : ball.email,
      phone !== undefined ? (phone || null)  : ball.phone,
      code, req.params.eventId
    );
  broadcast(req.params.eventId);
  res.json({ success: true });
});

app.get('/api/events/:eventId/balls', requireAuth, requireRosterView, requireEventAccess, (req, res) => {
  const balls = db.prepare(`
    SELECT b.*, t.team_name FROM balls b
    LEFT JOIN teams t ON t.id=b.team_id
    WHERE b.event_id=? ORDER BY b.added_at ASC
  `).all(req.params.eventId);
  const total = balls.length;
  const assigned = balls.filter(b => b.team_id).length;
  res.json({ total, assigned, available: total - assigned, balls });
});

// ─── PUBLIC EVENT INFO (for registration page) ───────────────────────────────
app.get('/api/events/:eventId/info', (req, res) => {
  const ev = db.prepare(`SELECT id,name,venue,starts_at,ends_at,status,has_longest_drive,has_closest_pin,
    is_charity,brand_enabled,brand_logo,brand_accent FROM events WHERE id=?`).get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const tee_boxes = db.prepare('SELECT id,name,color,hole_type FROM tee_boxes WHERE event_id=?').all(req.params.eventId);
  const { brand_enabled, brand_logo, brand_accent, ...rest } = ev;
  res.json({ ...rest, tee_boxes,
    branding: brand_enabled ? { logo: brand_logo || null, accent: brand_accent || null } : null });
});

// ─── REGISTRATION ─────────────────────────────────────────────────────────────
// Register one player at a time. Team name submitted after 4th player.
// No auth required — drop_code validation is the access control.
app.post('/api/events/:eventId/register-player', registerLimiter, async (req, res) => {
  const { drop_code, first_name, last_name, email, phone, tee_box_id, player_index, team_id, email_opt_in, sms_opt_in } = req.body;
  const { eventId } = req.params;

  if (!drop_code || !first_name || !last_name) return res.status(400).json({ error: 'drop_code, first_name, last_name required' });

  // Validate input lengths and format
  if (typeof first_name !== 'string' || first_name.trim().length < 1 || first_name.trim().length > 100) {
    return res.status(400).json({ error: 'First name must be 1-100 characters' });
  }
  if (typeof last_name !== 'string' || last_name.trim().length < 1 || last_name.trim().length > 100) {
    return res.status(400).json({ error: 'Last name must be 1-100 characters' });
  }
  // Email + phone are REQUIRED for every player who registers.
  if (!email || typeof email !== 'string' || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!phone || typeof phone !== 'string' || phone.trim().length < 7 || phone.length > 20) {
    return res.status(400).json({ error: 'A valid phone number is required' });
  }

  const event = db.prepare('SELECT status FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Registration is open during setup AND active — only a finished tournament closes it.
  if (event.status === 'ended') return res.status(403).json({ error: 'This tournament has ended — registration is closed' });

  const code = drop_code.trim().toUpperCase();
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, eventId);
  if (!ball) return res.status(404).json({ error: `Code ${code} not found in this tournament's ball pool` });
  if (ball.team_id) return res.status(400).json({ error: `Code ${code} is already registered to a player` });

  const emailIn = email_opt_in ? 1 : 0;
  const smsIn   = sms_opt_in   ? 1 : 0;

  db.prepare(`UPDATE balls SET first_name=?,last_name=?,email=?,phone=?,tee_box_id=?,player_index=?,team_id=?,email_opt_in=?,sms_opt_in=? WHERE drop_code=? AND event_id=?`)
    .run(first_name.trim(), last_name.trim(), email||null, phone||null, tee_box_id||null, player_index||1, team_id||null, emailIn, smsIn, code, eventId);

  // Fire-and-forget Klaviyo subscription (don't block the response)
  subscribeKlaviyo({
    email: email || null,
    phone: phone || null,
    firstName: first_name.trim(),
    lastName: last_name.trim(),
    emailOptIn: !!email_opt_in,
    smsOptIn: !!sms_opt_in
  }).catch(e => console.error('subscribeKlaviyo error:', e.message));

  res.json({ success: true, drop_code: code, player: `${first_name} ${last_name}` });
});

// Finalize team (set team name after all players registered)
// No auth required — drop_codes must already exist in pool for this event.
app.post('/api/events/:eventId/finalize-team', (req, res) => {
  const { team_name, drop_codes, share_code } = req.body;
  const { eventId } = req.params;

  if (!team_name || !drop_codes?.length) return res.status(400).json({ error: 'team_name and drop_codes required' });

  const event = db.prepare('SELECT status FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Registration is open during setup AND active — only a finished tournament closes it.
  if (event.status === 'ended') return res.status(403).json({ error: 'This tournament has ended — registration is closed' });

  // Normalize share code; ensure uniqueness within event (regenerate if conflict)
  let normalizedShare = (share_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!normalizedShare || normalizedShare.length !== 6) {
    normalizedShare = crypto.randomBytes(3).toString('hex').toUpperCase();
  }
  while (db.prepare('SELECT id FROM teams WHERE event_id=? AND share_code=?').get(eventId, normalizedShare)) {
    normalizedShare = crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  const teamId = uid('TEAM');
  db.prepare('INSERT INTO teams (id,event_id,team_name,share_code) VALUES (?,?,?,?)').run(teamId, eventId, team_name.trim(), normalizedShare);
  db.prepare(`UPDATE balls SET team_id=? WHERE drop_code IN (${drop_codes.map(()=>'?').join(',')}) AND event_id=?`)
    .run(teamId, ...drop_codes.map(c => c.toUpperCase()), eventId);

  broadcast(eventId);
  res.json({ team_id: teamId, team_name: team_name.trim(), share_code: normalizedShare, drop_codes });

  // Fire registration confirmation for each player (non-blocking)
  setImmediate(async () => {
    try {
      const ev      = db.prepare('SELECT name, venue, admin_phone FROM events WHERE id=?').get(eventId);
      const players = db.prepare(`SELECT * FROM balls WHERE team_id=?`).all(teamId);
      const lbUrl   = `${APP_URL}/leaderboard/${eventId}`;
      for (const p of players) {
        if (!p.email && !p.phone) continue;
        const msg = msgRegistration({
          firstName:     p.first_name,
          teamName:      team_name.trim(),
          eventName:     ev.name,
          venue:         ev.venue || '',
          dropCode:      p.drop_code,
          leaderboardUrl: lbUrl,
          scanUrl:       `${APP_URL}/scan/${p.drop_code}`,
          adminPhone:    ev.admin_phone || null,
        });
        await sendKlaviyo('registered',
          { email: p.email, phone: p.phone, first_name: p.first_name, last_name: p.last_name },
          { ...msg, event_id: eventId, team_name: team_name.trim() });
      }
      // Team-created receipt to player 1 — the join code + invite link so they
      // can bring teammates in. (players[0] = the player who created the team.)
      const p1 = players[0];
      if (p1) {
        const tc = msgTeamCreated({
          firstName:    p1.first_name,
          teamName:     team_name.trim(),
          eventName:    ev.name,
          shareCode:    normalizedShare,
          joinUrl:      `${APP_URL}/register/${eventId}?team=${normalizedShare}`,
          teamPageUrl:  `${APP_URL}/team/${eventId}/${normalizedShare}`,
        });
        await sendKlaviyo('team_created',
          { email: p1.email, phone: p1.phone, first_name: p1.first_name, last_name: p1.last_name },
          { ...tc, event_id: eventId, team_name: team_name.trim() });
      }
    } catch (e) { console.error('[Klaviyo] registration notification error:', e.message); }
  });
});

// List all teams for an event — powers the "join an existing team" dropdown
// on the registration page. No auth — registration is public.
app.get('/api/events/:eventId/teams', (req, res) => {
  const { eventId } = req.params;
  const event = db.prepare('SELECT id FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const teams = db.prepare(`
    SELECT t.team_name, t.share_code, COUNT(b.drop_code) AS member_count
    FROM teams t
    LEFT JOIN balls b ON b.team_id = t.id
    WHERE t.event_id = ?
    GROUP BY t.id
    ORDER BY t.team_name COLLATE NOCASE ASC
  `).all(eventId);
  res.json(teams);
});

// Look up a team by its 6-char share code so a new player can confirm + join it.
// Returns team info + member list. No auth — share code is the access token.
app.get('/api/events/:eventId/teams/by-share-code/:code', (req, res) => {
  const { eventId } = req.params;
  const code = (req.params.code || '').toUpperCase();
  const team = db.prepare('SELECT id, team_name, share_code FROM teams WHERE event_id=? AND share_code=?').get(eventId, code);
  if (!team) return res.status(404).json({ error: 'Team not found for this code' });
  const members = db.prepare(`
    SELECT drop_code, first_name, last_name, player_index
    FROM balls WHERE team_id=? ORDER BY player_index ASC, added_at ASC
  `).all(team.id);
  res.json({ team_id: team.id, team_name: team.team_name, share_code: team.share_code, member_count: members.length, members });
});

// Add a new player to an already-finalized team (via share code).
// Validates: event is active, team exists, drop code is in this event's pool and unassigned, team has < 4 members.
app.post('/api/events/:eventId/teams/by-share-code/:code/add-player', registerLimiter, (req, res) => {
  const { eventId } = req.params;
  const code = (req.params.code || '').toUpperCase();
  const { drop_code, first_name, last_name, email, phone, tee_box_id, email_opt_in, sms_opt_in } = req.body;

  if (!drop_code || !first_name || !last_name) return res.status(400).json({ error: 'drop_code, first_name, last_name required' });
  if (typeof first_name !== 'string' || first_name.trim().length < 1 || first_name.trim().length > 100) return res.status(400).json({ error: 'First name must be 1-100 characters' });
  if (typeof last_name !== 'string' || last_name.trim().length < 1 || last_name.trim().length > 100) return res.status(400).json({ error: 'Last name must be 1-100 characters' });
  // Email + phone are REQUIRED for every player who registers.
  if (!email || typeof email !== 'string' || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!phone || typeof phone !== 'string' || phone.trim().length < 7 || phone.length > 20) {
    return res.status(400).json({ error: 'A valid phone number is required' });
  }

  const event = db.prepare('SELECT name, venue, admin_phone, status FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Registration is open during setup AND active — only a finished tournament closes it.
  if (event.status === 'ended') return res.status(403).json({ error: 'This tournament has ended — registration is closed' });

  const team = db.prepare('SELECT id, team_name FROM teams WHERE event_id=? AND share_code=?').get(eventId, code);
  if (!team) return res.status(404).json({ error: 'Team not found for this code' });

  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM balls WHERE team_id=?').get(team.id).n;
  if (memberCount >= 4) return res.status(400).json({ error: 'This team already has 4 players (the max).' });

  const ballCode = drop_code.trim().toUpperCase();
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(ballCode, eventId);
  if (!ball) return res.status(404).json({ error: `Code ${ballCode} not found in this tournament's ball pool` });
  if (ball.team_id) return res.status(400).json({ error: `Code ${ballCode} is already registered to a player` });

  const emailIn = email_opt_in ? 1 : 0;
  const smsIn   = sms_opt_in   ? 1 : 0;

  db.prepare(`UPDATE balls SET first_name=?,last_name=?,email=?,phone=?,tee_box_id=?,player_index=?,team_id=?,email_opt_in=?,sms_opt_in=? WHERE drop_code=? AND event_id=?`)
    .run(first_name.trim(), last_name.trim(), email||null, phone||null, tee_box_id||null, memberCount + 1, team.id, emailIn, smsIn, ballCode, eventId);

  broadcast(eventId);
  res.json({ success: true, team_id: team.id, team_name: team.team_name, drop_code: ballCode, player: `${first_name} ${last_name}` });

  // Fire the registration confirmation (text + email) for this late-joining
  // player — same message player 1's team got at finalize-team. Non-blocking.
  setImmediate(async () => {
    try {
      const msg = msgRegistration({
        firstName:     first_name.trim(),
        teamName:      team.team_name,
        eventName:     event.name,
        venue:         event.venue || '',
        dropCode:      ballCode,
        leaderboardUrl: `${APP_URL}/leaderboard/${eventId}`,
        scanUrl:       `${APP_URL}/scan/${ballCode}`,
        adminPhone:    event.admin_phone || null,
      });
      await sendKlaviyo('registered',
        { email: email, phone: phone, first_name: first_name.trim(), last_name: last_name.trim() },
        { ...msg, event_id: eventId, team_name: team.team_name });
    } catch (e) { console.error('[Klaviyo] add-player registration notification error:', e.message); }
  });
});

// ─── BALL LOOKUP ─────────────────────────────────────────────────────────────
app.get('/api/ball/:code', (req, res) => {
  const ball = db.prepare(`
    SELECT b.*, t.team_name, e.name AS event_name, e.venue, e.status AS event_status,
           e.has_longest_drive, e.has_closest_pin, e.allow_rough, e.allow_oob,
           e.fairway_polygon, e.rough_polygon, e.oob_polygon, e.green_polygon, e.pin_lat, e.pin_lon,
           e.ctp_green_polygon, e.cp_off_green_penalty_ft,
           e.hole_distance_yards, e.oob_penalty_mode, e.rough_penalty_mode,
           e.admin_phone
    FROM balls b
    JOIN events e ON e.id=b.event_id
    LEFT JOIN teams t ON t.id=b.team_id
    WHERE b.drop_code=? ORDER BY b.added_at DESC LIMIT 1
  `).get(req.params.code.toUpperCase());

  if (!ball) return res.status(404).json({ error: 'Ball not found in any tournament' });

  // Get tee box for this player
  const teeBox = ball.tee_box_id
    ? db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(ball.tee_box_id)
    : db.prepare('SELECT * FROM tee_boxes WHERE event_id=? AND hole_type=? LIMIT 1')
        .get(ball.event_id, 'longest_drive');

  const { fairway_polygon, rough_polygon, oob_polygon, green_polygon, pin_lat, pin_lon, ...pub } = ball;
  res.json({
    ...pub,
    player_name:       `${ball.first_name||''} ${ball.last_name||''}`.trim(),
    tee_box:           teeBox,
    has_fairway_map:   !!fairway_polygon,
    has_green_map:     !!green_polygon,
    has_pin:           !!(pin_lat && pin_lon),
    fairway_polygon:   fairway_polygon || null,
    rough_polygon:     rough_polygon   || null,
    oob_polygon:       oob_polygon     || null,
    green_polygon:     green_polygon   || null,
    pin_lat, pin_lon
  });
});

// ─── LONGEST DRIVE SCAN ───────────────────────────────────────────────────────
app.post('/api/scan/ld/:code', scanLimiter, (req, res) => {
  const code = req.params.code.toUpperCase();
  const { lat, lon, location_type } = req.body; // location_type: fairway|rough|oob|lost
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  if (!location_type) return res.status(400).json({ error: 'location_type required' });

  const ball = db.prepare(`
    SELECT b.*, e.allow_rough, e.allow_oob,
           e.hole_distance_yards, e.oob_penalty_mode, e.rough_penalty_mode,
           e.rough_fixed_yards, e.oob_fixed_yards,
           e.fairway_polygon, e.rough_polygon, e.oob_polygon, e.id AS event_id,
           e.status AS event_status
    FROM balls b
    JOIN events e ON e.id=b.event_id
    LEFT JOIN tee_boxes tb ON tb.id=b.tee_box_id
    WHERE b.drop_code=? ORDER BY b.added_at DESC LIMIT 1
  `).get(code);

  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  if (ball.event_status !== 'active') return res.status(403).json({ error: ball.event_status === 'setup' ? 'Tournament has not started yet' : 'Tournament has ended' });

  // Get tee box coords
  const teeBox = ball.tee_box_id
    ? db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(ball.tee_box_id)
    : db.prepare('SELECT * FROM tee_boxes WHERE event_id=? AND hole_type=? LIMIT 1').get(ball.event_id, 'longest_drive');

  if (!teeBox) return res.status(400).json({ error: 'No tee box configured for this event' });

  const rawYards = haversineYards(teeBox.lat, teeBox.lon, parseFloat(lat), parseFloat(lon));
  let penaltyYards = 0;

  // Calculate penalty
  if ((location_type === 'oob' || location_type === 'lost')) {
    if (ball.allow_oob) {
      penaltyYards = ball.oob_penalty_mode === 'half_hole'
        ? ball.hole_distance_yards / 2
        : ball.oob_fixed_yards;
    }
  } else if (location_type === 'rough' && ball.allow_rough) {
    if (ball.rough_penalty_mode === 'perpendicular' && ball.fairway_polygon) {
      penaltyYards = perpendicularDistanceToPolygon(parseFloat(lat), parseFloat(lon), ball.fairway_polygon);
    } else {
      penaltyYards = ball.rough_fixed_yards;
    }
  }

  // Always floor penalty to whole yards — no fractional penalties
  penaltyYards = Math.floor(penaltyYards);

  const finalYards = location_type === 'fairway'
    ? rawYards
    : location_type === 'rough' && ball.allow_rough
      ? Math.max(0, rawYards - penaltyYards)
      : (location_type === 'oob' || location_type === 'lost') && ball.allow_oob
        ? Math.max(0, rawYards - penaltyYards)
        : 0;

  db.prepare(`UPDATE balls SET
    ld_lat=?, ld_lon=?, ld_raw_yards=?, ld_penalty_yards=?, ld_final_yards=?,
    ld_location_type=?, ld_scanned_at=CURRENT_TIMESTAMP, ld_manual_entry=0
    WHERE drop_code=? AND event_id=?`)
    .run(parseFloat(lat), parseFloat(lon), rawYards, penaltyYards, finalYards,
         location_type, code, ball.event_id);

  const newLB = getLDLeaderboard(ball.event_id);
  broadcast(ball.event_id);
  checkLeadershipChange(ball.event_id, newLB);

  // Fire scan confirmation (non-blocking)
  setImmediate(async () => {
    try {
      if (!ball.email && !ball.phone) return;
      const ev      = db.prepare('SELECT name, venue FROM events WHERE id=?').get(ball.event_id);
      const myTeam  = newLB.find(t => t.balls?.some(b => b.drop_code === code));
      const teamRank = myTeam ? newLB.indexOf(myTeam) + 1 : 99;
      const msg = msgLDScan({
        firstName:      ball.first_name,
        teamName:       ball.team_name || '',
        eventName:      ev.name,
        venue:          ev.venue || '',
        finalYards,
        rawYards,
        penaltyYards,
        locationType:   location_type,
        teamRank,
        teamTotalYards: myTeam?.total_yards || finalYards,
        leaderboardUrl: `${APP_URL}/leaderboard/${ball.event_id}`,
      });
      await sendKlaviyo('ball_scanned',
        { email: ball.email, phone: ball.phone, first_name: ball.first_name, last_name: ball.last_name },
        { ...msg, event_id: ball.event_id, contest: 'ld' });
    } catch (e) { console.error('[Klaviyo] LD scan notification error:', e.message); }
  });

  res.json({
    success: true,
    drop_code: code,
    player: `${ball.first_name} ${ball.last_name}`,
    team: ball.team_name,
    raw_yards: Math.round(rawYards),
    penalty_yards: Math.round(penaltyYards),
    final_yards: Math.round(finalYards),
    location_type,
    tee_lat: teeBox.lat,
    tee_lon: teeBox.lon,
    ball_lat: parseFloat(lat),
    ball_lon: parseFloat(lon),
    event_id: ball.event_id,
    fairway_polygon: ball.fairway_polygon || null,
    rough_polygon: ball.rough_polygon || null,
    oob_polygon: ball.oob_polygon || null
  });
});

// ─── CLOSEST TO PIN SCAN ─────────────────────────────────────────────────────
app.post('/api/scan/cp/:code', scanLimiter, (req, res) => {
  const code = req.params.code.toUpperCase();
  const { lat, lon, manual_ft } = req.body;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

  const ball = db.prepare(`
    SELECT b.*,
      COALESCE(e.ctp_pin_lat, e.pin_lat) AS pin_lat,
      COALESCE(e.ctp_pin_lon, e.pin_lon) AS pin_lon,
      COALESCE(e.ctp_green_polygon, e.green_polygon) AS green_polygon,
      COALESCE(e.cp_off_green_penalty_ft, 0) AS cp_off_green_penalty_ft,
      e.id AS event_id, e.status AS event_status
    FROM balls b JOIN events e ON e.id=b.event_id
    WHERE b.drop_code=? ORDER BY b.added_at DESC LIMIT 1
  `).get(code);

  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  if (ball.event_status !== 'active') return res.status(403).json({ error: ball.event_status === 'setup' ? 'Tournament has not started yet' : 'Tournament has ended' });
  if (!ball.pin_lat || !ball.pin_lon) return res.status(400).json({ error: 'Pin location not set for this event' });

  const gpsRawFt = haversineFeet(parseFloat(lat), parseFloat(lon), ball.pin_lat, ball.pin_lon);
  const rawFt = (manual_ft != null && parseFloat(manual_ft) > 0) ? parseFloat(manual_ft) : gpsRawFt;
  const onGreen = ball.green_polygon ? pointInPolygon(parseFloat(lat), parseFloat(lon), ball.green_polygon) : true;
  const penaltyFt = (!onGreen && ball.cp_off_green_penalty_ft > 0) ? ball.cp_off_green_penalty_ft : 0;
  const distFt = rawFt + penaltyFt;

  db.prepare(`UPDATE balls SET
    cp_lat=?, cp_lon=?, cp_distance_ft=?, cp_penalty_ft=?, cp_valid=?, cp_scanned_at=CURRENT_TIMESTAMP
    WHERE drop_code=? AND event_id=?`)
    .run(parseFloat(lat), parseFloat(lon), distFt, penaltyFt, onGreen?1:0, code, ball.event_id);

  const cpLB = getCPLeaderboard(ball.event_id);
  broadcast(ball.event_id);

  // Find current leader and their distance
  const leader = cpLB.find(t => t.best_ft !== null);
  const myTeam = cpLB.find(t => t.balls.some(b => b.drop_code === code));
  const myBall = myTeam?.balls.find(b => b.drop_code === code);
  const isLeader = leader?.id === myTeam?.id;

  res.json({
    success: true,
    drop_code: code,
    player: `${ball.first_name} ${ball.last_name}`,
    team: ball.team_name,
    raw_ft:      parseFloat(rawFt.toFixed(1)),
    penalty_ft:  parseFloat(penaltyFt.toFixed(1)),
    distance_ft: parseFloat(distFt.toFixed(1)),
    on_green: onGreen,
    is_current_leader: isLeader,
    current_leader: isLeader ? null : { team: leader?.team_name, distance_ft: leader?.best_ft }
  });

  // Fire scan confirmation (non-blocking)
  setImmediate(async () => {
    try {
      if (!ball.email && !ball.phone) return;
      const ev      = db.prepare('SELECT name, venue FROM events WHERE id=?').get(ball.event_id);
      const teamRank = myTeam ? cpLB.indexOf(myTeam) + 1 : 99;
      const msg = msgCTPScan({
        firstName:     ball.first_name,
        teamName:      ball.team_name || '',
        eventName:     ev.name,
        venue:         ev.venue || '',
        distanceFt:    distFt,
        onGreen,
        isLeader,
        teamRank,
        leaderboardUrl: `${APP_URL}/leaderboard/${ball.event_id}`,
      });
      await sendKlaviyo('ball_scanned',
        { email: ball.email, phone: ball.phone, first_name: ball.first_name, last_name: ball.last_name },
        { ...msg, event_id: ball.event_id, contest: 'ctp' });
    } catch (e) { console.error('[Klaviyo] CTP scan notification error:', e.message); }
  });
});

// ─── ADMIN CORRECTIONS ────────────────────────────────────────────────────────
app.post('/api/admin/correct', requireAuth, requirePerm('perm_corrections'), (req, res) => {
  const { drop_code, event_id, lat, lon, final_yards, penalty_yards, location_type, reason, game } = req.body;
  if (!hasEventAccess(req.admin, event_id)) return res.status(403).json({ error: 'You do not have access to this event' });
  const code = drop_code.toUpperCase();

  const oldBall = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, event_id);
  if (!oldBall) return res.status(404).json({ error: 'Ball not found' });

  if (game === 'ld') {
    // final_yards field is the RAW distance the player drove; penalty is subtracted to get the score
    const raw = parseFloat(final_yards || 0);
    const pen = parseFloat(penalty_yards || 0);
    const scored = Math.max(0, raw - pen);
    db.prepare(`UPDATE balls SET ld_lat=?, ld_lon=?, ld_raw_yards=?, ld_penalty_yards=?,
                ld_final_yards=?, ld_location_type=?, ld_manual_entry=1, ld_scanned_at=CURRENT_TIMESTAMP
                WHERE drop_code=? AND event_id=?`)
      .run(lat||oldBall.ld_lat, lon||oldBall.ld_lon, raw, pen, scored,
           location_type||oldBall.ld_location_type, code, event_id);
  } else if (game === 'cp') {
    db.prepare(`UPDATE balls SET cp_lat=?, cp_lon=?, cp_distance_ft=?, cp_valid=?, cp_scanned_at=CURRENT_TIMESTAMP
                WHERE drop_code=? AND event_id=?`)
      .run(lat||oldBall.cp_lat, lon||oldBall.cp_lon, parseFloat(final_yards||0), 1, code, event_id);
  }

  const correctedBy = req.admin ? `${req.admin.name} <${req.admin.email}>` : 'admin';
  db.prepare('INSERT INTO admin_corrections (id,drop_code,event_id,corrected_by,old_value,new_value,reason) VALUES (?,?,?,?,?,?,?)')
    .run(uid(), code, event_id, correctedBy, JSON.stringify(oldBall), JSON.stringify(req.body), reason||'');

  broadcast(event_id);
  res.json({ success: true });
});

// Null a ball (rep marks invalid)
app.post('/api/admin/null-ball', requireAuth, requirePerm('perm_corrections'), (req, res) => {
  const { drop_code, event_id, game, reason } = req.body;
  if (!hasEventAccess(req.admin, event_id)) return res.status(403).json({ error: 'You do not have access to this event' });
  const code = drop_code.toUpperCase();
  if (game === 'ld') {
    db.prepare(`UPDATE balls SET ld_final_yards=0, ld_penalty_yards=0, ld_location_type='lost', ld_manual_entry=1, ld_scanned_at=CURRENT_TIMESTAMP WHERE drop_code=? AND event_id=?`)
      .run(code, event_id);
  } else {
    db.prepare(`UPDATE balls SET cp_valid=0, cp_scanned_at=CURRENT_TIMESTAMP WHERE drop_code=? AND event_id=?`)
      .run(code, event_id);
  }
  broadcast(event_id);
  res.json({ success: true });
});

// Reset a ball's scan data so the player can scan again fresh
app.patch('/api/events/:eventId/balls/:code/reset-scan', requireAuth, requirePerm('perm_reset_scans'), requireEventAccess, (req, res) => {
  const code = req.params.code.toUpperCase();
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, req.params.eventId);
  if (!ball) return res.status(404).json({ error: 'Ball not found' });
  const { game } = req.body; // 'ld' | 'cp' | omit for both
  if (!game || game === 'ld') {
    db.prepare(`UPDATE balls SET ld_lat=NULL, ld_lon=NULL, ld_raw_yards=NULL, ld_penalty_yards=NULL,
                ld_final_yards=NULL, ld_location_type=NULL, ld_scanned_at=NULL, ld_manual_entry=0
                WHERE drop_code=? AND event_id=?`).run(code, req.params.eventId);
  }
  if (!game || game === 'cp') {
    db.prepare(`UPDATE balls SET cp_lat=NULL, cp_lon=NULL, cp_distance_ft=NULL, cp_penalty_ft=NULL,
                cp_valid=NULL, cp_scanned_at=NULL
                WHERE drop_code=? AND event_id=?`).run(code, req.params.eventId);
  }
  broadcast(req.params.eventId);
  res.json({ success: true });
});

// ─── REP ALERTS ──────────────────────────────────────────────────────────────
app.post('/api/alerts', alertLimiter, (req, res) => {
  const { event_id, drop_code, team_name, player_name, lat, lon, message } = req.body;
  const id = uid('ALERT');
  db.prepare('INSERT INTO rep_alerts (id,event_id,drop_code,team_name,player_name,lat,lon,message) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, event_id, drop_code||null, team_name||null, player_name||null, lat||null, lon||null, message||'Player needs help');
  broadcast(event_id);
  res.json({ success: true, alert_id: id });
});

app.patch('/api/alerts/:id/resolve', requireAuth, requirePerm('perm_resolve_alerts'), (req, res) => {
  // Look up the alert's event so we can check access and broadcast.
  const alert = db.prepare('SELECT * FROM rep_alerts WHERE id=?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!hasEventAccess(req.admin, alert.event_id)) return res.status(403).json({ error: 'You do not have access to this event' });
  db.prepare('UPDATE rep_alerts SET resolved=1 WHERE id=?').run(req.params.id);
  broadcast(alert.event_id);
  res.json({ success: true });
});

// ─── LEADERBOARD & STREAM ────────────────────────────────────────────────────
app.get('/api/leaderboard/:eventId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json({
    event,
    ld: event.has_longest_drive ? getLDLeaderboard(req.params.eventId) : [],
    cp: event.has_closest_pin   ? getCPLeaderboard(req.params.eventId) : []
  });
});

app.get('/api/leaderboard/:eventId/stream', (req, res) => {
  const { eventId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!sseClients.has(eventId)) sseClients.set(eventId, new Set());
  sseClients.get(eventId).add(res);

  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const tee_boxes = db.prepare('SELECT * FROM tee_boxes WHERE event_id=?').all(eventId);
  const { brand_logo: _bl, ...eventLite } = event || {};
  const payload = { event: event ? { ...eventLite, tee_boxes } : null,
    ld: event?.has_longest_drive ? getLDLeaderboard(eventId) : [],
    cp: event?.has_closest_pin   ? getCPLeaderboard(eventId) : [],
    alerts: db.prepare('SELECT * FROM rep_alerts WHERE event_id=? AND resolved=0').all(eventId)
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); sseClients.get(eventId)?.delete(res); });
});

// ─── PLAYER DASHBOARD ────────────────────────────────────────────────────────
app.get('/api/dashboard/:eventId/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const ball = db.prepare(`
    SELECT b.*, t.team_name, e.name AS event_name, e.venue, e.starts_at, e.ends_at,
           e.has_longest_drive, e.has_closest_pin, e.fairway_polygon, e.green_polygon,
           e.pin_lat, e.pin_lon
    FROM balls b
    JOIN events e ON e.id=b.event_id
    LEFT JOIN teams t ON t.id=b.team_id
    WHERE b.drop_code=? AND b.event_id=?
  `).get(code, req.params.eventId);

  if (!ball) return res.status(404).json({ error: 'Not found' });

  const ldLB = ball.has_longest_drive ? getLDLeaderboard(req.params.eventId) : [];
  const cpLB = ball.has_closest_pin   ? getCPLeaderboard(req.params.eventId) : [];
  const myLDTeam = ldLB.find(t => t.id === ball.team_id);
  const myCPTeam = cpLB.find(t => t.id === ball.team_id);

  res.json({
    ball: { ...ball, player_name: `${ball.first_name} ${ball.last_name}` },
    ld_leaderboard: ldLB,
    cp_leaderboard: cpLB,
    my_ld_team: myLDTeam,
    my_cp_team: myCPTeam,
  });
});

// ─── CONFIG ENDPOINT (for frontend) ─────────────────────────────────────────
// Simple healthcheck that doesn't depend on anything
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/config', (req, res) => {
  res.json({ mapbox_token: MAPBOX_TOKEN, version: '3.5.0', build_date: '2026-05-07' });
});

// ─── COURSE SEARCH (from courses.csv) ────────────────────────────────────────
let _coursesCache = null;
function loadCourses() {
  if (_coursesCache) return _coursesCache;
  try {
    const text = fs.readFileSync('./courses.csv', 'utf8');
    const rows = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const cols = parseCSVRow(line);
      if (cols.length < 3) continue;
      const lon  = parseFloat(cols[0]);
      const lat  = parseFloat(cols[1]);
      if (isNaN(lon) || isNaN(lat)) continue;
      const nameCity = cols[2] || '';
      const details  = cols[3] || '';
      const dash = nameCity.lastIndexOf('-');
      const name      = dash > 0 ? nameCity.slice(0, dash).trim() : nameCity.trim();
      const cityState = dash > 0 ? nameCity.slice(dash + 1).trim() : '';
      const phoneMatch = details.match(/\(\d{3}\)\s*\d{3}-\d{4}/);
      const phone = phoneMatch ? phoneMatch[0] : null;
      const holesMatch = details.match(/\((\d+) Holes?\)/i);
      const holes = holesMatch ? parseInt(holesMatch[1]) : null;
      const typeMatch = details.match(/^\(([^)]+)\)/);
      const type = typeMatch ? typeMatch[1] : null;
      rows.push({ name, cityState, lat, lon, phone, holes, type });
    }
    _coursesCache = rows;
    console.log(`Loaded ${rows.length} courses from courses.csv`);
    return rows;
  } catch (e) {
    console.warn('courses.csv not loaded:', e.message);
    _coursesCache = [];
    return [];
  }
}

function parseCSVRow(line) {
  const cols = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else { cur += c; }
  }
  cols.push(cur);
  return cols;
}

app.get('/api/courses/list', requireAuth, (req, res) => {
  const courses = loadCourses();
  const q = (req.query.q || '').toLowerCase().trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);

  let filtered = q.length >= 2
    ? courses.filter(c => c.name.toLowerCase().includes(q) || c.cityState.toLowerCase().includes(q))
    : courses;

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const items = filtered.slice(offset, offset + limit).map(({ name, cityState, lat, lon, holes, type }) => ({ name, cityState, lat, lon, holes, type }));

  res.json({ total, page, limit, items });
});

app.get('/api/courses/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const courses = loadCourses();
  const results = courses
    .filter(c => c.name.toLowerCase().includes(q) || c.cityState.toLowerCase().includes(q))
    .slice(0, 10)
    .map(({ name, cityState, lat, lon, phone, holes, type }) => ({ name, cityState, lat, lon, phone, holes, type }));
  res.json(results);
});

// ─── SERVER INFO (local IP + ngrok tunnel URL for phone testing) ─────────────
app.get('/api/server-info', async (req, res) => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
    if (localIP !== 'localhost') break;
  }

  let ngrokUrl = null;
  try {
    const r = await fetch('http://localhost:4040/api/tunnels', { signal: AbortSignal.timeout(800) });
    const data = await r.json();
    const tunnel = (data.tunnels || []).find(t => t.proto === 'https');
    if (tunnel) ngrokUrl = tunnel.public_url;
  } catch {}

  res.json({ localIP, port: PORT, appUrl: APP_URL, ngrokUrl });
});

// ─── QR CODE IMAGE (server-generated PNG) ────────────────────────────────────
const QRCodeLib = require('qrcode');
app.get('/api/qr', async (req, res) => {
  const { data, size = '220' } = req.query;
  if (!data) return res.status(400).send('Missing data param');
  try {
    const buf = await QRCodeLib.toBuffer(decodeURIComponent(data), {
      width: Math.min(600, Math.max(80, parseInt(size) || 220)),
      margin: 2,
      color: { dark: '#0F3D2E', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(buf);
  } catch (e) {
    res.status(500).send('QR generation failed: ' + e.message);
  }
});

// ─── CSV EXPORT ──────────────────────────────────────────────────────────────
app.get('/api/events/:eventId/export.csv', requireAuth, (req, res) => {
  const balls = db.prepare(`
    SELECT b.first_name, b.last_name, b.email, b.phone, t.team_name,
           b.drop_code, b.ld_raw_yards, b.ld_penalty_yards, b.ld_final_yards,
           b.ld_location_type, b.cp_distance_ft, b.cp_valid,
           e.name AS event_name, e.venue, e.starts_at
    FROM balls b
    LEFT JOIN teams t ON t.id=b.team_id
    JOIN events e ON e.id=b.event_id
    WHERE b.event_id=? AND b.team_id IS NOT NULL
    ORDER BY t.team_name, b.player_index
  `).all(req.params.eventId);

  const header = 'First,Last,Email,Phone,Team,Code,LD Raw,LD Penalty,LD Final,LD Location,CP Distance (ft),CP Valid,Event,Venue,Date\n';
  const rows = balls.map(b =>
    [b.first_name,b.last_name,b.email||'',b.phone||'',b.team_name,b.drop_code,
     b.ld_raw_yards||'',b.ld_penalty_yards||'',b.ld_final_yards||'',b.ld_location_type||'',
     b.cp_distance_ft||'',b.cp_valid||'',b.event_name,b.venue||'',b.starts_at]
    .map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="jord-${req.params.eventId}.csv"`);
  res.send(header + rows);
});

// ─── GLOBAL LEADERBOARD ──────────────────────────────────────────────────────

// Toggle event's global_published flag (super admin only)
app.patch('/api/events/:id/global-publish', requireAuth, requireSuper, (req, res) => {
  const { published } = req.body;
  db.prepare('UPDATE events SET global_published=? WHERE id=?').run(published ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT id,name,venue,global_published FROM events WHERE id=?').get(req.params.id));
});

// Monthly top 10 fairway-only drives (public — no auth)
app.get('/api/global/leaderboard', (req, res) => {
  const month = req.query.month; // e.g. "2026-05" — if omitted, current month
  let dateFilter;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    dateFilter = `strftime('%Y-%m', b.ld_scanned_at) = '${month}'`;
  } else {
    dateFilter = `strftime('%Y-%m', b.ld_scanned_at) = strftime('%Y-%m', 'now')`;
  }
  const rows = db.prepare(`
    SELECT b.first_name, b.last_name, b.ld_final_yards, b.ld_raw_yards,
           b.ld_scanned_at, b.drop_code,
           t.team_name, e.name AS event_name, e.venue, e.id AS event_id
    FROM balls b
    JOIN events e ON e.id = b.event_id
    LEFT JOIN teams t ON t.id = b.team_id
    WHERE e.global_published = 1
      AND b.ld_location_type = 'fairway'
      AND b.ld_final_yards > 0
      AND ${dateFilter}
    ORDER BY b.ld_final_yards DESC
    LIMIT 10
  `).all();

  // Available months that have data
  const months = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', b.ld_scanned_at) AS month
    FROM balls b
    JOIN events e ON e.id = b.event_id
    WHERE e.global_published = 1
      AND b.ld_location_type = 'fairway'
      AND b.ld_final_yards > 0
    ORDER BY month DESC
    LIMIT 24
  `).all().map(r => r.month).filter(Boolean);

  res.json({
    month: month || new Date().toISOString().slice(0, 7),
    available_months: months,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      player_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Anonymous',
      team_name: r.team_name || '—',
      yards: Math.round(r.ld_final_yards),
      event_name: r.event_name,
      venue: r.venue || '—',
      scanned_at: r.ld_scanned_at,
    }))
  });
});

// Course all-time records: best fairway drive per venue (public)
app.get('/api/global/course-records', (req, res) => {
  const rows = db.prepare(`
    SELECT e.venue,
           MAX(b.ld_final_yards) AS record_yards,
           b.first_name, b.last_name, t.team_name,
           e.name AS event_name, b.ld_scanned_at
    FROM balls b
    JOIN events e ON e.id = b.event_id
    LEFT JOIN teams t ON t.id = b.team_id
    WHERE e.global_published = 1
      AND b.ld_location_type = 'fairway'
      AND b.ld_final_yards > 0
      AND e.venue IS NOT NULL AND e.venue != ''
    GROUP BY e.venue
    ORDER BY record_yards DESC
    LIMIT 50
  `).all();

  res.json(rows.map(r => ({
    venue:        r.venue,
    record_yards: Math.round(r.record_yards),
    held_by:      `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Anonymous',
    team_name:    r.team_name || '—',
    event_name:   r.event_name,
    set_at:       r.ld_scanned_at,
  })));
});

// Hall of Fame for a specific venue (used on ended tournament page)
app.get('/api/global/venue-record', (req, res) => {
  const { venue } = req.query;
  if (!venue) return res.status(400).json({ error: 'venue required' });
  const row = db.prepare(`
    SELECT b.first_name, b.last_name, b.ld_final_yards, b.ld_scanned_at,
           t.team_name, e.name AS event_name, e.id AS event_id
    FROM balls b
    JOIN events e ON e.id = b.event_id
    LEFT JOIN teams t ON t.id = b.team_id
    WHERE e.global_published = 1
      AND b.ld_location_type = 'fairway'
      AND b.ld_final_yards > 0
      AND LOWER(e.venue) = LOWER(?)
    ORDER BY b.ld_final_yards DESC
    LIMIT 1
  `).get(venue);
  if (!row) return res.json({ record: null });
  res.json({ record: {
    player_name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Anonymous',
    team_name:   row.team_name || '—',
    yards:       Math.round(row.ld_final_yards),
    event_name:  row.event_name,
    set_at:      row.ld_scanned_at,
  }});
});

// List all published events (super admin — for management panel)
app.get('/api/global/events', requireAuth, requireSuper, (req, res) => {
  const events = db.prepare(`
    SELECT e.id, e.name, e.venue, e.starts_at, e.status, e.global_published,
      COUNT(DISTINCT CASE WHEN b.ld_location_type='fairway' AND b.ld_final_yards > 0 THEN b.drop_code END) AS fairway_count
    FROM events e
    LEFT JOIN balls b ON b.event_id = e.id
    WHERE e.status = 'ended'
    GROUP BY e.id
    ORDER BY e.starts_at DESC
  `).all();
  res.json(events);
});

// ─── TOURNAMENT SIGNUP ─────────────────────────────────────────────────────────
app.post('/api/tournament-signup', async (req, res) => {
  try {
    const { tournament_name, event_date, venue, location, contest_type, expected_players, admin_name, admin_email, admin_phone, notes, event_url, venue_lat, venue_lon, is_charity, charity_url, logo_data } = req.body;

    // Validate required fields
    if (!tournament_name || !event_date || !venue || !location || !contest_type || !expected_players || !admin_name || !admin_email || !admin_phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const vLat = venue_lat ? parseFloat(venue_lat) : null;
    const vLon = venue_lon ? parseFloat(venue_lon) : null;

    // Branding fields (all optional)
    const isCharity = (is_charity === 1 || is_charity === '1' || is_charity === true) ? 1 : 0;
    const charityUrl = (typeof charity_url === 'string' && /^https?:\/\//i.test(charity_url.trim()))
      ? charity_url.trim() : null;
    // logo_data must be a reasonably-sized image data URL, else drop it silently.
    const logoData = (typeof logo_data === 'string'
      && /^data:image\/(png|jpe?g|svg\+xml|webp);base64,/i.test(logo_data)
      && logo_data.length < 2_800_000) ? logo_data : null;

    // Persist to tournament_requests so super admin can review later
    db.prepare(`INSERT INTO tournament_requests
      (tournament_name, event_date, venue, location, contest_type, expected_players,
       admin_name, admin_email, admin_phone, notes, event_url, venue_lat, venue_lon,
       is_charity, charity_url, logo_data, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`)
      .run(tournament_name, event_date, venue, location, contest_type, parseInt(expected_players, 10),
           admin_name, admin_email, admin_phone, notes || null,
           event_url || null,
           Number.isFinite(vLat) ? vLat : null, Number.isFinite(vLon) ? vLon : null,
           isCharity, charityUrl, logoData);

    // Format the email content
    const emailBody = `
Tournament Signup Request

Tournament Details:
- Name: ${tournament_name}
- Date: ${event_date}
- Venue: ${venue}${vLat && vLon ? ` (${vLat.toFixed(5)}, ${vLon.toFixed(5)})` : ''}
- Location: ${location}
- Contest Type: ${contest_type === 'ld' ? 'Longest Drive' : contest_type === 'ctp' ? 'Closest to Pin' : 'Both'}
- Expected Players: ${expected_players}
- Event URL: ${event_url || 'None'}

Admin Contact:
- Name: ${admin_name}
- Email: ${admin_email}
- Phone: ${admin_phone}

Additional Notes:
${notes || 'None'}
    `.trim();

    // Send email if transporter is configured
    if (transporter) {
      await transporter.sendMail({
        from: SMTP_USER,
        to: SUPPORT_EMAIL,
        subject: `New Tournament Signup: ${tournament_name}`,
        text: emailBody
      });
    } else {
      console.log('[Email] Transporter not configured. Email would have been sent to:', SUPPORT_EMAIL);
      console.log('[Email] Subject: New Tournament Signup:', tournament_name);
      console.log('[Email] Body:', emailBody);
    }

    // Auto-reply to the person who submitted the request — fired as a Klaviyo
    // event so the jord_tournament_signup Flow sends the on-brand reply.
    if (admin_email) {
      const firstName = String(admin_name || '').trim().split(/\s+/)[0] || '';
      const m = msgSignupReceived({ name: firstName, tournamentName: tournament_name });
      const [first, ...rest] = String(admin_name || '').trim().split(/\s+/);
      sendKlaviyo('tournament_signup',
        { email: admin_email, phone: admin_phone || null, first_name: first || admin_name, last_name: rest.join(' ') },
        { ...m, tournament_name, venue, location, contest_type, expected_players,
          admin_name, admin_email, admin_phone })
        .catch(e => console.error('[Klaviyo] signup event error:', e.message));
    }

    res.json({ success: true, message: 'Tournament signup request submitted successfully' });
  } catch (err) {
    console.error('[Signup Error]', err);
    res.status(500).json({ error: 'Failed to submit signup request' });
  }
});

// ─── INBOUND TOURNAMENT REQUESTS — super admin ──────────────────────────────
// Helpers (mirrored in tests/regression-tests.js — keep in sync)
const REQUEST_STATUSES = ['pending', 'accepted', 'rejected', 'replied'];

function canTransitionRequestStatus(from, to) {
  const valid = {
    pending:  new Set(['accepted', 'rejected', 'replied']),
    replied:  new Set(['accepted', 'rejected', 'pending']),
    accepted: new Set(['rejected']),
    rejected: new Set(['pending']),
  };
  return valid[from]?.has(to) === true;
}

function requestToEventDraft(r) {
  if (!r || !r.tournament_name || !r.event_date) return null;
  const ct = (r.contest_type || '').toLowerCase();
  return {
    name: r.tournament_name,
    venue: r.venue || null,
    starts_at: r.event_date + 'T08:00:00',
    ends_at: r.event_date + 'T18:00:00',
    has_longest_drive: ct === 'ld' || ct === 'both' ? 1 : 0,
    has_closest_pin:   ct === 'ctp' || ct === 'both' ? 1 : 0,
    admin_phone: r.admin_phone || null,
    venue_lat: Number.isFinite(r.venue_lat) ? r.venue_lat : null,
    venue_lon: Number.isFinite(r.venue_lon) ? r.venue_lon : null,
    is_charity: r.is_charity ? 1 : 0,
  };
}

const REQUEST_EMAIL_TEMPLATES = {
  welcome: (r) => ({
    subject: `Re: ${r.tournament_name} — Welcome to JORD Golf`,
    body: `Hi ${r.admin_name},\n\nThanks for signing up ${r.tournament_name} at ${r.venue}. We are excited to set up live scoring for your event on ${r.event_date}.\n\nNext steps will follow shortly.\n\n— JORD Golf Team`,
  }),
  more_info: (r) => ({
    subject: `Re: ${r.tournament_name} — A few more details`,
    body: `Hi ${r.admin_name},\n\nThanks for the request. Could you share a bit more about ${r.tournament_name}?\n\n- Confirmed start time on ${r.event_date}?\n- Format details (4-player teams, scramble, etc.)?\n- Any sponsors who need branding on the leaderboard?\n\n— JORD Golf Team`,
  }),
  pricing: (r) => ({
    subject: `Re: ${r.tournament_name} — Pricing`,
    body: `Hi ${r.admin_name},\n\nFor ${r.expected_players} players at ${r.venue} on ${r.event_date}, here is our pricing:\n\n[pricing details here]\n\nLet us know if you would like to move forward.\n\n— JORD Golf Team`,
  }),
  reject: (r) => ({
    subject: `Re: ${r.tournament_name}`,
    body: `Hi ${r.admin_name},\n\nThank you for your interest in JORD Golf for ${r.tournament_name}. Unfortunately we are unable to support this event at this time.\n\n— JORD Golf Team`,
  }),
};

function renderRequestEmailTemplate(key, request) {
  const fn = REQUEST_EMAIL_TEMPLATES[key];
  if (!fn) return null;
  return fn(request);
}

function validateRequestPatch(input) {
  const allowed = ['tournament_name', 'event_date', 'venue', 'location', 'contest_type', 'expected_players', 'admin_name', 'admin_email', 'admin_phone', 'notes', 'status', 'event_url', 'venue_lat', 'venue_lon', 'is_charity', 'charity_url'];
  const out = {};
  for (const k of allowed) {
    if (input[k] === undefined) continue;
    if (k === 'expected_players') {
      const n = parseInt(input[k], 10);
      if (Number.isNaN(n) || n < 1) throw new Error('expected_players must be a positive integer');
      out[k] = n;
    } else if (k === 'admin_email') {
      const v = String(input[k]).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('admin_email must be a valid email');
      out[k] = v;
    } else if (k === 'contest_type') {
      const v = String(input[k]).toLowerCase();
      if (!['ld', 'ctp', 'both'].includes(v)) throw new Error('contest_type must be ld | ctp | both');
      out[k] = v;
    } else if (k === 'status') {
      const v = String(input[k]).toLowerCase();
      if (!REQUEST_STATUSES.includes(v)) throw new Error('invalid status');
      out[k] = v;
    } else if (k === 'event_url' || k === 'charity_url') {
      const v = String(input[k]).trim();
      if (v && !/^https?:\/\//i.test(v)) throw new Error(`${k} must start with http:// or https://`);
      out[k] = v || null;
    } else if (k === 'is_charity') {
      out[k] = (input[k] === 1 || input[k] === '1' || input[k] === true) ? 1 : 0;
    } else if (k === 'venue_lat' || k === 'venue_lon') {
      if (input[k] === null || input[k] === '') { out[k] = null; continue; }
      const n = parseFloat(input[k]);
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      out[k] = n;
    } else {
      out[k] = String(input[k]).trim();
    }
  }
  return out;
}

// LIST — super admin only. Optional ?status= filter.
app.get('/api/admin/tournament-requests', requireAuth, requireSuper, (req, res) => {
  const { status } = req.query;
  const where = status && REQUEST_STATUSES.includes(status) ? `WHERE status=?` : '';
  const params = where ? [status] : [];
  const rows = db.prepare(`SELECT * FROM tournament_requests ${where} ORDER BY created_at DESC`).all(...params);
  res.json(rows);
});

// DETAIL — also returns rendered email templates for convenience
app.get('/api/admin/tournament-requests/:id', requireAuth, requireSuper, (req, res) => {
  const r = db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(parseInt(req.params.id, 10));
  if (!r) return res.status(404).json({ error: 'Not found' });
  const templates = {};
  for (const key of Object.keys(REQUEST_EMAIL_TEMPLATES)) {
    templates[key] = renderRequestEmailTemplate(key, r);
  }
  res.json({ ...r, templates });
});

// EDIT — fields and/or status. Status changes go through the state machine.
app.patch('/api/admin/tournament-requests/:id', requireAuth, requireSuper, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  let patch;
  try { patch = validateRequestPatch(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (patch.status && patch.status !== existing.status && !canTransitionRequestStatus(existing.status, patch.status)) {
    return res.status(400).json({ error: `Cannot transition ${existing.status} → ${patch.status}` });
  }
  const entries = Object.entries(patch);
  if (!entries.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE tournament_requests SET ${entries.map(([k]) => `${k}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...entries.map(([, v]) => v), id);
  res.json(db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id));
});

// ACCEPT — creates an event row from the request, links back via created_event_id
app.post('/api/admin/tournament-requests/:id/accept', requireAuth, requireSuper, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status === 'accepted' && r.created_event_id) {
    return res.status(400).json({ error: 'Already accepted', event_id: r.created_event_id });
  }
  if (!canTransitionRequestStatus(r.status, 'accepted')) {
    return res.status(400).json({ error: `Cannot transition ${r.status} → accepted` });
  }
  const draft = requestToEventDraft(r);
  if (!draft) return res.status(400).json({ error: 'Request missing required fields for event creation' });

  // Find or create the requester's tournament-admin account so the event is THEIRS.
  const reqEmail = String(r.admin_email || '').toLowerCase().trim();
  let ownerAdminId = req.admin.id;   // fallback: the super who accepted
  let tempPassword = null;
  let createdNew = false;
  let notifyKind = null;             // 'welcome' | 'assigned' | null
  let warning = null;
  if (reqEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reqEmail)) {
    const existing = db.prepare('SELECT * FROM admins WHERE email=?').get(reqEmail);
    if (existing && existing.role === 'rep') {
      // Email collides with a rep account — keep super as owner, flag it.
      warning = `${reqEmail} belongs to an existing rep account; event left under your ownership.`;
    } else if (existing) {
      ownerAdminId = existing.id;
      notifyKind = 'assigned';
    } else {
      tempPassword = generateAdminPassword();
      createdNew = true;
      notifyKind = 'welcome';
      const newId = uid('ADM');
      db.prepare('INSERT INTO admins (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
        .run(newId, String(r.admin_name || 'Tournament Admin').trim(), reqEmail, hashPassword(tempPassword), 'admin');
      ownerAdminId = newId;
    }
  }

  // Branding the super admin chose in the "Mock their admin look" review (optional).
  const b = (req.body && req.body.branding) || {};
  const brandEnabled = b.enabled ? 1 : 0;
  const brandLogo = (typeof b.logo === 'string'
    && /^data:image\//i.test(b.logo) && b.logo.length < 2_800_000) ? b.logo : null;
  const brandAccent = normalizeHex(b.accent);
  const brandUrl = r.charity_url || r.event_url || null;

  const eventId = uid('EVT');
  const draftTz = detectTimeZone(draft.venue_lat, draft.venue_lon);
  db.prepare(`INSERT INTO events
    (id,name,venue,starts_at,ends_at,has_longest_drive,has_closest_pin,admin_phone,admin_id,venue_lat,venue_lon,time_zone,
     is_charity,brand_enabled,brand_logo,brand_accent,brand_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(eventId, draft.name, draft.venue, draft.starts_at, draft.ends_at,
         draft.has_longest_drive, draft.has_closest_pin, draft.admin_phone, ownerAdminId,
         draft.venue_lat, draft.venue_lon, draftTz,
         draft.is_charity, brandEnabled, brandLogo, brandAccent, brandUrl);
  db.prepare(`UPDATE tournament_requests SET status='accepted', created_event_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(eventId, id);

  // Notify the requester (non-blocking) — welcome w/ temp password, or "added" notice.
  if (notifyKind) {
    setImmediate(() => notifyAdminAssignment(notifyKind, {
      name: r.admin_name, email: reqEmail,
      eventName: draft.name, venue: draft.venue, eventId,
      tempPassword,
    }));
  }

  res.json({
    event_id: eventId,
    request: db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id),
    admin_created: createdNew,
    ...(tempPassword ? { temp_password: tempPassword } : {}),
    ...(warning ? { warning } : {}),
  });
});

// ─── SITE BRANDING EXTRACTION ────────────────────────────────────────────────
// Best-effort scraping of an org's website for a logo + brand colors. Always
// gated by a human (the super admin's Mock → Accept review), so imperfect
// results are fine — the admin picks/overrides before anything goes live.

function normalizeHex(input) {
  if (!input) return null;
  let h = String(input).trim().toLowerCase();
  if (h[0] !== '#') h = '#' + h;
  if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + h.slice(1).split('').map(c => c + c).join('');
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

// Reject near-white, near-black, and low-saturation greys — not real accents.
function isBrandableColor(hex) {
  const h = normalizeHex(hex);
  if (!h) return false;
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lum = (max + min) / 2;
  if (lum > 235 || lum < 22) return false;   // too light / too dark
  if (max - min < 28) return false;          // grey-ish
  return true;
}

// Fetch a remote image → data URL (caps ~1.6MB). null on any failure.
async function fetchImageAsDataUrl(imgUrl) {
  try {
    const fetch = require('node-fetch');
    const resp = await fetch(imgUrl, {
      timeout: 7000, size: 1_600_000, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JORDGolfBot/1.0)' },
    });
    if (!resp.ok) return null;
    const ctype = (resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(ctype)) return null;
    const buf = await resp.buffer();
    if (!buf.length || buf.length > 1_600_000) return null;
    return `data:${ctype};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function extractSiteBranding(siteUrl) {
  const result = { logos: [], colors: [], theme_color: null, error: null };
  const fetch = require('node-fetch');
  let html = '', baseUrl;
  try {
    baseUrl = new URL(siteUrl);
    const resp = await fetch(siteUrl, {
      timeout: 8000, size: 3_000_000, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JORDGolfBot/1.0)' },
    });
    if (!resp.ok) { result.error = `Site returned ${resp.status}`; return result; }
    html = await resp.text();
  } catch {
    result.error = 'Could not reach that website';
    return result;
  }
  const abs = (href) => { try { return new URL(href, baseUrl).href; } catch { return null; } };

  // ── Logo candidate URLs ──
  const logoUrls = new Set();
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    if (!/rel\s*=\s*["'][^"']*(apple-touch-icon|icon|mask-icon)/i.test(m[0])) continue;
    const href = m[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) { const u = abs(href[1]); if (u) logoUrls.add(u); }
  }
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    if (!/(property|name)\s*=\s*["'](og:image|twitter:image)/i.test(m[0])) continue;
    const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i);
    if (c) { const u = abs(c[1]); if (u) logoUrls.add(u); }
  }
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    if (!/logo/i.test(m[0])) continue;
    const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src) { const u = abs(src[1]); if (u) logoUrls.add(u); }
  }
  logoUrls.add(baseUrl.origin + '/favicon.ico');

  // ── Color candidates ──
  const tc = html.match(/<meta[^>]+name\s*=\s*["']theme-color["'][^>]*>/i);
  if (tc) {
    const c = tc[0].match(/content\s*=\s*["']([^"']+)["']/i);
    if (c) result.theme_color = normalizeHex(c[1]);
  }
  let cssText = html;
  const sheets = [];
  for (const m of html.matchAll(/<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    const href = m[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) { const u = abs(href[1]); if (u) sheets.push(u); }
    if (sheets.length >= 2) break;
  }
  for (const s of sheets) {
    try {
      const r = await fetch(s, { timeout: 6000, size: 800_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JORDGolfBot/1.0)' } });
      if (r.ok) cssText += '\n' + await r.text();
    } catch {}
  }
  const colorCount = {};
  for (const m of cssText.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = normalizeHex('#' + m[1]);
    if (hex) colorCount[hex] = (colorCount[hex] || 0) + 1;
  }
  const ranked = Object.entries(colorCount)
    .filter(([hex]) => isBrandableColor(hex))
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);
  result.colors = [...new Set([result.theme_color, ...ranked].filter(Boolean))].slice(0, 8);

  // Download top logo candidates server-side → data URLs (dodges CORS, lets us store).
  const candidates = [...logoUrls].slice(0, 6);
  const fetched = await Promise.all(candidates.map(fetchImageAsDataUrl));
  result.logos = fetched.filter(Boolean).slice(0, 5);
  if (!result.logos.length && !result.colors.length && !result.error) {
    result.error = 'No logo or colors could be detected on that site';
  }
  return result;
}

// FETCH BRANDING — super admin pulls logo + color candidates from the org's site.
app.post('/api/admin/tournament-requests/:id/fetch-branding', requireAuth, requireSuper, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const url = (req.body && req.body.url) || r.charity_url || r.event_url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'No website URL on this request — add one or upload a logo manually' });
  }
  const branding = await extractSiteBranding(url);
  // The requester's signup-uploaded logo (if any) is offered as the first candidate.
  const logos = [];
  if (r.logo_data) logos.push(r.logo_data);
  for (const l of branding.logos) if (!logos.includes(l)) logos.push(l);
  res.json({ url, logos, colors: branding.colors, theme_color: branding.theme_color, error: branding.error });
});

// EMAIL — send a custom email reply, append to reply_log, mark replied
app.post('/api/admin/tournament-requests/:id/email', requireAuth, requireSuper, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { subject, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });

  if (transporter) {
    try {
      await transporter.sendMail({
        from: SMTP_USER,
        to: r.admin_email,
        subject: String(subject),
        text: String(body),
      });
    } catch (e) {
      console.error('[Request Email Error]', e);
      return res.status(500).json({ error: 'Failed to send email' });
    }
  } else {
    console.log('[Email] Transporter not configured. Reply to', r.admin_email, '— Subject:', subject);
  }

  let log;
  try { log = JSON.parse(r.reply_log || '[]'); } catch { log = []; }
  log.push({ at: new Date().toISOString(), by: req.admin.email, subject: String(subject), body: String(body) });

  // Only flip to 'replied' if the request is currently pending; preserve accepted/rejected status
  const newStatus = r.status === 'pending' ? 'replied' : r.status;
  db.prepare(`UPDATE tournament_requests SET reply_log=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(JSON.stringify(log), newStatus, id);

  res.json({ ok: true, request: db.prepare('SELECT * FROM tournament_requests WHERE id=?').get(id) });
});

// DELETE
app.delete('/api/admin/tournament-requests/:id', requireAuth, requireSuper, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM tournament_requests WHERE id=?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ─── TEST EMAIL (super admin only) ───────────────────────────────────────────
// Sends a sample registration email so admins can preview what players receive.
app.post('/api/test/registration-email', requireAuth, requireSuper, async (req, res) => {
  const { to, event_id } = req.body;
  if (!to) return res.status(400).json({ error: 'to (email) required' });

  const ev = event_id
    ? db.prepare('SELECT name, venue, admin_phone FROM events WHERE id=?').get(event_id)
    : { name: 'Sample Tournament', venue: 'Test Course', admin_phone: null };
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const sampleCode = 'TEST01';
  const msg = msgRegistration({
    firstName:      'Test',
    teamName:       'Test Team',
    eventName:      ev.name,
    venue:          ev.venue || 'Test Course',
    dropCode:       sampleCode,
    leaderboardUrl: `${APP_URL}/leaderboard/${event_id || 'demo'}`,
    scanUrl:        `${APP_URL}/scan/${sampleCode}`,
    adminPhone:     ev.admin_phone || null,
  });

  await sendEmailDirect(to, '[TEST] ' + msg.EmailSubject, msg.EmailBodyHtml);
  res.json({ sent: !!transporter, to, mock: !transporter });
});

// ═══ TOURNAMENT SCORING ROUTES — Live Leaderboard (Phase 1) ══════════════════
// Full-round stroke-play scoring. Course/tournament setup needs an admin login;
// score entry + the live leaderboard are public (gated by knowing the round id),
// the same model as the existing player register/scan pages.

// --- helpers -----------------------------------------------------------------

/** Load a course with its tees and each tee's holes. */
function loadCourseFull(courseId) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  if (!course) return null;
  const tees = db.prepare('SELECT * FROM course_tees WHERE course_id=? ORDER BY rowid').all(courseId);
  for (const t of tees) {
    t.holes = db.prepare(
      'SELECT hole_number,par,stroke_index,yardage FROM tee_holes WHERE tee_id=? ORDER BY hole_number'
    ).all(t.id);
  }
  return { ...course, tees };
}

/** Insert a normalized course (from the API or manual entry). Returns course id. */
function insertCourse(c, createdBy) {
  const courseId = uid('CRS');
  db.prepare(`INSERT INTO courses
    (id,name,club_name,city,state,country,lat,lon,num_holes,source,external_id,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    courseId, c.name, c.club_name || null, c.city || null, c.state || null,
    c.country || null, c.lat ?? null, c.lon ?? null, c.num_holes || 18,
    c.source || 'manual', c.external_id || null, createdBy || null);
  for (const t of c.tees || []) {
    const teeId = uid('TEE');
    db.prepare(`INSERT INTO course_tees
      (id,course_id,name,gender,par_total,yardage_total,course_rating,slope_rating)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      teeId, courseId, t.name || 'Tee', t.gender || 'male',
      t.par_total ?? null, t.yardage_total ?? null,
      t.course_rating ?? null, t.slope_rating ?? null);
    (t.holes || []).forEach((h, i) => {
      db.prepare(`INSERT INTO tee_holes (id,tee_id,hole_number,par,stroke_index,yardage)
        VALUES (?,?,?,?,?,?)`).run(
        uid('CH'), teeId, h.hole_number || i + 1, Number(h.par) || 0,
        h.stroke_index ?? null, h.yardage ?? null);
    });
  }
  return courseId;
}

const _holesCache = {};
function teeHoles(teeId) {
  if (!teeId) return [];
  if (!_holesCache[teeId]) _holesCache[teeId] = db.prepare(
    'SELECT hole_number,par,stroke_index FROM tee_holes WHERE tee_id=? ORDER BY hole_number'
  ).all(teeId);
  return _holesCache[teeId];
}
function entryScores(entryId) {
  const scores = {};
  for (const s of db.prepare('SELECT hole_number,strokes FROM scores WHERE round_entry_id=?').all(entryId)) {
    if (s.strokes != null) scores[s.hole_number] = s.strokes;
  }
  return scores;
}

/**
 * Gather a round's entries in the shape the scoring engine expects.
 * Scramble → one team card per team; best ball → one entry per player
 * (carrying team info for aggregation); individual → one entry per player.
 */
function gatherRoundEntries(roundId) {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(roundId);
  if (!round) return [];
  const fmt = formats.getFormat(round.format);
  // "one-ball" formats (scramble / foursomes / greensome) share one team card
  const isTeamCard = (fmt && typeof fmt.allowance === 'string') ? 1 : 0;
  const rows = db.prepare(`
    SELECT re.id, re.tee_id, re.course_handicap, re.team_id, re.side, re.match_no,
           p.name AS player_name, rt.name AS team_name
    FROM round_entries re
    JOIN players p ON p.id=re.player_id
    LEFT JOIN round_teams rt ON rt.id=re.team_id
    WHERE re.round_id=? AND re.is_team_card=? ORDER BY re.rowid`).all(roundId, isTeamCard);
  return rows.map(e => ({
    entryId:        e.id,
    playerName:     isTeamCard ? (e.team_name || 'Team') : e.player_name,
    teamId:         e.team_id,
    teamName:       e.team_name,
    side:           e.side,
    matchNo:        e.match_no,
    courseHandicap: e.course_handicap,
    holes:          teeHoles(e.tee_id),
    scores:         entryScores(e.id),
  }));
}

/** Scorecards for the score-entry page — team cards for scramble, else players. */
function roundScoreCards(round) {
  const fmt = formats.getFormat(round.format);
  // "one-ball" formats (scramble / foursomes / greensome) share one team card
  const isTeamCard = (fmt && typeof fmt.allowance === 'string') ? 1 : 0;
  const rows = db.prepare(`
    SELECT re.id, re.tee_id, re.course_handicap, re.team_id,
           p.name AS player_name, rt.name AS team_name
    FROM round_entries re
    JOIN players p ON p.id=re.player_id
    LEFT JOIN round_teams rt ON rt.id=re.team_id
    WHERE re.round_id=? AND re.is_team_card=? ORDER BY re.rowid`).all(round.id, isTeamCard);
  return rows.map(e => ({
    id:              e.id,
    player_name:     isTeamCard ? (e.team_name || 'Team') : e.player_name,
    group_name:      e.team_name || null,
    course_handicap: e.course_handicap,
    scores:          entryScores(e.id),
  }));
}

// Duplicate format: a frozen array of random 1×/2×/3× per-hole multipliers,
// last hole always 2×. Generated once at round creation; null for other formats.
function holeMultipliers(formatId) {
  const fmt = formats.getFormat(formatId);
  if (!fmt || fmt.engine !== 'duplicate') return null;
  const m = [];
  for (let i = 1; i <= 18; i++) m.push(i === 18 ? 2 : 1 + Math.floor(Math.random() * 3));
  return JSON.stringify(m);
}

// Scoring options for a round (format + any frozen multipliers).
function roundScoringOpts(round) {
  return {
    format: round.format,
    multipliers: round.hole_multipliers ? JSON.parse(round.hole_multipliers) : null,
  };
}

// Leaderboard payload for a round — scored for the round's own format, then
// split into handicap flights if the tournament has flights enabled.
function roundLeaderboardPayload(roundId) {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(roundId);
  if (!round) return null;
  const lb = scoring.buildLeaderboard(gatherRoundEntries(roundId), roundScoringOpts(round));
  const tour = db.prepare('SELECT flights_enabled,num_flights FROM tournaments WHERE id=?')
    .get(round.tournament_id);
  if (tour && tour.flights_enabled && lb.rows && lb.rows.length) {
    scoring.applyFlights(lb, tour.num_flights || 1);
  }
  return { round, leaderboard: lb };
}

// SSE for live leaderboard / scorecard — keyed by round id.
const roundSseClients = new Map();
function broadcastRound(roundId) {
  const clients = roundSseClients.get(roundId);
  if (!clients?.size) return;
  const payload = roundLeaderboardPayload(roundId);
  if (!payload) return;
  const data = JSON.stringify(payload);
  for (const res of clients) res.write(`data: ${data}\n\n`);
}

// --- course endpoints --------------------------------------------------------

app.get('/api/courses', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM courses ORDER BY name').all());
});

// Note: /api/courses/search already exists (CSV venue autocomplete) — this
// scorecard-data lookup uses a distinct path so both coexist.
app.get('/api/courses/online-search', requireAuth, requireAdminOrSuper, async (req, res) => {
  if (!GOLF_COURSE_API_KEY) return res.status(503).json({ error: 'Course API key not configured' });
  try {
    const results = await golfApi.searchCourses(req.query.q || '', GOLF_COURSE_API_KEY);
    res.json(results.map(golfApi.normalizeCourse));
  } catch (err) {
    console.error('[Courses] search failed:', err.message);
    res.status(502).json({ error: 'Course search failed' });
  }
});

// Import a course from the API. Cache-as-you-go: an already-imported course
// (same external_id) is returned as-is instead of duplicated.
app.post('/api/courses/import', requireAuth, requireAdminOrSuper, (req, res) => {
  const normalized = req.body && req.body.tees ? req.body : null;
  if (!normalized || !normalized.name) return res.status(400).json({ error: 'normalized course required' });
  if (normalized.external_id) {
    const existing = db.prepare('SELECT id FROM courses WHERE source=? AND external_id=?')
      .get(normalized.source || 'golfcourseapi', normalized.external_id);
    if (existing) return res.json({ id: existing.id, cached: true });
  }
  const id = insertCourse(normalized, req.admin.id);
  res.json({ id, cached: false });
});

// Manual scorecard entry — { name, city, state, tees:[{ name, gender,
// course_rating, slope_rating, holes:[{ par, stroke_index, yardage }] }] }
app.post('/api/courses', requireAuth, requireAdminOrSuper, (req, res) => {
  const c = req.body || {};
  if (!c.name || !Array.isArray(c.tees) || !c.tees.length) {
    return res.status(400).json({ error: 'name and at least one tee required' });
  }
  for (const t of c.tees) {
    t.par_total = (t.holes || []).reduce((s, h) => s + (Number(h.par) || 0), 0);
    t.yardage_total = (t.holes || []).reduce((s, h) => s + (Number(h.yardage) || 0), 0) || null;
  }
  c.source = 'manual';
  c.num_holes = c.tees[0]?.holes?.length || 18;
  res.json({ id: insertCourse(c, req.admin.id) });
});

app.get('/api/courses/:id', requireAuth, (req, res) => {
  const course = loadCourseFull(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

app.delete('/api/courses/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const inUse = db.prepare('SELECT 1 FROM rounds WHERE course_id=?').get(req.params.id);
  if (inUse) return res.status(409).json({ error: 'Course is used by a round' });
  db.prepare('DELETE FROM courses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- tournament + round endpoints --------------------------------------------

// Game-format catalog — drives the setup wizard's format picker.
app.get('/api/formats', requireAuth, (req, res) => {
  res.json(formats.formatsByTier());
});

app.get('/api/tournaments', requireAuth, (req, res) => {
  const all = req.admin.role === 'super';
  const rows = all
    ? db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM tournaments WHERE admin_id=? ORDER BY created_at DESC').all(req.admin.id);
  for (const t of rows) t.rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  res.json(rows);
});

app.post('/api/tournaments', requireAuth, requireAdminOrSuper, (req, res) => {
  const { name, type, course_id, round_date, format, holes_segment,
          flights_enabled, num_flights } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const fmt  = scoring.SUPPORTED_FORMATS.includes(format) ? format : 'stroke_gross';
  const tType = ['casual', 'tournament', 'reds_blues'].includes(type) ? type : 'tournament';
  const seg  = ['all', 'front9', 'back9'].includes(holes_segment) ? holes_segment : 'all';
  // flights are a tournament-only feature
  const fe = (tType === 'tournament' && flights_enabled) ? 1 : 0;
  const nf = fe ? Math.max(1, Math.min(5, parseInt(num_flights) || 1)) : 1;
  const id = uid('TRN');
  db.prepare(`INSERT INTO tournaments (id,type,name,admin_id,default_format,share_code,flights_enabled,num_flights)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, tType, name, req.admin.id, fmt, uid('').slice(0, 6), fe, nf);
  const roundId = uid('RND');
  db.prepare(`INSERT INTO rounds (id,tournament_id,round_number,course_id,round_date,format,holes_segment,hole_multipliers)
    VALUES (?,?,?,?,?,?,?,?)`).run(roundId, id, 1, course_id || null, round_date || null, fmt, seg, holeMultipliers(fmt));
  res.json({ id, round_id: roundId });
});

app.get('/api/tournaments/:id', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  t.rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  res.json(t);
});

app.post('/api/tournaments/:id/rounds', requireAuth, requireAdminOrSuper, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const { course_id, round_date, format } = req.body || {};
  const fmt = scoring.SUPPORTED_FORMATS.includes(format) ? format : t.default_format;
  const next = (db.prepare('SELECT MAX(round_number) AS m FROM rounds WHERE tournament_id=?').get(t.id).m || 0) + 1;
  const roundId = uid('RND');
  db.prepare(`INSERT INTO rounds (id,tournament_id,round_number,course_id,round_date,format,hole_multipliers)
    VALUES (?,?,?,?,?,?,?)`).run(roundId, t.id, next, course_id || null, round_date || null, fmt, holeMultipliers(fmt));
  res.json({ id: roundId, round_number: next });
});

app.post('/api/rounds/:roundId/status', requireAuth, requireAdminOrSuper, (req, res) => {
  const { status } = req.body || {};
  if (!['setup', 'active', 'ended'].includes(status)) return res.status(400).json({ error: 'bad status' });
  db.prepare('UPDATE rounds SET status=? WHERE id=?').run(status, req.params.roundId);
  broadcastRound(req.params.roundId);
  res.json({ ok: true });
});

// Add a player to a round. Reuses an existing player row (matched by phone)
// so history accrues, then computes the WHS course handicap for the tee.
app.post('/api/rounds/:roundId/entries', requireAuth, requireAdminOrSuper, (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const { name, phone, email, handicap_index, tee_id, group_name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'player name required' });

  let player = phone ? db.prepare('SELECT * FROM players WHERE phone=?').get(phone) : null;
  if (player) {
    if (handicap_index != null) db.prepare('UPDATE players SET handicap_index=? WHERE id=?').run(handicap_index, player.id);
  } else {
    const pid = uid('PLR');
    db.prepare('INSERT INTO players (id,name,phone,email,handicap_index) VALUES (?,?,?,?,?)')
      .run(pid, name, phone || null, email || null, handicap_index ?? null);
    player = { id: pid, handicap_index };
  }

  // course handicap, then the format's playing-handicap allowance (e.g. 95%)
  let courseHcp = null;
  if (tee_id) {
    const tee = db.prepare('SELECT * FROM course_tees WHERE id=?').get(tee_id);
    const raw = handicap.courseHandicap(handicap_index ?? player.handicap_index,
      tee?.slope_rating, tee?.course_rating, tee?.par_total);
    const fmt = formats.getFormat(round.format);
    courseHcp = (raw != null && fmt && typeof fmt.allowance === 'number')
      ? handicap.playingHandicap(raw, fmt.allowance) : raw;
  }

  let groupId = null;
  if (group_name) {
    const g = db.prepare('SELECT id FROM score_groups WHERE round_id=? AND name=?').get(round.id, group_name);
    groupId = g ? g.id : (() => { const gid = uid('GRP');
      db.prepare('INSERT INTO score_groups (id,round_id,name) VALUES (?,?,?)').run(gid, round.id, group_name);
      return gid; })();
  }

  const entryId = uid('ENT');
  db.prepare('INSERT INTO round_entries (id,round_id,player_id,tee_id,group_id,course_handicap) VALUES (?,?,?,?,?,?)')
    .run(entryId, round.id, player.id, tee_id || null, groupId, courseHcp);
  broadcastRound(round.id);
  res.json({ id: entryId, course_handicap: courseHcp });
});

// Create a team (pair/team formats): players + entries + team handicap.
app.post('/api/rounds/:roundId/teams', requireAuth, requireAdminOrSuper, (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const fmt = formats.getFormat(round.format);
  if (!fmt) return res.status(400).json({ error: 'Unknown round format' });
  const { name, players } = req.body || {};
  if (!name || !Array.isArray(players) || !players.length) {
    return res.status(400).json({ error: 'team name and at least one player required' });
  }

  // resolve/create each player and compute their course handicap
  const members = players.map(p => {
    let player = p.phone ? db.prepare('SELECT * FROM players WHERE phone=?').get(p.phone) : null;
    if (player) {
      if (p.handicap_index != null) db.prepare('UPDATE players SET handicap_index=? WHERE id=?').run(p.handicap_index, player.id);
    } else {
      const pid = uid('PLR');
      db.prepare('INSERT INTO players (id,name,phone,email,handicap_index) VALUES (?,?,?,?,?)')
        .run(pid, p.name, p.phone || null, p.email || null, p.handicap_index ?? null);
      player = { id: pid };
    }
    let raw = null;
    if (p.tee_id) {
      const tee = db.prepare('SELECT * FROM course_tees WHERE id=?').get(p.tee_id);
      raw = handicap.courseHandicap(p.handicap_index, tee?.slope_rating, tee?.course_rating, tee?.par_total);
    }
    return { playerId: player.id, tee_id: p.tee_id || null, courseHcp: raw };
  });

  const teamId = uid('TM');
  // scramble/foursomes/greensome take a single team handicap (allowance baked in)
  const teamHcp = typeof fmt.allowance === 'string'
    ? handicap.teamHandicap(members.map(m => m.courseHcp), fmt.allowance) : null;
  db.prepare('INSERT INTO round_teams (id,round_id,name,team_handicap) VALUES (?,?,?,?)')
    .run(teamId, round.id, name, teamHcp);

  if (typeof fmt.allowance === 'string') {
    // one-ball formats (scramble / foursomes / greensome): one shared scorecard
    // for the team (player_id = a representative member)
    db.prepare(`INSERT INTO round_entries (id,round_id,player_id,tee_id,team_id,is_team_card,course_handicap)
      VALUES (?,?,?,?,?,1,?)`).run(uid('ENT'), round.id, members[0].playerId, members[0].tee_id, teamId, teamHcp);
  } else {
    // best ball: each member keeps their own ball + playing handicap (allowance applied)
    for (const m of members) {
      const playing = (m.courseHcp != null && typeof fmt.allowance === 'number')
        ? handicap.playingHandicap(m.courseHcp, fmt.allowance) : m.courseHcp;
      db.prepare(`INSERT INTO round_entries (id,round_id,player_id,tee_id,team_id,is_team_card,course_handicap)
        VALUES (?,?,?,?,?,0,?)`).run(uid('ENT'), round.id, m.playerId, m.tee_id, teamId, playing);
    }
  }
  broadcastRound(round.id);
  res.json({ id: teamId, team_handicap: teamHcp });
});

// Add a player to EVERY round of a tournament (multi-round field setup).
app.post('/api/tournaments/:id/field', requireAuth, requireAdminOrSuper, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  if (!rounds.length) return res.status(400).json({ error: 'Tournament has no rounds' });
  const { name, phone, email, handicap_index, tee_id, side, match_no } = req.body || {};
  if (!name) return res.status(400).json({ error: 'player name required' });

  let player = phone ? db.prepare('SELECT * FROM players WHERE phone=?').get(phone) : null;
  if (player) {
    if (handicap_index != null) db.prepare('UPDATE players SET handicap_index=? WHERE id=?').run(handicap_index, player.id);
  } else {
    const pid = uid('PLR');
    db.prepare('INSERT INTO players (id,name,phone,email,handicap_index) VALUES (?,?,?,?,?)')
      .run(pid, name, phone || null, email || null, handicap_index ?? null);
    player = { id: pid };
  }
  const sd = ['red', 'blue'].includes(side) ? side : null;   // Reds vs Blues
  for (const round of rounds) {
    let courseHcp = null;
    if (tee_id) {
      const tee = db.prepare('SELECT * FROM course_tees WHERE id=?').get(tee_id);
      const raw = handicap.courseHandicap(handicap_index, tee?.slope_rating, tee?.course_rating, tee?.par_total);
      const fmt = formats.getFormat(round.format);
      courseHcp = (raw != null && fmt && typeof fmt.allowance === 'number')
        ? handicap.playingHandicap(raw, fmt.allowance) : raw;
    }
    db.prepare('INSERT INTO round_entries (id,round_id,player_id,tee_id,course_handicap,side,match_no) VALUES (?,?,?,?,?,?,?)')
      .run(uid('ENT'), round.id, player.id, tee_id || null, courseHcp, sd, match_no ?? null);
    broadcastRound(round.id);
  }
  res.json({ ok: true, player_id: player.id });
});

// Cumulative leaderboard across all rounds of a tournament (individual formats).
function tournamentLeaderboard(tournamentId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tournamentId);
  if (!t) return null;
  const rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  const fmt = formats.getFormat(t.default_format);
  const highWins = !!(fmt && fmt.engine === 'stableford');
  const agg = {};
  for (const round of rounds) {
    const lb = scoring.buildLeaderboard(gatherRoundEntries(round.id), roundScoringOpts(round));
    const e2p = {};
    for (const re of db.prepare('SELECT id,player_id FROM round_entries WHERE round_id=?').all(round.id)) {
      e2p[re.id] = re.player_id;
    }
    for (const row of lb.rows) {
      const pid = e2p[row.entryId];
      if (!pid) continue;                       // skip non-player rows (team formats)
      if (!agg[pid]) agg[pid] = { playerName: row.playerName, perRound: {}, total: 0, thru: 0, started: false };
      agg[pid].perRound[round.round_number] = row.total;
      if (row.total != null) { agg[pid].total += row.total; agg[pid].thru += row.thru; agg[pid].started = true; }
    }
  }
  const rows = Object.values(agg).map(a => ({
    playerName: a.playerName, perRound: a.perRound, thru: a.thru,
    total: a.started ? a.total : null,
  }));
  rows.sort((a, b) => {
    if (a.total == null && b.total == null) return 0;
    if (a.total == null) return 1;
    if (b.total == null) return -1;
    return highWins ? b.total - a.total : a.total - b.total;
  });
  let lastT = null, lastP = 0;
  rows.forEach((r, i) => {
    if (r.total != null && r.total === lastT) r.position = lastP;
    else { r.position = i + 1; lastP = i + 1; lastT = r.total; }
  });
  return {
    tournament: { id: t.id, name: t.name },
    rounds: rounds.map(r => ({ number: r.round_number, status: r.status })),
    scoreType: highWins ? 'points' : 'topar',
    rows,
  };
}

// Reds vs Blues: every match (a Red vs a Blue, paired by match number) is worth
// a point — 1 to the winner, ½ each if halved. Team totals add across rounds.
function rvbLeaderboard(tournamentId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tournamentId);
  if (!t) return null;
  const rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  let redPts = 0, bluePts = 0;
  const matches = [];
  for (const round of rounds) {
    const byMatch = {};
    for (const e of gatherRoundEntries(round.id)) {
      if (e.matchNo == null || !e.side) continue;
      (byMatch[e.matchNo] = byMatch[e.matchNo] || {})[e.side] = e;
    }
    for (const mno of Object.keys(byMatch).sort((a, b) => a - b)) {
      const red = byMatch[mno].red, blue = byMatch[mno].blue;
      if (!red || !blue) continue;
      const m = scoring.buildLeaderboard([red, blue], { format: 'match_individual' }).match;
      if (m && m.status === 'closed') {
        if (m.standing > 0) redPts += 1;
        else if (m.standing < 0) bluePts += 1;
        else { redPts += 0.5; bluePts += 0.5; }
      }
      matches.push({
        round: round.round_number, matchNo: Number(mno),
        red: red.playerName, blue: blue.playerName,
        standing: m ? m.standing : 0, status: m ? m.status : 'in_progress',
        result: m ? m.result : null, thru: m ? m.played : 0,
      });
    }
  }
  return {
    type: 'reds_blues',
    tournament: { id: t.id, name: t.name },
    reds: { points: redPts }, blues: { points: bluePts },
    rounds: rounds.map(r => ({ number: r.round_number, status: r.status })),
    matches,
  };
}

app.get('/api/tournaments/:id/leaderboard', (req, res) => {
  const t = db.prepare('SELECT type FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  res.json(t.type === 'reds_blues'
    ? rvbLeaderboard(req.params.id)
    : tournamentLeaderboard(req.params.id));
});

app.delete('/api/rounds/:roundId/entries/:entryId', requireAuth, requireAdminOrSuper, (req, res) => {
  db.prepare('DELETE FROM round_entries WHERE id=? AND round_id=?').run(req.params.entryId, req.params.roundId);
  broadcastRound(req.params.roundId);
  res.json({ ok: true });
});

// --- public: score entry + leaderboard ---------------------------------------

// Full round payload for the score-entry page and the leaderboard.
app.get('/api/rounds/:roundId', (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const tournament = db.prepare('SELECT id,name,type,status FROM tournaments WHERE id=?').get(round.tournament_id);
  const course = round.course_id ? loadCourseFull(round.course_id) : null;
  res.json({ round, tournament, course, entries: roundScoreCards(round) });
});

// Batch score upsert from the score-entry page (also the offline-sync target).
app.post('/api/rounds/:roundId/scores', (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'active') return res.status(403).json({ error: 'Round is not accepting scores' });
  const { scores, entered_by } = req.body || {};
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });

  const validEntry = db.prepare('SELECT 1 FROM round_entries WHERE id=? AND round_id=?');
  const upsert = db.prepare(`INSERT INTO scores (id,round_entry_id,hole_number,strokes,entered_by)
    VALUES (?,?,?,?,?)
    ON CONFLICT(round_entry_id,hole_number)
    DO UPDATE SET strokes=excluded.strokes, entered_by=excluded.entered_by, entered_at=CURRENT_TIMESTAMP`);
  const clear = db.prepare('DELETE FROM scores WHERE round_entry_id=? AND hole_number=?');

  const apply = db.transaction(rows => {
    for (const s of rows) {
      if (!validEntry.get(s.entry_id, round.id)) continue;
      const hole = Number(s.hole_number);
      if (s.strokes == null || s.strokes === '') clear.run(s.entry_id, hole);
      else upsert.run(uid('SCR'), s.entry_id, hole, Number(s.strokes), entered_by || null);
    }
  });
  apply(scores);
  broadcastRound(round.id);
  res.json({ ok: true, saved: scores.length });
});

// Ranked leaderboard. ?format= overrides the round format (gross/net toggle).
app.get('/api/rounds/:roundId/leaderboard', (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  res.json(roundLeaderboardPayload(round.id).leaderboard);
});

// SSE stream — pushes gross + net leaderboards on every score change.
app.get('/api/rounds/:roundId/stream', (req, res) => {
  const roundId = req.params.roundId;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (!roundSseClients.has(roundId)) roundSseClients.set(roundId, new Set());
  roundSseClients.get(roundId).add(res);

  const payload = roundLeaderboardPayload(roundId);
  if (payload) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); roundSseClients.get(roundId)?.delete(res); });
});

// ═══ ENTERPRISE — USER ACCOUNTS (personal accounts; players) ═════════════════

app.post('/api/users/signup', (req, res) => {
  const { name, email, password, handicap_index } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const e = String(email).toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email=?').get(e)) {
    return res.status(409).json({ error: 'That email is already registered' });
  }
  // Optional self-reported handicap index (null if blank or invalid)
  let hcp = null;
  if (handicap_index !== null && handicap_index !== undefined && handicap_index !== '') {
    const n = Number(handicap_index);
    if (Number.isFinite(n) && n >= -10 && n <= 54) hcp = n;
  }
  const id = uid('USR');
  db.prepare('INSERT INTO users (id,name,email,password_hash,handicap_index) VALUES (?,?,?,?,?)')
    .run(id, String(name).trim(), e, hashPassword(password), hcp);
  const token = createUserSession(id);
  res.json({ token, user: { id, name: String(name).trim(), email: e, handicap_index: hcp } });
});

app.post('/api/users/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase().trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const token = createUserSession(u.id);
  res.json({ token, user: { id: u.id, name: u.name, email: u.email } });
});

app.post('/api/users/logout', (req, res) => {
  const token = req.headers['x-user-token'];
  if (token) db.prepare('DELETE FROM user_sessions WHERE token=?').run(token);
  res.json({ ok: true });
});

// ─── Stripe Connect onboarding (organizer connects their own Stripe) ───────
// One Connect Express account per admin. The admin who created an event
// (events.admin_id) receives the proceeds for that event's registrations.
// The onboarding flow:
//   1. Admin clicks "Connect Stripe" → POST /api/admin/stripe/connect/onboard
//      → server creates (or reuses) the acct_… and an account_link, returns URL.
//   2. Browser redirects to Stripe → admin fills in their info.
//   3. Stripe redirects back to /api/admin/stripe/connect/return or /refresh.
//   4. account.updated webhook also fires, updating our copy of the status.
//      (Webhook is authoritative; the return-URL fetch is a fast best-effort.)

app.get('/api/admin/stripe/account', requireAuth, (req, res) => {
  const a = db.prepare(`SELECT stripe_account_id, stripe_account_status,
                               stripe_charges_enabled, stripe_payouts_enabled,
                               stripe_details_submitted, stripe_connected_at
                        FROM admins WHERE id=?`).get(req.admin.id);
  res.json({
    stripe_enabled: stripeHelper.mode === 'stripe',
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    fee_bps: stripeHelper.FEE_BPS,
    account: a || null,
  });
});

app.post('/api/admin/stripe/connect/onboard', requireAuth, async (req, res) => {
  if (stripeHelper.mode !== 'stripe') return res.status(503).json({ error: 'Stripe not configured on this server' });
  try {
    let row = db.prepare('SELECT stripe_account_id FROM admins WHERE id=?').get(req.admin.id);
    let accountId = row && row.stripe_account_id;

    if (!accountId) {
      const account = await stripeHelper.createConnectAccount({ admin: req.admin });
      accountId = account.id;
      db.prepare('UPDATE admins SET stripe_account_id=?, stripe_account_status=? WHERE id=?')
        .run(accountId, 'restricted', req.admin.id);
    }

    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    const link = await stripeHelper.createAccountLink({
      accountId,
      refreshUrl: `${APP_URL}/admin/stripe-connect?refresh=1`,
      returnUrl:  `${APP_URL}/admin/stripe-connect?return=1`,
    });
    res.json({ url: link.url, account_id: accountId });
  } catch (e) {
    console.error('[Stripe connect onboard]', e);
    res.status(500).json({ error: e.message });
  }
});

// Lightweight refresh — re-fetches the live account and persists status.
// Called from the admin page after Stripe redirects back, so the UI updates
// immediately without waiting for the webhook.
app.post('/api/admin/stripe/connect/sync', requireAuth, async (req, res) => {
  if (stripeHelper.mode !== 'stripe') return res.status(503).json({ error: 'Stripe not configured on this server' });
  try {
    const row = db.prepare('SELECT stripe_account_id FROM admins WHERE id=?').get(req.admin.id);
    if (!row || !row.stripe_account_id) return res.status(404).json({ error: 'No Connect account on file' });
    const account = await stripeHelper.retrieveAccount(row.stripe_account_id);
    const s = stripeHelper.mapAccountStatus(account);
    db.prepare(`UPDATE admins SET
                  stripe_account_status=?,
                  stripe_charges_enabled=?,
                  stripe_payouts_enabled=?,
                  stripe_details_submitted=?,
                  stripe_connected_at = COALESCE(stripe_connected_at, CASE WHEN ?='active' THEN CURRENT_TIMESTAMP END)
                WHERE id=?`).run(
      s.stripe_account_status, s.stripe_charges_enabled, s.stripe_payouts_enabled,
      s.stripe_details_submitted, s.stripe_account_status, req.admin.id
    );
    res.json({ status: s.stripe_account_status, charges_enabled: !!s.stripe_charges_enabled,
               payouts_enabled: !!s.stripe_payouts_enabled, details_submitted: !!s.stripe_details_submitted });
  } catch (e) {
    console.error('[Stripe connect sync]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Organizer-side: event-site + packages editor ───────────────────────────

function isValidSlug(s) {
  return typeof s === 'string'
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
    && s.length <= 80;
}

app.get('/api/admin/events/:id/site', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const eventId = req.params.id;
  const site = db.prepare('SELECT * FROM event_sites WHERE event_id=?').get(eventId);
  const packages = db.prepare(
    'SELECT * FROM registration_packages WHERE event_id=? ORDER BY sort_order, price_cents'
  ).all(eventId);
  res.json({ site: site || null, packages });
});

app.put('/api/admin/events/:id/site', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const eventId = req.params.id;
  const b = req.body || {};
  if (!isValidSlug(b.slug)) {
    return res.status(400).json({ error: 'Slug must be lowercase letters, numbers and hyphens (e.g. "fall-classic-2026")' });
  }
  const taken = db.prepare('SELECT event_id FROM event_sites WHERE slug=? AND event_id != ?').get(b.slug, eventId);
  if (taken) return res.status(409).json({ error: 'That slug is already used by another event.' });
  const cols = ['slug','headline','subhead','hero_image','starts_at','location_name',
                'about_html','schedule_json','course_info','faq_json',
                'contact_name','contact_email','contact_phone','published',
                'donations_enabled','donation_suggested_json','donation_min_cents','donation_prompt',
                'auction_enabled','auction_intake_enabled','auction_intro'];
  // Normalize the suggested amounts to a sorted array of positive integer
  // cents values so the public page never has to defend against garbage.
  let suggested = null;
  if (Array.isArray(b.donation_suggested)) {
    const nums = b.donation_suggested
      .map(v => Math.floor(Number(v) || 0))
      .filter(v => v > 0)
      .slice(0, 8);
    nums.sort((a, b) => a - b);
    suggested = nums.length ? JSON.stringify(nums) : null;
  }
  const data = {
    slug: b.slug,
    headline: b.headline || null,
    subhead: b.subhead || null,
    hero_image: b.hero_image || null,
    starts_at: b.starts_at || null,
    location_name: b.location_name || null,
    about_html: b.about_html || null,
    schedule_json: Array.isArray(b.schedule) ? JSON.stringify(b.schedule) : null,
    course_info: b.course_info || null,
    faq_json: Array.isArray(b.faq) ? JSON.stringify(b.faq) : null,
    contact_name: b.contact_name || null,
    contact_email: b.contact_email || null,
    contact_phone: b.contact_phone || null,
    donations_enabled: b.donations_enabled ? 1 : 0,
    donation_suggested_json: suggested,
    donation_min_cents: b.donation_min_cents != null ? Math.max(100, Number(b.donation_min_cents) || 500) : 500,
    donation_prompt: b.donation_prompt || null,
    auction_enabled: b.auction_enabled ? 1 : 0,
    auction_intake_enabled: b.auction_intake_enabled ? 1 : 0,
    auction_intro: b.auction_intro || null,
    published: b.published ? 1 : 0,
  };
  const params = cols.map(c => data[c]);
  const existing = db.prepare('SELECT event_id FROM event_sites WHERE event_id=?').get(eventId);
  if (existing) {
    db.prepare(`UPDATE event_sites SET ${cols.map(c => c+'=?').join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE event_id=?`)
      .run(...params, eventId);
  } else {
    const ph = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO event_sites (event_id, ${cols.join(',')}) VALUES (?, ${ph})`)
      .run(eventId, ...params);
  }
  res.json({ ok: true });
});

// The catalog of recognized sponsor types. Server-side because the public
// event-site renders sponsorship cards with type-specific framing.
const SPONSOR_TYPES = new Set([
  'title', 'hole', 'cart', 'beverage', 'food', 'hole_in_one',
  'longest_drive', 'closest_to_pin', 'scorecard', 'leaderboard',
  'foursome', 'custom',
]);

app.post('/api/admin/events/:id/packages', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Package name required' });
  // Four customer-facing kinds: 'registration' (player tickets, default),
  // 'sponsorship' (non-playing branded items), 'donation' (the lazy-
  // created free-amount package), 'event_item' (store: mulligans,
  // raffle tickets, merch). Auction_item is also stored here but only
  // created server-side, never via this endpoint.
  const kind = ['sponsorship', 'donation', 'event_item'].includes(b.package_kind) ? b.package_kind : 'registration';
  const sType = (kind === 'sponsorship' && SPONSOR_TYPES.has(b.sponsor_type)) ? b.sponsor_type : null;
  // Registrations need at least 1 player slot; everything else defaults to 0.
  const minPlayers = kind === 'registration' ? 1 : 0;
  // Reuse the same image guard the auction endpoints use.
  let imageData = b.image_data;
  if (imageData !== undefined) {
    const img = normalizeImageData(imageData);
    if (!img.ok) return res.status(400).json({ error: 'image_data must be an image data URL under 2.5 MB' });
    imageData = img.value;
  } else {
    imageData = null;
  }
  const id = uid('PKG');
  db.prepare(`INSERT INTO registration_packages
    (id, event_id, name, description, price_cents, includes_players, quantity_limit, sort_order, active, package_kind, sponsor_type, image_data)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(
    id, req.params.id, String(b.name).trim(), b.description || null,
    Math.max(0, Number(b.price_cents) || 0),
    Math.max(minPlayers, Number(b.includes_players) ?? minPlayers),
    b.quantity_limit != null && b.quantity_limit !== '' ? Number(b.quantity_limit) : null,
    Number(b.sort_order) || 0, kind, sType, imageData);
  res.json({ id });
});

app.patch('/api/admin/events/:id/packages/:pkgId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM registration_packages WHERE id=? AND event_id=?')
    .get(req.params.pkgId, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Package not found' });
  const kind = b.package_kind != null
    ? (['sponsorship', 'donation', 'event_item'].includes(b.package_kind) ? b.package_kind : 'registration')
    : (cur.package_kind || 'registration');
  const minPlayers = kind === 'registration' ? 1 : 0;
  // image_data validation when present in the body — same guard as auction items.
  let imageData = cur.image_data;
  if (b.image_data !== undefined) {
    const img = normalizeImageData(b.image_data);
    if (!img.ok) return res.status(400).json({ error: 'image_data must be an image data URL under 2.5 MB' });
    imageData = img.value;
  }
  const n = {
    name: b.name != null ? String(b.name).trim() : cur.name,
    description: b.description != null ? b.description : cur.description,
    price_cents: b.price_cents != null ? Math.max(0, Number(b.price_cents) || 0) : cur.price_cents,
    includes_players: b.includes_players != null
      ? Math.max(minPlayers, Number(b.includes_players) ?? minPlayers)
      : cur.includes_players,
    quantity_limit: b.quantity_limit !== undefined ? (b.quantity_limit === '' || b.quantity_limit == null ? null : Number(b.quantity_limit)) : cur.quantity_limit,
    sort_order: b.sort_order != null ? (Number(b.sort_order) || 0) : cur.sort_order,
    active: b.active != null ? (b.active ? 1 : 0) : cur.active,
    package_kind: kind,
    sponsor_type: kind === 'sponsorship'
      ? (b.sponsor_type !== undefined ? (SPONSOR_TYPES.has(b.sponsor_type) ? b.sponsor_type : null) : cur.sponsor_type)
      : null,
    image_data: imageData,
  };
  db.prepare(`UPDATE registration_packages
    SET name=?, description=?, price_cents=?, includes_players=?, quantity_limit=?, sort_order=?, active=?, package_kind=?, sponsor_type=?, image_data=?
    WHERE id=?`).run(n.name, n.description, n.price_cents, n.includes_players, n.quantity_limit, n.sort_order, n.active, n.package_kind, n.sponsor_type, n.image_data, req.params.pkgId);
  res.json({ ok: true });
});

app.delete('/api/admin/events/:id/packages/:pkgId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  db.prepare('DELETE FROM registration_packages WHERE id=? AND event_id=?')
    .run(req.params.pkgId, req.params.id);
  res.json({ ok: true });
});

// Public event-site payload — what the /e/:slug page renders from.
app.get('/api/event-sites/:slug', (req, res) => {
  const site = db.prepare('SELECT * FROM event_sites WHERE slug=? AND published=1').get(req.params.slug);
  if (!site) return res.status(404).json({ error: 'Event not found' });
  const event = db.prepare(`SELECT id, name, venue, time_zone, is_charity, brand_logo, brand_accent, brand_url, admin_id,
                                   fundraising_goal_cents, fundraising_visible
                            FROM events WHERE id=?`).get(site.event_id);
  const allPackages = db.prepare(`SELECT id, name, description, price_cents, includes_players, quantity_limit, package_kind, sponsor_type, image_data
                                  FROM registration_packages
                                  WHERE event_id=? AND active=1
                                  ORDER BY sort_order, price_cents`).all(site.event_id);
  // Split into the three customer-facing sections. The auto-created
  // 'donation' + 'auction_item' packages are intentionally hidden — they
  // have their own dedicated flows (/donate, /auction) and shouldn't
  // appear in the generic grids.
  const packages     = allPackages.filter(p => (p.package_kind || 'registration') === 'registration');
  const sponsorships = allPackages.filter(p => p.package_kind === 'sponsorship');
  const store_items  = allPackages.filter(p => p.package_kind === 'event_item');
  // Registration is "open" only when Stripe is configured AND the organizer
  // has a Connect account with charges enabled. In mock mode it's open by
  // default (test path).
  let registration_open = stripeHelper.mode === 'mock';
  if (stripeHelper.mode === 'stripe' && event.admin_id) {
    const organizer = db.prepare('SELECT stripe_charges_enabled FROM admins WHERE id=?').get(event.admin_id);
    registration_open = !!(organizer && organizer.stripe_charges_enabled);
  }
  delete event.admin_id; // don't leak organizer id to public site
  const parseJson = s => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  // Fundraising stats — only computed when the organizer has opted in to
  // showing them. Counts gross revenue minus refunds (net to organizer
  // before JORD's 3% fee) so the goal-bar number matches what the public
  // would expect to see.
  let fundraising = null;
  if (event.fundraising_visible && event.fundraising_goal_cents > 0) {
    const raised = db.prepare(`SELECT
        COALESCE(SUM(amount_cents - COALESCE(refund_amount_cents,0)), 0) AS raised_cents
      FROM registrations
      WHERE event_id=? AND payment_status IN ('paid','partial_refund')`).get(site.event_id).raised_cents;
    fundraising = {
      goal_cents: event.fundraising_goal_cents,
      raised_cents: raised,
      percent: Math.min(100, Math.round((raised / event.fundraising_goal_cents) * 100)),
    };
  }
  // Strip internal-only flags from the public event payload.
  delete event.fundraising_visible;
  if (!fundraising) delete event.fundraising_goal_cents;

  // Donation config — only exposed when the organizer enabled it. The
  // public page renders an amount picker + Donate button if `enabled`.
  const donations = site.donations_enabled ? {
    enabled: true,
    suggested_cents: parseJson(site.donation_suggested_json),
    min_cents: site.donation_min_cents || 500,
    prompt: site.donation_prompt || null,
  } : { enabled: false };

  // Auction config — surface a teaser on /e/:slug ("There's a silent
  // auction → see it here") when enabled. Item lists live at the
  // dedicated /api/event-sites/:slug/auction endpoint to keep this
  // payload small.
  const auction = site.auction_enabled ? {
    enabled: true,
    intake_enabled: !!site.auction_intake_enabled,
    intro: site.auction_intro || null,
    item_count: db.prepare(`SELECT COUNT(*) AS n FROM auction_items
                            WHERE event_id=? AND status IN ('live','ended')`).get(site.event_id).n,
  } : { enabled: false };

  res.json({
    site, event, packages, sponsorships, store_items,
    schedule: parseJson(site.schedule_json),
    faq:      parseJson(site.faq_json),
    fundraising, donations, auction,
    registration_open,
    payment_mode: stripeHelper.mode,
  });
});

// ─── REGISTRATIONS (E1: registration + payment) ─────────────────────────────
// Payment flow:
//   • mock mode   — STRIPE_SECRET_KEY unset; mark registration paid immediately
//                   and return /confirmation/:id URL. Test path only.
//   • stripe mode — STRIPE_SECRET_KEY set; insert registration as `pending`,
//                   create a Stripe Checkout Session against the organizer's
//                   Connect account, return the hosted-checkout URL. The
//                   webhook (above) flips status → 'paid' on
//                   `checkout.session.completed`.
//
// The organizer's Connect account = the `admin_id` (creator) of the event.
// `stripe_charges_enabled` must be 1 or registration is blocked.

app.post('/api/registrations', async (req, res) => {
  const { event_id, package_id, buyer_name, buyer_email, buyer_phone, players } = req.body || {};
  if (!event_id || !package_id) return res.status(400).json({ error: 'event_id and package_id required' });
  if (!buyer_name || !buyer_email) return res.status(400).json({ error: 'buyer_name and buyer_email required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) return res.status(400).json({ error: 'Invalid email' });

  const event = db.prepare('SELECT id, name, admin_id FROM events WHERE id=?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const pkg = db.prepare(`SELECT id, name, description, price_cents, includes_players, quantity_limit, active
                          FROM registration_packages
                          WHERE id=? AND event_id=?`).get(package_id, event_id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (!pkg.active) return res.status(400).json({ error: 'Package is not currently available' });

  if (pkg.quantity_limit && pkg.quantity_limit > 0) {
    const sold = db.prepare(`SELECT COUNT(*) AS n FROM registrations
                             WHERE package_id=? AND payment_status='paid'`).get(package_id).n;
    if (sold >= pkg.quantity_limit) return res.status(400).json({ error: 'This package is sold out' });
  }

  const playersArr = Array.isArray(players) ? players.filter(p => p && p.name) : [];
  const id = crypto.randomBytes(8).toString('hex');
  const amount_cents = pkg.price_cents;
  const platform_fee_cents = stripeHelper.feeCents(amount_cents);
  const site = db.prepare('SELECT slug FROM event_sites WHERE event_id=?').get(event_id);
  const confirmationPath = (regId) => site ? `/e/${site.slug}/confirmation/${regId}` : `/registrations/${regId}`;

  // ── Mock mode (no Stripe key) — instant paid, returns confirmation URL.
  if (stripeHelper.mode === 'mock') {
    db.prepare(`INSERT INTO registrations
      (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
       amount_cents, platform_fee_cents, payment_status, payment_mode, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'mock', CURRENT_TIMESTAMP)`)
      .run(id, event_id, package_id, buyer_name.trim(), buyer_email.trim().toLowerCase(),
           (buyer_phone || '').trim() || null, JSON.stringify(playersArr),
           amount_cents, platform_fee_cents);
    return res.json({ id, confirmation_url: confirmationPath(id), payment_mode: 'mock', status: 'paid' });
  }

  // ── Stripe mode — verify organizer Connect, create Checkout Session.
  if (!event.admin_id) return res.status(503).json({ error: 'This event has no organizer on file' });
  const organizer = db.prepare(`SELECT stripe_account_id, stripe_charges_enabled
                                FROM admins WHERE id=?`).get(event.admin_id);
  if (!organizer || !organizer.stripe_account_id) {
    return res.status(503).json({ error: 'The organizer hasn\'t connected a Stripe account yet — registration is not open.' });
  }
  if (!organizer.stripe_charges_enabled) {
    return res.status(503).json({ error: 'The organizer\'s Stripe account isn\'t fully verified yet — registration is paused.' });
  }

  // Insert in pending state BEFORE creating the Checkout Session so the
  // session metadata can reference our registration_id. If Stripe fails after,
  // the pending row stays — it'll never flip to paid because no webhook fires.
  db.prepare(`INSERT INTO registrations
    (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
     amount_cents, platform_fee_cents, payment_status, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'stripe')`)
    .run(id, event_id, package_id, buyer_name.trim(), buyer_email.trim().toLowerCase(),
         (buyer_phone || '').trim() || null, JSON.stringify(playersArr),
         amount_cents, platform_fee_cents);

  try {
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    const session = await stripeHelper.createCheckoutSession({
      amountCents:        amount_cents,
      platformFeeCents:   platform_fee_cents,
      connectedAccountId: organizer.stripe_account_id,
      productName:        `${event.name} · ${pkg.name}`,
      productDescription: pkg.description || undefined,
      buyerEmail:         buyer_email.trim().toLowerCase(),
      metadata: {
        registration_id: id,
        event_id,
        package_id,
        jord: '1',
      },
      successUrl: `${APP_URL}${confirmationPath(id)}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${APP_URL}/e/${site ? site.slug : ''}/register?pkg=${encodeURIComponent(package_id)}&canceled=1`,
    });

    db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(session.id, id);
    return res.json({ id, checkout_url: session.url, session_id: session.id, payment_mode: 'stripe', status: 'pending' });
  } catch (e) {
    console.error('[Stripe] Checkout Session create failed:', e);
    db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
    return res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }
});

// Public donation endpoint. Differs from /api/registrations in two ways:
//   1) the amount is buyer-specified (clamped to the org's minimum).
//   2) the donation package is auto-created lazily — donors don't need
//      to know about packages and organizers don't have to seed one.
app.post('/api/donations', async (req, res) => {
  const { event_id, amount_cents, buyer_name, buyer_email, buyer_phone, message } = req.body || {};
  if (!event_id) return res.status(400).json({ error: 'event_id required' });
  if (!buyer_name || !buyer_email) return res.status(400).json({ error: 'buyer_name and buyer_email required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) return res.status(400).json({ error: 'Invalid email' });
  const amount = Math.floor(Number(amount_cents) || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Donation amount required' });

  const event = db.prepare('SELECT id, name, admin_id FROM events WHERE id=?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const site = db.prepare('SELECT slug, donations_enabled, donation_min_cents FROM event_sites WHERE event_id=?').get(event_id);
  if (!site || !site.donations_enabled) return res.status(400).json({ error: 'Donations are not enabled for this event' });
  const minCents = site.donation_min_cents || 500;
  if (amount < minCents) return res.status(400).json({ error: `Minimum donation is $${(minCents/100).toFixed(2)}` });

  // Upsert the per-event donation package. Stored at price_cents=0 because
  // the actual amount lives on the registrations row — the package row is
  // just a placeholder to satisfy the FK.
  let pkg = db.prepare("SELECT * FROM registration_packages WHERE event_id=? AND package_kind='donation' LIMIT 1").get(event_id);
  if (!pkg) {
    const pkgId = uid('PKG');
    db.prepare(`INSERT INTO registration_packages
      (id, event_id, name, description, price_cents, includes_players, sort_order, active, package_kind)
      VALUES (?, ?, 'Donation', 'Cash donation to the event', 0, 0, 999, 1, 'donation')`).run(pkgId, event_id);
    pkg = db.prepare('SELECT * FROM registration_packages WHERE id=?').get(pkgId);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const platform_fee_cents = stripeHelper.feeCents(amount);
  const confirmationPath = (regId) => site && site.slug ? `/e/${site.slug}/confirmation/${regId}` : `/registrations/${regId}`;

  // Donations have no playing slot — store an empty roster. Stuffing the
  // donor message into players_json (an earlier approach) caused phantom
  // "(donor message)" players to appear in the scoring leaderboard and
  // the pairings unassigned-player pool.
  const playersArr = [];
  // Surface the donor message on the registrations dashboard via the
  // existing `description` column (truncated to keep the row sane).
  const description = message
    ? 'Donation — ' + String(message).slice(0, 200)
    : 'Donation';

  // Mock mode: instant paid.
  if (stripeHelper.mode === 'mock') {
    db.prepare(`INSERT INTO registrations
      (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
       amount_cents, platform_fee_cents, payment_status, payment_mode, paid_at, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'mock', CURRENT_TIMESTAMP, ?)`)
      .run(id, event_id, pkg.id, buyer_name.trim(), buyer_email.trim().toLowerCase(),
           (buyer_phone || '').trim() || null, JSON.stringify(playersArr),
           amount, platform_fee_cents, description);
    return res.json({ id, confirmation_url: confirmationPath(id), payment_mode: 'mock', status: 'paid' });
  }

  // Stripe mode — same Connect plumbing as /api/registrations.
  if (!event.admin_id) return res.status(503).json({ error: 'This event has no organizer on file' });
  const organizer = db.prepare(`SELECT stripe_account_id, stripe_charges_enabled
                                FROM admins WHERE id=?`).get(event.admin_id);
  if (!organizer || !organizer.stripe_account_id) {
    return res.status(503).json({ error: "The organizer hasn't connected a Stripe account yet — donations are not open." });
  }
  if (!organizer.stripe_charges_enabled) {
    return res.status(503).json({ error: "The organizer's Stripe account isn't fully verified yet — donations are paused." });
  }

  db.prepare(`INSERT INTO registrations
    (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
     amount_cents, platform_fee_cents, payment_status, payment_mode, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'stripe', ?)`)
    .run(id, event_id, pkg.id, buyer_name.trim(), buyer_email.trim().toLowerCase(),
         (buyer_phone || '').trim() || null, JSON.stringify(playersArr),
         amount, platform_fee_cents, description);

  try {
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    const session = await stripeHelper.createCheckoutSession({
      amountCents:        amount,
      platformFeeCents:   platform_fee_cents,
      connectedAccountId: organizer.stripe_account_id,
      productName:        `${event.name} · Donation`,
      productDescription: message ? String(message).slice(0, 100) : undefined,
      buyerEmail:         buyer_email.trim().toLowerCase(),
      metadata: { registration_id: id, event_id, package_id: pkg.id, kind: 'donation', jord: '1' },
      successUrl: `${APP_URL}${confirmationPath(id)}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${APP_URL}/e/${site.slug}?donate_canceled=1`,
    });
    db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(session.id, id);
    return res.json({ id, checkout_url: session.url, session_id: session.id, payment_mode: 'stripe', status: 'pending' });
  } catch (e) {
    console.error('[Stripe] Donation Checkout failed:', e);
    db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
    return res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }
});

app.get('/api/registrations/:id', (req, res) => {
  const SELECT = `SELECT r.id, r.event_id, r.package_id, r.buyer_name, r.buyer_email,
                         r.buyer_phone, r.players_json, r.amount_cents, r.platform_fee_cents,
                         r.payment_status, r.payment_mode, r.stripe_session_id,
                         r.created_at, r.paid_at,
                         p.name AS package_name, p.includes_players,
                         e.name AS event_name, e.venue AS event_venue,
                         s.slug AS event_slug, s.headline AS event_headline,
                         s.contact_email AS support_email
                  FROM registrations r
                  JOIN registration_packages p ON p.id = r.package_id
                  JOIN events e ON e.id = r.event_id
                  LEFT JOIN event_sites s ON s.event_id = r.event_id`;
  // Lookup by registration id, OR — when Stripe redirects back to the
  // success_url with ?session_id=… — fall back to looking up by the Checkout
  // Session id (the buyer's URL may contain it even though we have the real id).
  let reg = db.prepare(`${SELECT} WHERE r.id=?`).get(req.params.id);
  if (!reg && req.query.session_id) {
    reg = db.prepare(`${SELECT} WHERE r.stripe_session_id=?`).get(req.query.session_id);
  }
  if (!reg) return res.status(404).json({ error: 'Registration not found' });
  let players = [];
  try { players = JSON.parse(reg.players_json || '[]'); } catch {}
  delete reg.players_json;
  reg.players = players;
  res.json(reg);
});

// Organizer view — list registrations for an event (for upcoming dashboard).
app.get('/api/admin/events/:id/registrations', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.buyer_name, r.buyer_email, r.buyer_phone,
                                  r.players_json, r.amount_cents, r.platform_fee_cents,
                                  r.payment_status, r.payment_mode, r.stripe_session_id,
                                  r.created_at, r.paid_at,
                                  r.refund_amount_cents, r.refund_reason, r.refunded_at,
                                  r.parent_registration_id, r.description,
                                  p.name AS package_name, p.includes_players
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=?
                           ORDER BY r.created_at DESC`).all(req.params.id);
  const totals = db.prepare(`SELECT
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid','partial_refund','refunded') THEN 1 END), 0) AS paid_count,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid','partial_refund','refunded') THEN amount_cents END), 0) AS revenue_cents,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid','partial_refund','refunded') THEN platform_fee_cents END), 0) AS fees_cents,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid','partial_refund','refunded') THEN p.includes_players END), 0) AS players_paid,
      COALESCE(SUM(refund_amount_cents), 0) AS refunds_cents
    FROM registrations r
    JOIN registration_packages p ON p.id = r.package_id
    WHERE r.event_id=?`).get(req.params.id);

  // Break the revenue down by package kind so the organizer can see how
  // much came from player tickets vs sponsorships. Refunds are subtracted
  // from each bucket's gross.
  const breakdown = db.prepare(`SELECT
      COALESCE(p.package_kind, 'registration') AS kind,
      COALESCE(SUM(CASE WHEN r.payment_status IN ('paid','partial_refund','refunded') THEN r.amount_cents END), 0) AS gross_cents,
      COALESCE(SUM(r.refund_amount_cents), 0) AS refunds_cents,
      COALESCE(SUM(CASE WHEN r.payment_status IN ('paid','partial_refund','refunded') THEN 1 END), 0) AS count
    FROM registrations r
    JOIN registration_packages p ON p.id = r.package_id
    WHERE r.event_id=?
    GROUP BY COALESCE(p.package_kind, 'registration')`).all(req.params.id);
  // Reshape into a stable { registration, sponsorship } object even when
  // one kind has no rows yet — the dashboard needs both keys to render.
  const revenue_by_kind = {
    registration: { gross_cents: 0, refunds_cents: 0, count: 0, net_cents: 0 },
    sponsorship:  { gross_cents: 0, refunds_cents: 0, count: 0, net_cents: 0 },
  };
  for (const row of breakdown) {
    const k = row.kind === 'sponsorship' ? 'sponsorship' : 'registration';
    revenue_by_kind[k].gross_cents   = row.gross_cents;
    revenue_by_kind[k].refunds_cents = row.refunds_cents;
    revenue_by_kind[k].count         = row.count;
    revenue_by_kind[k].net_cents     = row.gross_cents - row.refunds_cents;
  }

  // Fundraising goal context for the dashboard (always returned to admins
  // regardless of whether they've made it public).
  const eventRow = db.prepare('SELECT fundraising_goal_cents, fundraising_visible FROM events WHERE id=?').get(req.params.id) || {};
  const fundraising = {
    goal_cents: eventRow.fundraising_goal_cents || 0,
    visible: !!eventRow.fundraising_visible,
    raised_cents: Math.max(0, (totals.revenue_cents || 0) - (totals.refunds_cents || 0)),
  };
  // Parse players_json into structured arrays so the client doesn't have to.
  const registrations = rows.map(r => {
    let players = [];
    try { players = JSON.parse(r.players_json || '[]'); } catch {}
    const { players_json, ...rest } = r;
    return { ...rest, players };
  });
  res.json({ registrations, totals, revenue_by_kind, fundraising });
});

// CSV export — opens in Excel/Sheets. Columns are flat (one player per row
// is overkill for a per-registration summary; for now we collapse the player
// roster into a single semicolon-separated cell).
app.get('/api/admin/events/:id/registrations.csv', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.buyer_name, r.buyer_email, r.buyer_phone,
                                  r.players_json, r.amount_cents, r.platform_fee_cents,
                                  r.payment_status, r.payment_mode,
                                  r.created_at, r.paid_at,
                                  p.name AS package_name
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=?
                           ORDER BY r.created_at DESC`).all(req.params.id);
  const event = db.prepare('SELECT name FROM events WHERE id=?').get(req.params.id);
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtMoney = c => ((Number(c) || 0) / 100).toFixed(2);
  const header = ['Confirmation #','Buyer name','Email','Phone','Package','Players','Amount (USD)','JORD fee (USD)','Payment status','Created','Paid at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    let players = [];
    try { players = JSON.parse(r.players_json || '[]'); } catch {}
    lines.push([
      r.id, r.buyer_name, r.buyer_email, r.buyer_phone || '',
      r.package_name, players.map(p => p.name).join('; '),
      fmtMoney(r.amount_cents), fmtMoney(r.platform_fee_cents),
      r.payment_status, r.created_at || '', r.paid_at || '',
    ].map(esc).join(','));
  }
  const filename = `registrations-${(event?.name || req.params.id).replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// Refund a registration (full or partial). For Connect destination charges,
// the refund is created on the platform with reverse_transfer:true so the
// money is pulled back from the connected account; refund_application_fee:true
// also returns JORD's 3% so we don't keep fees on refunded transactions.
app.post('/api/admin/events/:id/registrations/:regId/refund', requireAuth, requireAdminOrSuper, requireEventAccess, async (req, res) => {
  const { amount_cents, reason } = req.body || {};
  const reg = db.prepare('SELECT * FROM registrations WHERE id=? AND event_id=?').get(req.params.regId, req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });
  if (!['paid', 'partial_refund'].includes(reg.payment_status)) {
    return res.status(400).json({ error: `Cannot refund a registration in '${reg.payment_status}' status` });
  }

  const alreadyRefunded = reg.refund_amount_cents || 0;
  const remaining = reg.amount_cents - alreadyRefunded;
  if (remaining <= 0) return res.status(400).json({ error: 'Already fully refunded' });

  const requested = amount_cents != null && amount_cents !== '' ? Number(amount_cents) : remaining;
  if (!Number.isFinite(requested) || requested <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const refundCents = Math.min(requested, remaining);

  const finalize = () => {
    const newRefundTotal = alreadyRefunded + refundCents;
    const newStatus = newRefundTotal >= reg.amount_cents ? 'refunded' : 'partial_refund';
    db.prepare(`UPDATE registrations
                SET refund_amount_cents=?, refund_reason=COALESCE(?, refund_reason),
                    refunded_at=COALESCE(refunded_at, CURRENT_TIMESTAMP),
                    refunded_by_admin_id=?, payment_status=?
                WHERE id=?`)
      .run(newRefundTotal, reason || null, req.admin.id, newStatus, reg.id);
    return { newRefundTotal, newStatus };
  };

  // Mock mode (no Stripe key, or mock-mode registration) → DB-only.
  if (reg.payment_mode === 'mock' || stripeHelper.mode === 'mock') {
    const { newRefundTotal, newStatus } = finalize();
    return res.json({ ok: true, refunded_cents: refundCents, total_refunded: newRefundTotal, status: newStatus, mock: true });
  }

  if (!reg.stripe_session_id) return res.status(400).json({ error: 'No Stripe session id on this registration' });

  try {
    // Destination charge → session lives on the platform; no stripeAccount header.
    const session = await stripeHelper.client.checkout.sessions.retrieve(reg.stripe_session_id);
    const pi = session.payment_intent;
    if (!pi) return res.status(400).json({ error: 'Payment is not yet confirmed by Stripe' });

    await stripeHelper.client.refunds.create({
      payment_intent: pi,
      amount: refundCents,
      reason: 'requested_by_customer',
      refund_application_fee: true,
      reverse_transfer:       true,
      metadata: { registration_id: reg.id, jord_admin_id: req.admin.id, jord_reason: reason || '' },
    });

    const { newRefundTotal, newStatus } = finalize();
    res.json({ ok: true, refunded_cents: refundCents, total_refunded: newRefundTotal, status: newStatus });
  } catch (e) {
    console.error('[Stripe refund]', e);
    res.status(502).json({ error: e.message || 'Stripe refund failed' });
  }
});

// Charge an add-on (e.g. mulligan pack, late add-on player) to an existing
// buyer. Creates a NEW registration row linked to the parent via
// `parent_registration_id`, then either returns a Stripe Checkout URL or
// (in mock mode) marks it paid immediately. Optionally emails the buyer a
// link to pay via Klaviyo.
app.post('/api/admin/events/:id/registrations/:regId/addon', requireAuth, requireAdminOrSuper, requireEventAccess, async (req, res) => {
  const { amount_cents, description, email_buyer } = req.body || {};
  const amt = Number(amount_cents);
  if (!Number.isFinite(amt) || amt < 50) return res.status(400).json({ error: 'Amount must be at least $0.50' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description required' });

  const parent = db.prepare('SELECT * FROM registrations WHERE id=? AND event_id=?').get(req.params.regId, req.params.id);
  if (!parent) return res.status(404).json({ error: 'Parent registration not found' });

  const event = db.prepare('SELECT id, name, admin_id FROM events WHERE id=?').get(req.params.id);
  const id = crypto.randomBytes(8).toString('hex');
  const fee = stripeHelper.feeCents(amt);
  const desc = String(description).trim().slice(0, 200);

  db.prepare(`INSERT INTO registrations
    (id, event_id, package_id, parent_registration_id, description,
     buyer_name, buyer_email, buyer_phone, players_json,
     amount_cents, platform_fee_cents, payment_status, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'pending', ?)`)
    .run(id, req.params.id, parent.package_id, parent.id, desc,
         parent.buyer_name, parent.buyer_email, parent.buyer_phone,
         amt, fee, stripeHelper.mode === 'stripe' ? 'stripe' : 'mock');

  if (stripeHelper.mode === 'mock') {
    db.prepare("UPDATE registrations SET payment_status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return res.json({ id, mock: true });
  }

  const organizer = db.prepare('SELECT stripe_account_id, stripe_charges_enabled FROM admins WHERE id=?').get(event.admin_id);
  if (!organizer || !organizer.stripe_account_id || !organizer.stripe_charges_enabled) {
    db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
    return res.status(503).json({ error: 'Organizer Stripe account is not ready for charges' });
  }

  try {
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    const site = db.prepare('SELECT slug FROM event_sites WHERE event_id=?').get(req.params.id);
    const session = await stripeHelper.createCheckoutSession({
      amountCents:        amt,
      platformFeeCents:   fee,
      connectedAccountId: organizer.stripe_account_id,
      productName:        `${event.name} — ${desc}`,
      productDescription: 'Add-on charge',
      buyerEmail:         parent.buyer_email,
      metadata: {
        registration_id: id,
        event_id: req.params.id,
        addon: '1',
        parent_registration_id: parent.id,
      },
      successUrl: `${APP_URL}/e/${site ? site.slug : ''}/confirmation/${id}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${APP_URL}/admin/events/${req.params.id}/registrations`,
    });

    db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(session.id, id);

    if (email_buyer && parent.buyer_email) {
      const first = (parent.buyer_name || '').split(/\s+/)[0] || 'there';
      const amountStr = '$' + (amt / 100).toFixed(2);
      const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      sendKlaviyo('addon_charge', { email: parent.buyer_email, first_name: first }, {
        event_id: req.params.id,
        EmailSubject: `New charge from ${event.name}: ${desc} (${amountStr})`,
        EmailBodyHtml:
          `<p>Hi ${esc(first)},</p>` +
          `<p>The organizer of <strong>${esc(event.name)}</strong> has added a charge to your registration:</p>` +
          `<p style="font-size:18px"><strong>${esc(desc)}</strong> — <strong>${amountStr}</strong></p>` +
          `<p><a href="${session.url}" style="display:inline-block;background:#B8884D;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Inter,Arial,sans-serif">Pay now →</a></p>` +
          `<p style="font-size:13px;color:#666;margin-top:24px">If you didn't expect this, please contact the organizer directly.</p>`,
        amount: amountStr,
        description: desc,
        link: session.url,
      }).catch(e => console.error('[Klaviyo addon_charge]', e.message));
    }

    res.json({ id, checkout_url: session.url, session_id: session.id, email_sent: !!email_buyer });
  } catch (e) {
    console.error('[Stripe addon]', e);
    db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
    res.status(502).json({ error: e.message || 'Stripe checkout creation failed' });
  }
});

// ─── CHECK-IN (E2: run the day) ─────────────────────────────────────────────
// Mobile-first registration-desk flow. Pulls every paid registration + their
// players, joins the `checkins` table to mark who's arrived. Walk-ups create
// regular paid registrations (payment_mode='manual') so they show in the
// dashboard and totals.

app.get('/api/admin/events/:id/checkin', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const regs = db.prepare(`SELECT r.id, r.buyer_name, r.buyer_email, r.buyer_phone,
                                  r.players_json, r.payment_status, r.payment_mode,
                                  r.amount_cents, r.created_at, r.parent_registration_id,
                                  r.description,
                                  p.name AS package_name, p.includes_players
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                             AND r.parent_registration_id IS NULL
                           ORDER BY r.buyer_name ASC`).all(req.params.id);

  const checkinRows = db.prepare(`SELECT registration_id, player_index, player_name, checked_in_at
                                  FROM checkins c
                                  JOIN registrations r ON r.id = c.registration_id
                                  WHERE r.event_id=?`).all(req.params.id);
  const checkinMap = {};
  for (const c of checkinRows) {
    checkinMap[`${c.registration_id}:${c.player_index}`] = c;
  }

  // Flatten to a player-centric list — that's what the UI renders.
  // Each "player" = { reg_id, player_index, name, package, buyer_name, checked_in_at? }
  const players = [];
  for (const r of regs) {
    let roster = [];
    try { roster = JSON.parse(r.players_json || '[]'); } catch {}
    // If roster is empty but package includes players, show placeholder slots.
    const slots = roster.length > 0
      ? roster
      : Array.from({ length: Math.max(1, r.includes_players || 1) }, (_, i) => ({ name: `Player ${i+1} (no name)` }));
    slots.forEach((p, i) => {
      const key = `${r.id}:${i}`;
      const c = checkinMap[key];
      players.push({
        reg_id:        r.id,
        player_index:  i,
        player_name:   p.name || '(unnamed)',
        buyer_name:    r.buyer_name,
        buyer_email:   r.buyer_email,
        buyer_phone:   r.buyer_phone,
        package_name:  r.description || r.package_name,
        payment_mode:  r.payment_mode,
        checked_in_at: c ? c.checked_in_at : null,
      });
    });
  }

  const totals = {
    players_total:    players.length,
    players_checked:  players.filter(p => p.checked_in_at).length,
    registrations:    regs.length,
  };

  res.json({ players, totals });
});

app.post('/api/admin/events/:id/registrations/:regId/players/:playerIndex/checkin',
  requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
    const reg = db.prepare('SELECT id, players_json FROM registrations WHERE id=? AND event_id=?')
      .get(req.params.regId, req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found' });

    const idx = parseInt(req.params.playerIndex, 10);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid player index' });

    let roster = [];
    try { roster = JSON.parse(reg.players_json || '[]'); } catch {}
    const playerName = (req.body && req.body.player_name) ||
                       (roster[idx] && roster[idx].name) ||
                       `Player ${idx + 1}`;

    db.prepare(`INSERT INTO checkins (registration_id, player_index, player_name, checked_in_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(registration_id, player_index) DO UPDATE SET
                  checked_in_at = CURRENT_TIMESTAMP,
                  checked_in_by = excluded.checked_in_by,
                  player_name   = excluded.player_name`)
      .run(reg.id, idx, playerName, req.admin.id);
    res.json({ ok: true, checked_in_at: new Date().toISOString() });
});

app.delete('/api/admin/events/:id/registrations/:regId/players/:playerIndex/checkin',
  requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
    const idx = parseInt(req.params.playerIndex, 10);
    db.prepare('DELETE FROM checkins WHERE registration_id=? AND player_index=?')
      .run(req.params.regId, idx);
    res.json({ ok: true });
});

// Walk-up = someone shows up at the registration table without having signed
// up online. Two payment paths:
//   • Manual methods (cash / check / venmo / comp / other) — organizer
//     collected the money themselves. Walk-up is created PAID + everyone is
//     auto-checked-in. Optional `reference` is captured for the audit trail
//     (check number, Venmo handle, comp reason, etc.).
//   • Stripe — creates the walk-up as PENDING + opens a Checkout Session
//     against the organizer's Connect account. Returns the URL so the UI
//     can show a QR code on the registration-desk screen. The webhook
//     (checkout.session.completed) flips it to paid AND auto-checks-in.
app.post('/api/admin/events/:id/walkups', requireAuth, requireAdminOrSuper, requireEventAccess, async (req, res) => {
  const { package_id, buyer_name, buyer_email, buyer_phone, players,
          amount_cents, payment_method, reference } = req.body || {};
  if (!package_id || !buyer_name) return res.status(400).json({ error: 'package_id and buyer_name required' });

  const pkg = db.prepare('SELECT id, name, price_cents, includes_players FROM registration_packages WHERE id=? AND event_id=?')
    .get(package_id, req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const playersArr = Array.isArray(players) ? players.filter(p => p && p.name) : [];
  const amt = amount_cents != null && amount_cents !== '' ? Math.max(0, Number(amount_cents)) : pkg.price_cents;
  const id = crypto.randomBytes(8).toString('hex');
  const method = String(payment_method || 'cash').trim().toLowerCase().slice(0, 20);
  const ref    = String(reference || '').trim().slice(0, 80);
  const methodLabel = ref ? `${method} · ${ref}` : method;

  const isStripeWalkup = method === 'stripe';

  // ── Stripe walk-up: pending until paid, opens Checkout Session.
  if (isStripeWalkup) {
    if (amt < 50) return res.status(400).json({ error: 'Stripe charges must be at least $0.50' });
    if (stripeHelper.mode !== 'stripe') {
      return res.status(503).json({ error: 'Stripe is not configured on this server' });
    }

    const event = db.prepare('SELECT id, name, admin_id FROM events WHERE id=?').get(req.params.id);
    const organizer = db.prepare('SELECT stripe_account_id, stripe_charges_enabled FROM admins WHERE id=?').get(event.admin_id);
    if (!organizer?.stripe_account_id || !organizer.stripe_charges_enabled) {
      return res.status(503).json({ error: 'Organizer Stripe account is not ready for charges' });
    }

    const fee = stripeHelper.feeCents(amt);
    db.prepare(`INSERT INTO registrations
      (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
       amount_cents, platform_fee_cents, payment_status, payment_mode, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'stripe', ?)`)
      .run(id, req.params.id, pkg.id, buyer_name.trim(),
           (buyer_email || '').trim().toLowerCase() || null,
           (buyer_phone || '').trim() || null,
           JSON.stringify(playersArr), amt, fee, 'Walk-up (stripe)');

    try {
      const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
      const site = db.prepare('SELECT slug FROM event_sites WHERE event_id=?').get(req.params.id);
      const session = await stripeHelper.createCheckoutSession({
        amountCents:        amt,
        platformFeeCents:   fee,
        connectedAccountId: organizer.stripe_account_id,
        productName:        `${event.name} · Walk-up registration`,
        productDescription: pkg.name,
        buyerEmail:         (buyer_email || '').trim().toLowerCase() || undefined,
        metadata: {
          registration_id: id,
          event_id:        req.params.id,
          walkup:          '1',  // webhook uses this to auto-check-in
        },
        successUrl: `${APP_URL}/e/${site ? site.slug : ''}/confirmation/${id}?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl:  `${APP_URL}/admin/events/${req.params.id}/check-in?canceled=${id}`,
      });
      db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(session.id, id);
      return res.json({ id, status: 'pending', checkout_url: session.url, session_id: session.id });
    } catch (e) {
      console.error('[Stripe walkup]', e);
      db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
      return res.status(502).json({ error: e.message || 'Stripe checkout creation failed' });
    }
  }

  // ── Manual methods (cash / check / venmo / comp / other):
  // record as paid right now, auto-check-in everyone.
  db.prepare(`INSERT INTO registrations
    (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
     amount_cents, platform_fee_cents, payment_status, payment_mode, paid_at, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'paid', 'manual', CURRENT_TIMESTAMP, ?)`)
    .run(id, req.params.id, pkg.id, buyer_name.trim(),
         (buyer_email || '').trim().toLowerCase() || null,
         (buyer_phone || '').trim() || null,
         JSON.stringify(playersArr), amt, `Walk-up (${methodLabel})`);

  const insertCheckin = db.prepare(`INSERT INTO checkins (registration_id, player_index, player_name, checked_in_by)
                                    VALUES (?, ?, ?, ?)`);
  playersArr.forEach((p, i) => insertCheckin.run(id, i, p.name, req.admin.id));

  res.json({ id, status: 'paid', players_checked_in: playersArr.length });
});

// ─── PAIRINGS (E2: groups + hole assignments / tee times) ───────────────────
// Player-centric data model: each row in `pairing_members` is one player in
// one group. A player (= registration_id + player_index) can be in AT MOST
// one group per event (UNIQUE constraint). Unassigned-player pool = paid
// players who don't appear in any pairing_member row.

app.get('/api/admin/events/:id/pairings', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const groups = db.prepare(`SELECT id, name, starting_hole, tee_time, cart_numbers, sort_order, notes, created_at
                             FROM pairing_groups
                             WHERE event_id=?
                             ORDER BY sort_order, starting_hole, created_at`).all(req.params.id);

  const members = db.prepare(`SELECT m.group_id, m.registration_id, m.player_index, m.player_name, m.position,
                                     r.buyer_name, r.payment_status
                              FROM pairing_members m
                              JOIN registrations r ON r.id = m.registration_id
                              WHERE m.event_id=?
                              ORDER BY m.position`).all(req.params.id);
  const byGroup = {};
  for (const m of members) (byGroup[m.group_id] = byGroup[m.group_id] || []).push(m);

  // Build the full player pool (paid registrations + parent-only, walk-ups
  // included). Then mark which are assigned so the UI can show the
  // unassigned pool. Explicitly excludes non-registration packages
  // (sponsorships, donations) so their empty rosters don't create
  // phantom entries.
  const regs = db.prepare(`SELECT r.id, r.buyer_name, r.players_json, r.payment_status, r.payment_mode
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                             AND r.parent_registration_id IS NULL
                             AND COALESCE(p.package_kind, 'registration') = 'registration'`).all(req.params.id);
  const assignedKey = new Set(members.map(m => `${m.registration_id}:${m.player_index}`));
  const checkins = db.prepare(`SELECT registration_id, player_index FROM checkins
                               WHERE registration_id IN (${regs.map(()=>'?').join(',') || "''"})`
                              ).all(...regs.map(r => r.id));
  const checkedKey = new Set(checkins.map(c => `${c.registration_id}:${c.player_index}`));

  const allPlayers = [];
  for (const r of regs) {
    let roster = [];
    try { roster = JSON.parse(r.players_json || '[]'); } catch {}
    roster.forEach((p, i) => {
      const key = `${r.id}:${i}`;
      allPlayers.push({
        reg_id: r.id, player_index: i, player_name: p.name || '(unnamed)',
        buyer_name: r.buyer_name, payment_mode: r.payment_mode,
        assigned: assignedKey.has(key),
        checked_in: checkedKey.has(key),
      });
    });
  }

  res.json({
    groups: groups.map(g => ({ ...g, members: byGroup[g.id] || [] })),
    players: allPlayers,
    totals: {
      players_total:    allPlayers.length,
      players_assigned: allPlayers.filter(p => p.assigned).length,
      groups:           groups.length,
    },
  });
});

app.post('/api/admin/events/:id/pairings/groups', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const b = req.body || {};
  const id = uid('GRP');
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM pairing_groups WHERE event_id=?')
    .get(req.params.id).n || 0) + 1;
  db.prepare(`INSERT INTO pairing_groups (id, event_id, name, starting_hole, tee_time, cart_numbers, sort_order, notes, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.id,
         String(b.name || `Group ${nextSort}`).trim().slice(0, 80),
         b.starting_hole != null && b.starting_hole !== '' ? Math.max(1, Math.min(18, Number(b.starting_hole) || 0)) || null : null,
         (b.tee_time || '').trim().slice(0, 20) || null,
         (b.cart_numbers || '').trim().slice(0, 40) || null,
         b.sort_order != null ? Number(b.sort_order) : nextSort,
         (b.notes || '').trim().slice(0, 200) || null,
         req.admin.id);
  res.json({ id });
});

app.patch('/api/admin/events/:id/pairings/groups/:groupId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM pairing_groups WHERE id=? AND event_id=?').get(req.params.groupId, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Group not found' });
  const n = {
    name:          b.name          != null ? String(b.name).trim().slice(0,80) : cur.name,
    starting_hole: b.starting_hole !== undefined ? (b.starting_hole === '' || b.starting_hole == null ? null : Math.max(1, Math.min(18, Number(b.starting_hole) || 0)) || null) : cur.starting_hole,
    tee_time:      b.tee_time      !== undefined ? (String(b.tee_time||'').trim().slice(0,20) || null) : cur.tee_time,
    cart_numbers:  b.cart_numbers  !== undefined ? (String(b.cart_numbers||'').trim().slice(0,40) || null) : cur.cart_numbers,
    sort_order:    b.sort_order    != null ? Number(b.sort_order) : cur.sort_order,
    notes:         b.notes         !== undefined ? (String(b.notes||'').trim().slice(0,200) || null) : cur.notes,
  };
  db.prepare(`UPDATE pairing_groups SET name=?, starting_hole=?, tee_time=?, cart_numbers=?, sort_order=?, notes=? WHERE id=?`)
    .run(n.name, n.starting_hole, n.tee_time, n.cart_numbers, n.sort_order, n.notes, req.params.groupId);
  res.json({ ok: true });
});

app.delete('/api/admin/events/:id/pairings/groups/:groupId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  // CASCADE on pairing_members handles the unassignments.
  db.prepare('DELETE FROM pairing_groups WHERE id=? AND event_id=?').run(req.params.groupId, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/events/:id/pairings/groups/:groupId/members', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const { registration_id, player_index, player_name } = req.body || {};
  if (!registration_id || player_index == null) return res.status(400).json({ error: 'registration_id and player_index required' });
  // Verify group exists in this event
  const group = db.prepare('SELECT id FROM pairing_groups WHERE id=? AND event_id=?').get(req.params.groupId, req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  // Remove existing assignment if any (move semantics)
  db.prepare('DELETE FROM pairing_members WHERE event_id=? AND registration_id=? AND player_index=?')
    .run(req.params.id, registration_id, player_index);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS n FROM pairing_members WHERE group_id=?').get(req.params.groupId).n || 0) + 1;
  db.prepare(`INSERT INTO pairing_members (group_id, event_id, registration_id, player_index, player_name, position)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.params.groupId, req.params.id, registration_id, Number(player_index),
         (player_name || '').trim() || null, pos);
  res.json({ ok: true });
});

app.delete('/api/admin/events/:id/pairings/groups/:groupId/members/:regId/:idx', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  db.prepare('DELETE FROM pairing_members WHERE group_id=? AND registration_id=? AND player_index=?')
    .run(req.params.groupId, req.params.regId, Number(req.params.idx));
  res.json({ ok: true });
});

// Auto-assign: create N groups of `size` and distribute paid (unassigned)
// players. Strategy:
//   'random'       — shuffle the unassigned pool
//   'alphabetical' — sort by player_name
//   'sequential'   — keep existing order (groups by registration so a
//                    foursome registration stays together)
// Sets starting_hole 1..N when `shotgun` is true so each group has a hole.
app.post('/api/admin/events/:id/pairings/auto-assign', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const { strategy = 'sequential', group_size = 4, shotgun = false, replace = false } = req.body || {};
  const size = Math.max(1, Math.min(8, Number(group_size) || 4));

  // Optionally wipe everything first.
  if (replace) {
    db.prepare('DELETE FROM pairing_groups WHERE event_id=?').run(req.params.id);
  }

  // Build pool of unassigned players. Excludes non-registration packages
  // so sponsors/donors don't show up in pairings.
  const regs = db.prepare(`SELECT r.id, r.buyer_name, r.players_json
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                             AND r.parent_registration_id IS NULL
                             AND COALESCE(p.package_kind, 'registration') = 'registration'`).all(req.params.id);
  const assigned = new Set(
    db.prepare('SELECT registration_id || ":" || player_index AS k FROM pairing_members WHERE event_id=?')
      .all(req.params.id).map(r => r.k)
  );
  let pool = [];
  for (const r of regs) {
    let roster = [];
    try { roster = JSON.parse(r.players_json || '[]'); } catch {}
    roster.forEach((p, i) => {
      const key = `${r.id}:${i}`;
      if (!assigned.has(key)) pool.push({ reg_id: r.id, player_index: i, player_name: p.name || `(unnamed ${i+1})`, buyer_name: r.buyer_name });
    });
  }

  if (strategy === 'random') {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  } else if (strategy === 'alphabetical') {
    pool.sort((a, b) => (a.player_name || '').localeCompare(b.player_name || ''));
  }
  // 'sequential' uses the order as-built (groups buyers together).

  const existingGroupCount = db.prepare('SELECT COUNT(*) AS n FROM pairing_groups WHERE event_id=?').get(req.params.id).n;
  const totalGroupsNeeded = Math.ceil(pool.length / size);
  let createdGroups = 0;

  const insGroup = db.prepare(`INSERT INTO pairing_groups (id, event_id, name, starting_hole, sort_order, created_by)
                               VALUES (?, ?, ?, ?, ?, ?)`);
  const insMember = db.prepare(`INSERT INTO pairing_members (group_id, event_id, registration_id, player_index, player_name, position)
                                VALUES (?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    for (let g = 0; g < totalGroupsNeeded; g++) {
      const sortOrder = existingGroupCount + g + 1;
      const groupId = uid('GRP');
      const hole = shotgun ? ((sortOrder - 1) % 18) + 1 : null;
      insGroup.run(groupId, req.params.id, `Group ${sortOrder}`, hole, sortOrder, req.admin.id);
      createdGroups++;
      const slice = pool.slice(g * size, g * size + size);
      slice.forEach((p, i) => insMember.run(groupId, req.params.id, p.reg_id, p.player_index, p.player_name, i + 1));
    }
  });
  tx();

  res.json({ ok: true, groups_created: createdGroups, players_assigned: pool.length });
});

// ─── SILENT AUCTION (E4) ─────────────────────────────────────────────────
// Items can be created manually by the organizer OR submitted via a public
// intake form (donors offering prizes). Visitors at /e/:slug bid through
// the public endpoint. When closes_at passes, the highest bid wins and the
// organizer can trigger a Stripe Checkout for the winner.

const AUCTION_ITEM_STATUSES = new Set(['pending', 'live', 'ended', 'paid', 'rejected']);

function safeBidderEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Aggregate current high bid + bid count per item. Returns a map keyed by
// item_id with `{ high_cents, bid_count, leader_name }`. One query —
// cheaper than N+1 lookups when rendering the public list.
function _itemBidSummary(eventId) {
  const rows = db.prepare(`
    SELECT b.item_id, COUNT(*) AS bid_count, MAX(b.amount_cents) AS high_cents
    FROM auction_bids b
    WHERE b.event_id=?
    GROUP BY b.item_id
  `).all(eventId);
  const out = new Map();
  for (const r of rows) {
    const leader = db.prepare(`SELECT bidder_name FROM auction_bids
                               WHERE item_id=? AND amount_cents=?
                               ORDER BY created_at LIMIT 1`).get(r.item_id, r.high_cents);
    out.set(r.item_id, { high_cents: r.high_cents, bid_count: r.bid_count, leader_name: leader?.bidder_name || null });
  }
  return out;
}

// Validate + normalize an inbound image data URL. Same rule as brand_logo:
// data:image/* under 2.8 MB. Empty string clears the field; anything else
// fails with 400 so we never write garbage.
function normalizeImageData(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v === 'string' && /^data:image\//i.test(v) && v.length < 2_800_000) return { ok: true, value: v };
  return { ok: false };
}

// ── Admin: list every item for an event (any status) + bid summaries ──
app.get('/api/admin/events/:id/auction', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const items = db.prepare(`SELECT * FROM auction_items WHERE event_id=? ORDER BY sort_order, created_at`).all(req.params.id);
  const summary = _itemBidSummary(req.params.id);
  for (const it of items) {
    const s = summary.get(it.id);
    it.bid_count = s ? s.bid_count : 0;
    it.high_cents = s ? s.high_cents : null;
    it.leader_name = s ? s.leader_name : null;
  }
  res.json({ items });
});

// ── Admin: list bids for a single item (audit / leaderboard) ──
app.get('/api/admin/events/:id/auction/items/:itemId/bids', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const item = db.prepare('SELECT id FROM auction_items WHERE id=? AND event_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const bids = db.prepare(`SELECT id, bidder_name, bidder_email, bidder_phone, amount_cents, created_at
                           FROM auction_bids WHERE item_id=?
                           ORDER BY amount_cents DESC, created_at`).all(req.params.itemId);
  res.json({ bids });
});

// ── Admin: create or upsert an item ──
app.post('/api/admin/events/:id/auction/items', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Title required' });
  const img = normalizeImageData(b.image_data);
  if (!img.ok) return res.status(400).json({ error: 'image_data must be an image data URL under 2.5 MB' });
  const status = AUCTION_ITEM_STATUSES.has(b.status) ? b.status : 'live';
  const id = uid('AI');
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM auction_items WHERE event_id=?')
                      .get(req.params.id).n || 0) + 1;
  db.prepare(`INSERT INTO auction_items
    (id, event_id, title, description, image_data, starting_bid_cents, min_increment_cents,
     fair_value_cents, donor_name, status, opens_at, closes_at, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(id, req.params.id, String(b.title).trim().slice(0, 200),
       (b.description || '').trim().slice(0, 2000) || null,
       img.value,
       Math.max(0, Number(b.starting_bid_cents) || 0),
       Math.max(0, Number(b.min_increment_cents) || 500),
       b.fair_value_cents != null ? Math.max(0, Number(b.fair_value_cents) || 0) : null,
       (b.donor_name || '').trim().slice(0, 120) || null,
       status,
       b.opens_at || null,
       b.closes_at || null,
       Number(b.sort_order) || nextSort);
  res.json({ id });
});

// ── Admin: update an item (status changes, edits, set winner manually) ──
app.patch('/api/admin/events/:id/auction/items/:itemId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const cur = db.prepare('SELECT * FROM auction_items WHERE id=? AND event_id=?').get(req.params.itemId, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Item not found' });
  const b = req.body || {};
  if (b.image_data !== undefined) {
    const img = normalizeImageData(b.image_data);
    if (!img.ok) return res.status(400).json({ error: 'image_data must be an image data URL under 2.5 MB' });
    b.image_data = img.value;
  }
  if (b.status !== undefined && !AUCTION_ITEM_STATUSES.has(b.status)) {
    return res.status(400).json({ error: `Invalid status (must be one of ${[...AUCTION_ITEM_STATUSES].join(', ')})` });
  }
  const n = {
    title:               b.title               !== undefined ? String(b.title).trim().slice(0, 200) : cur.title,
    description:         b.description         !== undefined ? (String(b.description||'').trim().slice(0, 2000) || null) : cur.description,
    image_data:          b.image_data          !== undefined ? b.image_data : cur.image_data,
    starting_bid_cents:  b.starting_bid_cents  !== undefined ? Math.max(0, Number(b.starting_bid_cents) || 0) : cur.starting_bid_cents,
    min_increment_cents: b.min_increment_cents !== undefined ? Math.max(0, Number(b.min_increment_cents) || 0) : cur.min_increment_cents,
    fair_value_cents:    b.fair_value_cents    !== undefined ? (b.fair_value_cents === null || b.fair_value_cents === '' ? null : Math.max(0, Number(b.fair_value_cents) || 0)) : cur.fair_value_cents,
    donor_name:          b.donor_name          !== undefined ? (String(b.donor_name||'').trim().slice(0, 120) || null) : cur.donor_name,
    status:              b.status              !== undefined ? b.status : cur.status,
    opens_at:            b.opens_at            !== undefined ? (b.opens_at || null) : cur.opens_at,
    closes_at:           b.closes_at           !== undefined ? (b.closes_at || null) : cur.closes_at,
    sort_order:          b.sort_order          !== undefined ? Number(b.sort_order) || cur.sort_order : cur.sort_order,
  };
  db.prepare(`UPDATE auction_items
    SET title=?, description=?, image_data=?, starting_bid_cents=?, min_increment_cents=?,
        fair_value_cents=?, donor_name=?, status=?, opens_at=?, closes_at=?, sort_order=?
    WHERE id=?`).run(n.title, n.description, n.image_data, n.starting_bid_cents, n.min_increment_cents,
                     n.fair_value_cents, n.donor_name, n.status, n.opens_at, n.closes_at, n.sort_order,
                     req.params.itemId);
  res.json({ ok: true });
});

app.delete('/api/admin/events/:id/auction/items/:itemId', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  db.prepare('DELETE FROM auction_items WHERE id=? AND event_id=?').run(req.params.itemId, req.params.id);
  res.json({ ok: true });
});

// ── Admin: close an item now (computes winner from highest current bid) ──
// Idempotent — re-running on an already-ended item is a no-op.
app.post('/api/admin/events/:id/auction/items/:itemId/close', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const item = db.prepare('SELECT * FROM auction_items WHERE id=? AND event_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status === 'paid') return res.status(400).json({ error: 'Item already paid — cannot reopen' });
  const top = db.prepare(`SELECT bidder_name, bidder_email, amount_cents
                          FROM auction_bids WHERE item_id=?
                          ORDER BY amount_cents DESC, created_at LIMIT 1`).get(req.params.itemId);
  if (!top) {
    // No bids — mark ended without a winner.
    db.prepare("UPDATE auction_items SET status='ended', winner_email=NULL, winner_name=NULL, winner_bid_cents=NULL WHERE id=?")
      .run(req.params.itemId);
    return res.json({ ok: true, status: 'ended', winner: null });
  }
  db.prepare(`UPDATE auction_items
    SET status='ended', winner_email=?, winner_name=?, winner_bid_cents=?
    WHERE id=?`).run(top.bidder_email, top.bidder_name, top.amount_cents, req.params.itemId);
  res.json({ ok: true, status: 'ended', winner: { name: top.bidder_name, email: top.bidder_email, amount_cents: top.amount_cents } });
});

// ── Public: list LIVE items for an event slug ──
app.get('/api/event-sites/:slug/auction', (req, res) => {
  const site = db.prepare(`SELECT event_id, auction_enabled, auction_intake_enabled, auction_intro
                           FROM event_sites WHERE slug=? AND published=1`).get(req.params.slug);
  if (!site) return res.status(404).json({ error: 'Event not found' });
  if (!site.auction_enabled) return res.json({ auction_enabled: false, items: [] });
  const now = new Date().toISOString();
  // Include items in 'live' or 'ended' status — 'ended' show as closed
  // with a "Sold to …" tag so the public sees outcomes. Skip pending/
  // rejected/paid (paid = no longer interesting publicly).
  const items = db.prepare(`SELECT id, title, description, image_data,
                                   starting_bid_cents, min_increment_cents, fair_value_cents,
                                   donor_name, status, opens_at, closes_at,
                                   winner_name, winner_bid_cents
                            FROM auction_items
                            WHERE event_id=? AND status IN ('live','ended')
                            ORDER BY sort_order, created_at`).all(site.event_id);
  const summary = _itemBidSummary(site.event_id);
  for (const it of items) {
    const s = summary.get(it.id);
    it.high_cents = s ? s.high_cents : null;
    it.bid_count = s ? s.bid_count : 0;
    // Public sees leader's name when bids exist — typical silent-auction
    // transparency. Email never exposed.
    it.leader_name = s ? s.leader_name : null;
    // Compute live/closed state from the timestamps in addition to the
    // status column — so a forgotten 'live' item auto-shows as closed
    // when its closes_at passed.
    it.bidding_open = it.status === 'live' &&
                      (!it.opens_at || it.opens_at <= now) &&
                      (!it.closes_at || it.closes_at > now);
  }
  res.json({
    auction_enabled: true,
    intake_enabled: !!site.auction_intake_enabled,
    intro: site.auction_intro || null,
    items,
  });
});

// ── Public: place a bid ──
app.post('/api/auctions/:itemId/bid', (req, res) => {
  const b = req.body || {};
  const name = (b.bidder_name || '').trim();
  const email = (b.bidder_email || '').trim().toLowerCase();
  const amount = Math.floor(Number(b.amount_cents) || 0);
  if (!name) return res.status(400).json({ error: 'Bidder name required' });
  if (!safeBidderEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  if (amount <= 0) return res.status(400).json({ error: 'Bid amount required' });

  const item = db.prepare('SELECT * FROM auction_items WHERE id=?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'live') return res.status(400).json({ error: 'Bidding is closed for this item' });

  const now = new Date().toISOString();
  if (item.opens_at && item.opens_at > now) return res.status(400).json({ error: 'Bidding hasn\'t opened yet' });
  if (item.closes_at && item.closes_at <= now) return res.status(400).json({ error: 'Bidding has closed' });

  // Validate minimum: starting bid or current high + increment.
  const top = db.prepare(`SELECT MAX(amount_cents) AS high FROM auction_bids WHERE item_id=?`).get(req.params.itemId);
  const currentHigh = top && top.high ? top.high : 0;
  const minNext = currentHigh
    ? currentHigh + (item.min_increment_cents || 0)
    : (item.starting_bid_cents || 0);
  if (amount < minNext) {
    return res.status(400).json({ error: `Bid must be at least $${(minNext/100).toFixed(2)}`, min_next_cents: minNext });
  }

  const id = uid('BID');
  db.prepare(`INSERT INTO auction_bids
    (id, item_id, event_id, bidder_name, bidder_email, bidder_phone, amount_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.itemId, item.event_id, name.slice(0, 120), email,
         (b.bidder_phone || '').trim().slice(0, 40) || null, amount);
  res.json({ ok: true, id, amount_cents: amount, leader_name: name, leading: true });
});

// ── Public: submit an item for the silent auction (donor intake) ──
app.post('/api/event-sites/:slug/auction-intake', (req, res) => {
  const site = db.prepare(`SELECT event_id, auction_enabled, auction_intake_enabled
                           FROM event_sites WHERE slug=? AND published=1`).get(req.params.slug);
  if (!site) return res.status(404).json({ error: 'Event not found' });
  if (!site.auction_enabled || !site.auction_intake_enabled) {
    return res.status(400).json({ error: 'Item submissions are not open for this event' });
  }
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Item title required' });
  if (!b.donor_name || !String(b.donor_name).trim()) return res.status(400).json({ error: 'Your name is required' });
  const img = normalizeImageData(b.image_data);
  if (!img.ok) return res.status(400).json({ error: 'image_data must be an image data URL under 2.5 MB' });

  const id = uid('AI');
  db.prepare(`INSERT INTO auction_items
    (id, event_id, title, description, image_data, starting_bid_cents, min_increment_cents,
     fair_value_cents, donor_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
  .run(id, site.event_id, String(b.title).trim().slice(0, 200),
       (b.description || '').trim().slice(0, 2000) || null,
       img.value,
       Math.max(0, Number(b.starting_bid_cents) || 0),
       Math.max(0, Number(b.min_increment_cents) || 500),
       b.fair_value_cents != null ? Math.max(0, Number(b.fair_value_cents) || 0) : null,
       String(b.donor_name).trim().slice(0, 120));
  res.json({ ok: true, id });
});

// ── Admin: trigger Stripe Checkout for the winner ──
app.post('/api/admin/events/:id/auction/items/:itemId/checkout-winner', requireAuth, requireAdminOrSuper, requireEventAccess, async (req, res) => {
  const item = db.prepare('SELECT * FROM auction_items WHERE id=? AND event_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status === 'paid') return res.status(400).json({ error: 'Item already paid' });
  if (!item.winner_email || !item.winner_bid_cents) {
    return res.status(400).json({ error: 'No winner recorded — close the auction first to pick one.' });
  }
  const event = db.prepare('SELECT id, name, admin_id FROM events WHERE id=?').get(item.event_id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const site = db.prepare('SELECT slug FROM event_sites WHERE event_id=?').get(item.event_id);

  // Lazy-upsert an 'auction_item' package row to satisfy the FK on
  // registrations. One package per item — keeps the dashboard line-itemy.
  let pkg = db.prepare("SELECT * FROM registration_packages WHERE event_id=? AND package_kind='auction_item' AND name=?")
    .get(item.event_id, ('Auction: ' + item.title).slice(0, 80));
  if (!pkg) {
    const pkgId = uid('PKG');
    db.prepare(`INSERT INTO registration_packages
      (id, event_id, name, description, price_cents, includes_players, sort_order, active, package_kind)
      VALUES (?, ?, ?, ?, ?, 0, 999, 1, 'auction_item')`)
      .run(pkgId, item.event_id, ('Auction: ' + item.title).slice(0, 80), item.description || null, item.winner_bid_cents);
    pkg = db.prepare('SELECT * FROM registration_packages WHERE id=?').get(pkgId);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const amount = item.winner_bid_cents;
  const platform_fee_cents = stripeHelper.feeCents(amount);
  const confirmationPath = (regId) => site && site.slug ? `/e/${site.slug}/confirmation/${regId}` : `/registrations/${regId}`;

  if (stripeHelper.mode === 'mock') {
    db.prepare(`INSERT INTO registrations
      (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
       amount_cents, platform_fee_cents, payment_status, payment_mode, paid_at, description)
      VALUES (?, ?, ?, ?, ?, NULL, '[]', ?, ?, 'paid', 'mock', CURRENT_TIMESTAMP, ?)`)
      .run(id, item.event_id, pkg.id, item.winner_name || 'Auction winner',
           item.winner_email, amount, platform_fee_cents,
           'Auction win: ' + item.title);
    db.prepare("UPDATE auction_items SET status='paid', winner_registration_id=? WHERE id=?").run(id, req.params.itemId);
    return res.json({ id, confirmation_url: confirmationPath(id), payment_mode: 'mock', status: 'paid' });
  }

  if (!event.admin_id) return res.status(503).json({ error: 'This event has no organizer on file' });
  const organizer = db.prepare(`SELECT stripe_account_id, stripe_charges_enabled
                                FROM admins WHERE id=?`).get(event.admin_id);
  if (!organizer || !organizer.stripe_account_id || !organizer.stripe_charges_enabled) {
    return res.status(503).json({ error: 'Organizer Stripe account is not active — cannot bill the winner.' });
  }

  db.prepare(`INSERT INTO registrations
    (id, event_id, package_id, buyer_name, buyer_email, buyer_phone, players_json,
     amount_cents, platform_fee_cents, payment_status, payment_mode, description)
    VALUES (?, ?, ?, ?, ?, NULL, '[]', ?, ?, 'pending', 'stripe', ?)`)
    .run(id, item.event_id, pkg.id, item.winner_name || 'Auction winner',
         item.winner_email, amount, platform_fee_cents,
         'Auction win: ' + item.title);
  db.prepare('UPDATE auction_items SET winner_registration_id=? WHERE id=?').run(id, req.params.itemId);

  try {
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    const session = await stripeHelper.createCheckoutSession({
      amountCents:        amount,
      platformFeeCents:   platform_fee_cents,
      connectedAccountId: organizer.stripe_account_id,
      productName:        `${event.name} · Auction: ${item.title}`,
      productDescription: item.description || undefined,
      buyerEmail:         item.winner_email,
      metadata: { registration_id: id, event_id: item.event_id, package_id: pkg.id, auction_item_id: item.id, kind: 'auction_winner', jord: '1' },
      successUrl: `${APP_URL}${confirmationPath(id)}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${APP_URL}/e/${site ? site.slug : ''}/auction?canceled=1`,
    });
    db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(session.id, id);
    res.json({ id, checkout_url: session.url, session_id: session.id, payment_mode: 'stripe' });
  } catch (e) {
    console.error('[Stripe auction checkout]', e);
    db.prepare("UPDATE registrations SET payment_status='failed' WHERE id=?").run(id);
    res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }
});

// ─── SCORING BRIDGE (Enterprise event → Clubhouse tournament/round) ────────
// One paid registration's player roster becomes scoring entries in a real
// tournament so the leaderboard at /tournament/:id pulls from the field
// the organizer already sold. The bridge is idempotent: re-running adds
// only players that aren't already in the round.

// Returns the linked tournament/round summary if scoring has been started,
// or { tournament_id: null } if not.
app.get('/api/admin/events/:id/scoring', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE event_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  if (!t) return res.json({ tournament_id: null });
  const rounds = db.prepare('SELECT * FROM rounds WHERE tournament_id=? ORDER BY round_number').all(t.id);
  const round = rounds[0] || null;
  const entries = round
    ? db.prepare('SELECT COUNT(*) AS n FROM round_entries WHERE round_id=?').get(round.id).n
    : 0;
  const teams = round
    ? db.prepare('SELECT COUNT(*) AS n FROM round_teams WHERE round_id=?').get(round.id).n
    : 0;
  res.json({
    tournament_id: t.id,
    round_id: round ? round.id : null,
    format: t.default_format,
    name: t.name,
    status: t.status,
    entries_count: entries,
    teams_count: teams,
  });
});

// Helper: upsert a player row from a registration entry. Dedupe by phone if
// the buyer supplied one; otherwise create a fresh player every call (we'd
// rather have a duplicate than collapse two different people sharing a name).
function upsertPlayerFromReg(name, phone, email, handicapIndex) {
  let player = phone ? db.prepare('SELECT * FROM players WHERE phone=?').get(phone) : null;
  if (player) {
    if (handicapIndex != null) {
      db.prepare('UPDATE players SET handicap_index=? WHERE id=?').run(handicapIndex, player.id);
    }
    return player;
  }
  const pid = uid('PLR');
  db.prepare('INSERT INTO players (id,name,phone,email,handicap_index) VALUES (?,?,?,?,?)')
    .run(pid, name, phone || null, email || null, handicapIndex ?? null);
  return { id: pid, name, phone, email, handicap_index: handicapIndex ?? null };
}

// Internal: add paid registrations to the round. Returns counts. The
// `existingEntries` set lets us skip players who are already in the round
// (used by sync-scoring; start-scoring passes an empty set).
function _materializeRegistrationsToRound(eventId, roundId, fmt, isTeamCard, existingKeys) {
  // Only player-ticket registrations contribute to the scoring round.
  // Sponsorships + donations have empty rosters; even so, we filter
  // here defensively so the leaderboard never inherits stray names.
  const regs = db.prepare(`SELECT r.id, r.buyer_name, r.buyer_email, r.buyer_phone, r.players_json
                           FROM registrations r
                           JOIN registration_packages p ON p.id = r.package_id
                           WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                             AND r.parent_registration_id IS NULL
                             AND COALESCE(p.package_kind, 'registration') = 'registration'`).all(eventId);

  let entriesAdded = 0, teamsAdded = 0, regsProcessed = 0;

  // `source_registration_id` + `source_player_index` are written on each
  // entry so we can later re-sync pairing-group assignments after the
  // organizer edits pairings — without those, there's no way to map a
  // round_entry back to its pairing_member row.
  const insEntryIndividual = db.prepare(`INSERT INTO round_entries (id,round_id,player_id,course_handicap,source_registration_id,source_player_index) VALUES (?,?,?,?,?,?)`);
  const insTeam = db.prepare(`INSERT INTO round_teams (id,round_id,name,team_handicap) VALUES (?,?,?,?)`);
  const insEntryTeam = db.prepare(`INSERT INTO round_entries (id,round_id,player_id,team_id,is_team_card,course_handicap,source_registration_id,source_player_index) VALUES (?,?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    for (const r of regs) {
      let roster = [];
      try { roster = JSON.parse(r.players_json || '[]'); } catch {}
      if (!roster.length) continue;
      regsProcessed++;

      // Registration-keyed dedupe — once a registration's players are in
      // the round, sync skips it entirely.
      const regKey = `reg:${r.id}`;
      if (existingKeys.has(regKey)) continue;

      // Team-tier formats: each registration becomes one team. Player 0
      // inherits the buyer's contact info (phone/email).
      if (isTeamCard) {
        const teamName = (r.buyer_name || roster[0]?.name || 'Team').slice(0, 80);
        const teamId = uid('TM');
        insTeam.run(teamId, roundId, teamName, null);
        teamsAdded++;
        for (let i = 0; i < roster.length; i++) {
          const p = roster[i] || {};
          const phone = i === 0 ? r.buyer_phone : null;
          const email = i === 0 ? r.buyer_email : null;
          const player = upsertPlayerFromReg(p.name || `Player ${i + 1}`, phone, email, null);
          // First player carries the shared team scorecard (`is_team_card=1`).
          insEntryTeam.run(uid('ENT'), roundId, player.id, teamId, i === 0 ? 1 : 0, null, r.id, i);
          entriesAdded++;
        }
      } else {
        // Individual-tier formats: each player gets their own entry.
        for (let i = 0; i < roster.length; i++) {
          const p = roster[i] || {};
          const phone = i === 0 ? r.buyer_phone : null;
          const email = i === 0 ? r.buyer_email : null;
          const player = upsertPlayerFromReg(p.name || `Player ${i + 1}`, phone, email, null);
          insEntryIndividual.run(uid('ENT'), roundId, player.id, null, r.id, i);
          entriesAdded++;
        }
      }
      existingKeys.add(regKey);
    }
  });
  tx();
  return { entriesAdded, teamsAdded, regsProcessed };
}

// Mirror pairing_groups → score_groups for the round, then set
// round_entries.group_id to match each entry's pairing assignment. Idempotent
// — re-runnable after the organizer edits pairings. Returns counts so the
// UI can show a "Updated 8 groups, 32 players" toast.
function _syncPairingsToScoreGroups(eventId, roundId, format) {
  const fmt = formats.getFormat(format);
  const isTeamCard = fmt && typeof fmt.allowance === 'string';

  const pgs = db.prepare(`SELECT id, name, starting_hole, tee_time
                          FROM pairing_groups WHERE event_id=?
                          ORDER BY sort_order, starting_hole, created_at`).all(eventId);

  // Build pairing_member lookup keyed by "reg_id:player_index" → pairing_group_id.
  const pms = db.prepare(`SELECT registration_id, player_index, group_id
                          FROM pairing_members WHERE event_id=?`).all(eventId);
  const memberToGroup = new Map();
  for (const m of pms) memberToGroup.set(`${m.registration_id}:${m.player_index}`, m.group_id);

  let scoreGroupsCreated = 0, scoreGroupsUpdated = 0, scoreGroupsDeleted = 0, entriesAssigned = 0;

  // Upsert score_groups matched by pairing_group_id (the link column added
  // in v3.44). Match-by-name is brittle when an organizer renames a group.
  const pairingGroupIds = new Set(pgs.map(g => g.id));
  const pgToSg = new Map();   // pairing_group_id → score_group.id
  const existing = db.prepare('SELECT id, pairing_group_id, name, starting_hole, tee_time FROM score_groups WHERE round_id=?').all(roundId);
  const existingByPg = new Map();
  for (const sg of existing) if (sg.pairing_group_id) existingByPg.set(sg.pairing_group_id, sg);

  const tx = db.transaction(() => {
    for (const pg of pgs) {
      const cur = existingByPg.get(pg.id);
      if (cur) {
        // Refresh name / hole / tee when the pairing was edited after start.
        if (cur.name !== pg.name || cur.starting_hole !== pg.starting_hole || cur.tee_time !== pg.tee_time) {
          db.prepare('UPDATE score_groups SET name=?, starting_hole=?, tee_time=? WHERE id=?')
            .run(pg.name, pg.starting_hole, pg.tee_time, cur.id);
          scoreGroupsUpdated++;
        }
        pgToSg.set(pg.id, cur.id);
      } else {
        const sgId = uid('SG');
        db.prepare(`INSERT INTO score_groups (id, round_id, name, tee_time, starting_hole, pairing_group_id)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(sgId, roundId, pg.name, pg.tee_time, pg.starting_hole, pg.id);
        scoreGroupsCreated++;
        pgToSg.set(pg.id, sgId);
      }
    }

    // Drop score_groups whose pairing_group has been deleted. NULL the
    // round_entries.group_id pointer first since we don't have CASCADE.
    for (const sg of existing) {
      if (sg.pairing_group_id && !pairingGroupIds.has(sg.pairing_group_id)) {
        db.prepare('UPDATE round_entries SET group_id=NULL WHERE round_id=? AND group_id=?').run(roundId, sg.id);
        db.prepare('DELETE FROM score_groups WHERE id=?').run(sg.id);
        scoreGroupsDeleted++;
      }
    }

    // Re-assign each round_entry's group_id from its source registration's
    // pairing. For team-card formats, force every entry in the same team
    // to share the team-captain's group so the team isn't split across
    // groups on the leaderboard.
    const entries = db.prepare(`SELECT id, team_id, is_team_card, source_registration_id, source_player_index
                                FROM round_entries WHERE round_id=?`).all(roundId);
    const upd = db.prepare('UPDATE round_entries SET group_id=? WHERE id=?');

    if (isTeamCard) {
      // Pick the captain's (player_index=0) group per team.
      const teamGroup = new Map();
      for (const e of entries) {
        if (!e.team_id) continue;
        if (e.source_registration_id != null && e.source_player_index === 0) {
          const key = `${e.source_registration_id}:0`;
          const pg = memberToGroup.get(key);
          if (pg) teamGroup.set(e.team_id, pgToSg.get(pg) || null);
        }
      }
      for (const e of entries) {
        const target = e.team_id ? (teamGroup.get(e.team_id) || null) : null;
        upd.run(target, e.id);
        if (target) entriesAssigned++;
      }
    } else {
      for (const e of entries) {
        const key = e.source_registration_id != null
          ? `${e.source_registration_id}:${e.source_player_index ?? 0}`
          : null;
        const pgId = key ? memberToGroup.get(key) : null;
        const sgId = pgId ? pgToSg.get(pgId) || null : null;
        upd.run(sgId, e.id);
        if (sgId) entriesAssigned++;
      }
    }
  });
  tx();

  return { score_groups_created: scoreGroupsCreated, score_groups_updated: scoreGroupsUpdated,
           score_groups_deleted: scoreGroupsDeleted, entries_assigned: entriesAssigned,
           pairing_groups: pgs.length };
}

// Start scoring for an enterprise event. Creates a Clubhouse tournament
// linked via tournaments.event_id, an initial round, and materializes
// every paid registration into round_entries / round_teams. Idempotent
// for the tournament/round (re-running just returns the existing IDs).
app.post('/api/admin/events/:id/start-scoring', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const eventId = req.params.id;
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const requested = (req.body && req.body.format) || 'scramble_4p';
  if (!scoring.SUPPORTED_FORMATS.includes(requested)) {
    return res.status(400).json({ error: `Unknown format "${requested}"` });
  }
  const fmt = formats.getFormat(requested);
  // Team-card formats use a single shared scorecard (scramble / foursomes /
  // greensome). Anything else has each player keeping their own ball, even
  // when grouped into a team (best ball etc.).
  const isTeamCard = typeof fmt.allowance === 'string';

  // Reuse an existing scoring setup so the button is safe to click twice.
  const existing = db.prepare('SELECT * FROM tournaments WHERE event_id=?').get(eventId);
  let tournamentId, roundId;
  if (existing) {
    tournamentId = existing.id;
    const round = db.prepare('SELECT id FROM rounds WHERE tournament_id=? ORDER BY round_number LIMIT 1').get(tournamentId);
    roundId = round ? round.id : null;
    if (!roundId) {
      // Tournament exists with no round — recover by creating one.
      roundId = uid('RND');
      db.prepare(`INSERT INTO rounds (id,tournament_id,round_number,round_date,format,hole_multipliers)
                  VALUES (?,?,?,?,?,?)`).run(roundId, tournamentId, 1, ev.starts_at?.split(' ')[0] || null, requested, holeMultipliers(requested));
    }
  } else {
    tournamentId = uid('TRN');
    db.prepare(`INSERT INTO tournaments (id,type,name,admin_id,event_id,default_format,share_code,status)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(tournamentId, 'tournament', ev.name || 'Tournament', req.admin.id, eventId,
           requested, uid('').slice(0, 6), 'setup');
    roundId = uid('RND');
    db.prepare(`INSERT INTO rounds (id,tournament_id,round_number,round_date,format,hole_multipliers)
                VALUES (?,?,?,?,?,?)`).run(roundId, tournamentId, 1, ev.starts_at?.split(' ')[0] || null, requested, holeMultipliers(requested));
  }

  // Compute existing registration-keyed entries so we skip duplicates if
  // the user re-clicks "Start scoring" or has a partial materialization.
  const existingKeys = new Set();
  const counts = _materializeRegistrationsToRound(eventId, roundId, fmt, isTeamCard, existingKeys);
  // Mirror any existing pairings into score_groups + assign each entry's
  // group_id so the leaderboard groups players by foursome from the start.
  const groupCounts = _syncPairingsToScoreGroups(eventId, roundId, requested);

  res.json({
    tournament_id: tournamentId,
    round_id: roundId,
    format: requested,
    is_team_card: isTeamCard,
    ...counts,
    ...groupCounts,
  });
});

// Sync: pull in any paid registrations that weren't in the round yet (e.g.
// walk-ups added after start-scoring ran). Same format as the existing
// round; no format choice exposed here.
app.post('/api/admin/events/:id/sync-scoring', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const eventId = req.params.id;
  const t = db.prepare('SELECT * FROM tournaments WHERE event_id=?').get(eventId);
  if (!t) return res.status(400).json({ error: 'Scoring not started yet — use Start scoring first.' });
  const round = db.prepare('SELECT id FROM rounds WHERE tournament_id=? ORDER BY round_number LIMIT 1').get(t.id);
  if (!round) return res.status(400).json({ error: 'No round on tournament' });

  const fmt = formats.getFormat(t.default_format);
  const isTeamCard = typeof fmt.allowance === 'string';

  // existingKeys: which registrations are already represented (one team
  // per reg for team-card, or any entry from any player in the reg).
  const existingKeys = new Set();
  if (isTeamCard) {
    // Teams are named after the buyer; key by team name → registration buyer name.
    const teams = db.prepare('SELECT name FROM round_teams WHERE round_id=?').all(round.id);
    for (const tm of teams) existingKeys.add(`team:${tm.name}`);
    // Also lock anything already keyed by reg id (newer flows). Only
    // player-ticket registrations matter here — sync uses the same
    // package_kind filter as the materializer.
    const regs = db.prepare(`SELECT r.id, r.buyer_name FROM registrations r
                             JOIN registration_packages p ON p.id = r.package_id
                             WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                               AND r.parent_registration_id IS NULL
                               AND COALESCE(p.package_kind, 'registration') = 'registration'`).all(eventId);
    for (const r of regs) {
      if (existingKeys.has(`team:${(r.buyer_name || 'Team').slice(0, 80)}`)) {
        existingKeys.add(`reg:${r.id}`);
      }
    }
  } else {
    // Individual: match by phone where the buyer carried one.
    const phones = db.prepare(`SELECT DISTINCT p.phone FROM round_entries re
                               JOIN players p ON p.id = re.player_id
                               WHERE re.round_id=? AND p.phone IS NOT NULL`).all(round.id).map(r => r.phone);
    const phoneSet = new Set(phones);
    const regs = db.prepare(`SELECT r.id, r.buyer_phone FROM registrations r
                             JOIN registration_packages p ON p.id = r.package_id
                             WHERE r.event_id=? AND r.payment_status IN ('paid','partial_refund')
                               AND r.parent_registration_id IS NULL
                               AND COALESCE(p.package_kind, 'registration') = 'registration'`).all(eventId);
    for (const r of regs) if (r.buyer_phone && phoneSet.has(r.buyer_phone)) existingKeys.add(`reg:${r.id}`);
  }

  const counts = _materializeRegistrationsToRound(eventId, round.id, fmt, isTeamCard, existingKeys);
  // Always re-sync pairing groups on sync — picks up any pairing edits
  // the organizer made after start-scoring (renamed groups, moved players,
  // new walk-up assignments, etc.).
  const groupCounts = _syncPairingsToScoreGroups(eventId, round.id, t.default_format);
  res.json({ tournament_id: t.id, round_id: round.id, ...counts, ...groupCounts });
});

// Re-mirror pairings into score_groups + reassign round_entries.group_id
// without adding any new players. Use this when the organizer just wants
// to push pairing changes through to the leaderboard.
app.post('/api/admin/events/:id/sync-pairings-to-scoring', requireAuth, requireAdminOrSuper, requireEventAccess, (req, res) => {
  const eventId = req.params.id;
  const t = db.prepare('SELECT * FROM tournaments WHERE event_id=?').get(eventId);
  if (!t) return res.status(400).json({ error: 'Scoring not started yet — use Start scoring first.' });
  const round = db.prepare('SELECT id FROM rounds WHERE tournament_id=? ORDER BY round_number LIMIT 1').get(t.id);
  if (!round) return res.status(400).json({ error: 'No round on tournament' });
  const counts = _syncPairingsToScoreGroups(eventId, round.id, t.default_format);
  res.json({ tournament_id: t.id, round_id: round.id, ...counts });
});

app.get('/api/users/me', requireUser, (req, res) => {
  res.json({ user: {
    id: req.user.id, name: req.user.name, email: req.user.email,
    handicap_index: req.user.handicap_index, ghin_id: req.user.ghin_id,
  }});
});

// ─── PAGES ───────────────────────────────────────────────────────────────────
const pages = { '/': 'landing.html', '/landing': 'landing.html', '/about': 'about.html', '/signup': 'signup.html',
  '/admin': 'admin.html',
  '/admin/admins':   'admin/admins.html',
  '/admin/reps':     'admin/reps.html',
  '/admin/backups':  'admin/backups.html',
  '/admin/global':   'admin/global.html',
  '/admin/requests': 'admin/requests.html',
  // More-specific event routes MUST be declared before the catch-all
  // `:tab` pattern below, or Express's first-match wins serves the editor
  // for everything (saw this with /registrations being shadowed in v3.33.0).
  '/admin/events/:id/site/edit':      'admin/event-site-editor.html',
  '/admin/events/:id/registrations':  'admin/event-registrations.html',
  '/admin/events/:id/check-in':       'admin/event-checkin.html',
  '/admin/events/:id/pairings/poster': 'admin/event-pairings-poster.html',
  '/admin/events/:id/pairings':       'admin/event-pairings.html',
  '/admin/events/:id/auction':        'admin/event-auction.html',
  '/admin/events/:id':       'admin/editor.html',
  '/admin/events/:id/:tab':  'admin/editor.html',
  '/admin/stripe-connect':       'admin/stripe-connect.html',
  '/register/:id': 'register.html',
  '/team/:eid/:share': 'team.html',
  '/scan': 'scan.html', '/scan/:code': 'scan.html', '/leaderboard/:id': 'leaderboard.html',
  '/dashboard/:eid/:code': 'dashboard.html', '/monitor/:id': 'monitor.html',
  '/global': 'global.html', '/test': 'test.html', '/system-summary': 'system-summary.html',
  '/clubhouse': 'tournaments.html',             // create & manage games (admin hub)
  '/login':     'login.html',                   // user (personal/player) sign-in + sign-up
  '/e/:slug/register':              'event-register.html',     // registration form + checkout
  '/e/:slug/confirmation/:regId':   'event-confirmation.html', // post-checkout thank-you
  '/e/:slug/auction':               'event-auction.html',      // public silent auction (E4)
  '/e/:slug/donate-item':           'event-donate-item.html',  // public item-intake form (E4)
  '/e/:slug':   'event-site.html',              // public brandable event site (E1)
  '/scorecard/:roundId': 'scorecard.html',     // score entry (public, via link)
  '/live/:roundId': 'live.html',               // round live leaderboard (public)
  '/tournament/:id': 'tournament-live.html' }; // cumulative tournament leaderboard
Object.entries(pages).forEach(([route, file]) => {
  app.get(route, (_, res) => res.sendFile(path.join(__dirname, 'public', file)));
});

// ─── ERROR HANDLING ──────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// ─── START ────────────────────────────────────────────────────────────────────
backup.scheduleDailyBackups(db, DB_PATH);
console.log(`[Backup] Daily backups scheduled (local: ${backup.backupDir(DB_PATH)}, S3: ${process.env.S3_BUCKET ? 'enabled' : 'disabled'})`);

console.log(`[Server] Starting on 0.0.0.0:${PORT}... [LIVE BUILD]`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   JORD Golf Tournament System  v3.5.0               ║
║   http://localhost:${PORT}                              ║
║                                                      ║
║   Admin:       /admin                               ║
║   Monitor:     /monitor/:eventId                    ║
║   Leaderboard: /leaderboard/:eventId                ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app; // for testing
