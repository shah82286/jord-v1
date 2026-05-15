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
    await sendEmailDirect(email, msg.EmailSubject, msg.EmailBodyHtml);
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
  // Email the reset link to the account holder (non-blocking). _reset_url is
  // still returned so a super admin can share it manually as a fallback.
  setImmediate(async () => {
    try {
      const m = msgPasswordReset({ name: admin.name, resetUrl });
      await sendEmailDirect(admin.email, m.EmailSubject, m.EmailBodyHtml);
    } catch (e) { console.error('[Email] password-reset send error:', e.message); }
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
      await sendEmailDirect(admin.email, m.EmailSubject, m.EmailBodyHtml);
    } catch (e) { console.error('[Email] admin password-reset send error:', e.message); }
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

  // Email the new rep their welcome + temp password (non-blocking).
  setImmediate(async () => {
    try {
      const m = msgAccountWelcome({
        name: name.trim(), roleLabel: 'Tournament Rep',
        email: email.toLowerCase().trim(), tempPassword: finalPassword,
        loginUrl: `${APP_URL}/admin`,
      });
      await sendEmailDirect(email.toLowerCase().trim(), m.EmailSubject, m.EmailBodyHtml);
    } catch (e) { console.error('[Email] rep welcome send error:', e.message); }
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
      await sendEmailDirect(target.email, m.EmailSubject, m.EmailBodyHtml);
    } catch (e) { console.error('[Email] rep password-reset send error:', e.message); }
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

app.patch('/api/events/:id', requireAuth, requireAdminOrSuper, (req, res) => {
  const allowed = ['name','venue','starts_at','ends_at','status','has_longest_drive','has_closest_pin',
    'combined_scoring','allow_rough','rough_penalty_mode','rough_fixed_yards','allow_oob',
    'oob_penalty_mode','oob_fixed_yards','hole_distance_yards',
    'fairway_polygon','rough_polygon','oob_polygon','green_polygon',
    'pin_lat','pin_lon',
    'ctp_green_polygon','ctp_pin_lat','ctp_pin_lon','ctp_hole_distance_yards',
    'cp_off_green_penalty_ft','admin_phone','venue_lat','venue_lon','zone_visibility',
    'is_charity','brand_enabled','brand_logo','brand_accent','brand_url'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE events SET ${updates.map(([k])=>`${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v])=>v), req.params.id);
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
        if (p.email) await sendEmailDirect(p.email, msg.EmailSubject, msg.EmailBodyHtml);
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
        if (p1.email) await sendEmailDirect(p1.email, tc.EmailSubject, tc.EmailBodyHtml);
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
      if (email) await sendEmailDirect(email, msg.EmailSubject, msg.EmailBodyHtml);
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

    // Auto-reply to the person who submitted the request (non-blocking, on-brand).
    if (admin_email) {
      const firstName = String(admin_name || '').trim().split(/\s+/)[0] || '';
      const m = msgSignupReceived({ name: firstName, tournamentName: tournament_name });
      sendEmailDirect(admin_email, m.EmailSubject, m.EmailBodyHtml)
        .catch(e => console.error('[Email] signup auto-reply error:', e.message));
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
  db.prepare(`INSERT INTO events
    (id,name,venue,starts_at,ends_at,has_longest_drive,has_closest_pin,admin_phone,admin_id,venue_lat,venue_lon,
     is_charity,brand_enabled,brand_logo,brand_accent,brand_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(eventId, draft.name, draft.venue, draft.starts_at, draft.ends_at,
         draft.has_longest_drive, draft.has_closest_pin, draft.admin_phone, ownerAdminId,
         draft.venue_lat, draft.venue_lon,
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

// ─── PAGES ───────────────────────────────────────────────────────────────────
const pages = { '/': 'landing.html', '/landing': 'landing.html', '/about': 'about.html', '/signup': 'signup.html',
  '/admin': 'admin.html',
  '/admin/admins':   'admin/admins.html',
  '/admin/reps':     'admin/reps.html',
  '/admin/backups':  'admin/backups.html',
  '/admin/global':   'admin/global.html',
  '/admin/requests': 'admin/requests.html',
  '/admin/events/:id':       'admin/editor.html',
  '/admin/events/:id/:tab':  'admin/editor.html',
  '/register/:id': 'register.html',
  '/team/:eid/:share': 'team.html',
  '/scan': 'scan.html', '/scan/:code': 'scan.html', '/leaderboard/:id': 'leaderboard.html',
  '/dashboard/:eid/:code': 'dashboard.html', '/monitor/:id': 'monitor.html',
  '/global': 'global.html', '/test': 'test.html', '/system-summary': 'system-summary.html' };
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
