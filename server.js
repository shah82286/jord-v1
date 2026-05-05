/**
 * JORD Golf Tournament System — Server
 * Version: 1.0.0 | Built: 2026-04-26
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
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD  || 'jord2026';
const MAPBOX_TOKEN   = env.MAPBOX_TOKEN   || process.env.MAPBOX_TOKEN    || '';
const KLAVIYO_KEY    = env.KLAVIYO_API_KEY|| process.env.KLAVIYO_API_KEY || '';

const app = express();
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const db = new Database('./data/jord.db');
db.pragma('journal_mode = WAL');

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

// Multi-admin: link events to the admin who created them
try { db.exec("ALTER TABLE events ADD COLUMN admin_id TEXT"); } catch {}

// Global leaderboard: opt-in flag per event
try { db.exec("ALTER TABLE events ADD COLUMN global_published INTEGER DEFAULT 0"); } catch {}

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
app.use(express.json());
app.use(express.static('public'));

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

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
    if (req.admin.role === 'super') return next();
    if (!req.admin[perm]) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function uid(prefix = '') {
  return prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
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
  const payload = JSON.stringify({
    event: { ...event, tee_boxes },
    ld:  event.has_longest_drive ? getLDLeaderboard(eventId) : [],
    cp:  event.has_closest_pin   ? getCPLeaderboard(eventId) : [],
    alerts: db.prepare(`SELECT * FROM rep_alerts WHERE event_id=? AND resolved=0 ORDER BY created_at DESC`).all(eventId)
  });
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

// ─── KLAVIYO ─────────────────────────────────────────────────────────────────
async function sendKlaviyo(type, recipients, data) {
  if (!KLAVIYO_KEY) { console.log(`[Klaviyo MOCK] ${type}:`, data.message || data.subject); return; }
  try {
    const fetch = require('node-fetch');
    await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: { 'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`, 'Content-Type': 'application/json', 'revision': '2024-02-15' },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            properties: { ...data, app: 'JORD Golf Tournament' },
            metric: { data: { type: 'metric', attributes: { name: `jord_${type}` } } },
            profile: { data: { type: 'profile', attributes: { email: recipients[0]?.email, phone_number: recipients[0]?.phone } } }
          }
        }
      })
    });
    db.prepare('INSERT INTO sms_log (id,event_id,recipient,message,type) VALUES (?,?,?,?,?)')
      .run(uid(), data.event_id, recipients.map(r=>r.email||r.phone).join(','), data.message||data.subject, type);
  } catch (e) { console.error('Klaviyo error:', e.message); }
}

async function checkLeadershipChange(eventId, newLB) {
  if (!newLB.length) return;
  const leader = newLB[0];
  const prev   = db.prepare('SELECT notified_lead FROM teams WHERE id=?').get(leader.id);
  if (!prev) return;

  // Find team that was previously first and is no longer
  const allTeams = db.prepare('SELECT * FROM teams WHERE event_id=?').all(eventId);
  for (const team of allTeams) {
    if (team.id !== leader.id && team.notified_lead) {
      // This team just lost the lead
      const balls = db.prepare('SELECT * FROM balls WHERE team_id=? AND event_id=?').all(team.id, eventId);
      const recipients = balls.filter(b => b.email || b.phone).map(b => ({ email: b.email, phone: b.phone }));
      const funny = [
        `⛳ Rough news — Team "${leader.team_name}" just drove past you with ${leader.total_yards} yards. Maybe the wind helped them...`,
        `😬 Heads up — "${leader.team_name}" just took the top spot at ${leader.total_yards} yards. Your reign was beautiful while it lasted.`,
        `🏌️ Breaking news: "${leader.team_name}" would like you to know they hit it farther. ${leader.total_yards} yards to be exact. Yikes.`,
      ];
      const msg = funny[Math.floor(Math.random() * funny.length)];
      await sendKlaviyo('dethroned', recipients, { message: msg, event_id: eventId, new_leader: leader.team_name });
      db.prepare('UPDATE teams SET notified_lead=0 WHERE id=?').run(team.id);
    }
  }
  db.prepare('UPDATE teams SET notified_lead=1 WHERE id=?').run(leader.id);
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
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
    perm_corrections:    admin.perm_corrections,
    perm_end_tournament: admin.perm_end_tournament,
    perm_manage_players: admin.perm_manage_players,
    perm_manage_balls:   admin.perm_manage_balls,
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const { id, name, email, role, perm_corrections, perm_end_tournament, perm_manage_players, perm_manage_balls } = req.admin;
  res.json({ id, name, email, role, perm_corrections, perm_end_tournament, perm_manage_players, perm_manage_balls });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const admin = db.prepare('SELECT * FROM admins WHERE email=? AND active=1').get(email.toLowerCase().trim());
  if (!admin) return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_reset_tokens (token,admin_id,expires_at) VALUES (?,?,?)').run(token, admin.id, expires);
  const resetUrl = `${APP_URL}/admin?reset_token=${token}`;
  // When Klaviyo is wired up, send email here. For now, super admin sees this in /api/admins/reset-requests
  res.json({ success: true, message: 'Reset link generated. Contact your JORD administrator to receive it.', _reset_url: resetUrl });
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

app.post('/api/auth/reset-password', (req, res) => {
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

app.get('/api/admins', requireAuth, requireSuper, (req, res) => {
  const admins = db.prepare('SELECT id,name,email,role,active,perm_corrections,perm_end_tournament,perm_manage_players,perm_manage_balls,created_at FROM admins ORDER BY created_at ASC').all();
  // Attach pending reset tokens for display
  const resets = db.prepare("SELECT * FROM password_reset_tokens WHERE used=0 AND expires_at > datetime('now') ORDER BY created_at DESC").all();
  const resetMap = {};
  for (const r of resets) resetMap[r.admin_id] = r;
  res.json(admins.map(a => ({ ...a, pending_reset: resetMap[a.id] || null })));
});

app.post('/api/admins', requireAuth, requireSuper, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM admins WHERE email=?').get(email.toLowerCase().trim());
  if (existing) return res.status(400).json({ error: 'An admin with that email already exists' });
  const id = uid('ADM');
  db.prepare('INSERT INTO admins (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), email.toLowerCase().trim(), hashPassword(password), role === 'super' ? 'super' : 'admin');
  const created = db.prepare('SELECT id,name,email,role,active,perm_corrections,perm_end_tournament,perm_manage_players,perm_manage_balls,created_at FROM admins WHERE id=?').get(id);
  res.json(created);
});

app.patch('/api/admins/:id', requireAuth, requireSuper, (req, res) => {
  const allowed = ['name','email','role','active','perm_corrections','perm_end_tournament','perm_manage_players','perm_manage_balls'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE admins SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v]) => v), req.params.id);
  res.json(db.prepare('SELECT id,name,email,role,active,perm_corrections,perm_end_tournament,perm_manage_players,perm_manage_balls FROM admins WHERE id=?').get(req.params.id));
});

app.delete('/api/admins/:id', requireAuth, requireSuper, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  if (admin.role === 'super' && db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role='super' AND active=1").get().n <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last super admin' });
  }
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(req.params.id);
  db.prepare('DELETE FROM admins WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admins/:id/reset-password', requireAuth, requireSuper, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE admin_id=? AND used=0').run(req.params.id); // invalidate old tokens
  db.prepare('INSERT INTO password_reset_tokens (token,admin_id,expires_at) VALUES (?,?,?)').run(token, req.params.id, expires);
  const resetUrl = `${APP_URL}/admin?reset_token=${token}`;
  res.json({ success: true, reset_url: resetUrl });
});

app.patch('/api/admins/:id/password', requireAuth, requireSuper, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(password), req.params.id);
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── API: EVENTS ─────────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  const isSuper = req.admin.role === 'super';
  const events = isSuper
    ? db.prepare(`
        SELECT e.*,
          COUNT(DISTINCT t.id)        AS team_count,
          COUNT(DISTINCT b.drop_code) AS ball_count
        FROM events e
        LEFT JOIN teams t ON t.event_id=e.id
        LEFT JOIN balls b ON b.event_id=e.id
        GROUP BY e.id ORDER BY e.starts_at DESC
      `).all()
    : db.prepare(`
        SELECT e.*,
          COUNT(DISTINCT t.id)        AS team_count,
          COUNT(DISTINCT b.drop_code) AS ball_count
        FROM events e
        LEFT JOIN teams t ON t.event_id=e.id
        LEFT JOIN balls b ON b.event_id=e.id
        WHERE e.admin_id=?
        GROUP BY e.id ORDER BY e.starts_at DESC
      `).all(req.admin.id);
  res.json(events);
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
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
          ctp_pin_lat, ctp_pin_lon, cp_off_green_penalty_ft } = ev;
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
             admin_phone: admin_phone || null, tee_boxes });
});

app.post('/api/events', requireAuth, (req, res) => {
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

app.patch('/api/events/:id', requireAuth, (req, res) => {
  const allowed = ['name','venue','starts_at','ends_at','status','has_longest_drive','has_closest_pin',
    'combined_scoring','allow_rough','rough_penalty_mode','rough_fixed_yards','allow_oob',
    'oob_penalty_mode','oob_fixed_yards','hole_distance_yards',
    'fairway_polygon','rough_polygon','oob_polygon','green_polygon',
    'pin_lat','pin_lon',
    'ctp_green_polygon','ctp_pin_lat','ctp_pin_lon','ctp_hole_distance_yards',
    'cp_off_green_penalty_ft','admin_phone','venue_lat','venue_lon'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE events SET ${updates.map(([k])=>`${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v])=>v), req.params.id);
  broadcast(req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});

// Delete event (cascade)
app.delete('/api/events/:id', requireAuth, (req, res) => {
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
app.post('/api/events/:id/reopen', requireAuth, (req, res) => {
  db.prepare("UPDATE events SET status='active' WHERE id=?").run(req.params.id);
  broadcast(req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});

// End tournament
app.post('/api/events/:id/end', requireAuth, async (req, res) => {
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
    const dashUrl = `${APP_URL}/dashboard/${req.params.id}/${encodeURIComponent(ball.drop_code)}`;
    await sendKlaviyo('tournament_ended', [{ email: ball.email, phone: ball.phone }], {
      event_id:      req.params.id,
      event_name:    event.name,
      player_name:   `${ball.first_name} ${ball.last_name}`,
      winner_team:   winner?.team_name || '—',
      dashboard_url: dashUrl,
      message:       `🏆 ${event.name} has ended! Winner: ${winner?.team_name||'TBD'}. See your results: ${dashUrl}`,
      subject:       `Your JORD Golf results from ${event.name}`
    });
  }

  broadcast(req.params.id);
  res.json({ success: true, message: 'Tournament ended. Balls converted. Notifications sent.' });
});

// ─── TEE BOXES ───────────────────────────────────────────────────────────────
app.post('/api/events/:eventId/tee-boxes', requireAuth, (req, res) => {
  const { name, color, lat, lon, hole_type } = req.body;
  if (!name || !lat || !lon) return res.status(400).json({ error: 'name, lat, lon required' });
  const id = uid('TEE');
  db.prepare('INSERT INTO tee_boxes (id,event_id,name,color,lat,lon,hole_type) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.eventId, name, color||'white', lat, lon, hole_type||'longest_drive');
  res.json(db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(id));
});

app.patch('/api/tee-boxes/:id', requireAuth, (req, res) => {
  const allowed = ['lat', 'lon', 'name', 'color', 'hole_type'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE tee_boxes SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...updates.map(([,v]) => v), req.params.id);
  res.json(db.prepare('SELECT * FROM tee_boxes WHERE id=?').get(req.params.id));
});

app.delete('/api/tee-boxes/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tee_boxes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── BALL POOL ────────────────────────────────────────────────────────────────
app.post('/api/events/:eventId/balls', requireAuth, (req, res) => {
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
app.delete('/api/events/:eventId/balls/:code', requireAuth, (req, res) => {
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
app.patch('/api/events/:eventId/balls/:code/unassign', requireAuth, (req, res) => {
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
app.delete('/api/events/:eventId/teams/:teamId', requireAuth, (req, res) => {
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
app.patch('/api/events/:eventId/balls/:code/player', requireAuth, (req, res) => {
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

app.get('/api/events/:eventId/balls', requireAuth, (req, res) => {
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
  const ev = db.prepare('SELECT id,name,venue,starts_at,ends_at,status,has_longest_drive,has_closest_pin FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const tee_boxes = db.prepare('SELECT id,name,color,hole_type FROM tee_boxes WHERE event_id=?').all(req.params.eventId);
  res.json({ ...ev, tee_boxes });
});

// ─── REGISTRATION ─────────────────────────────────────────────────────────────
// Register one player at a time. Team name submitted after 4th player.
// No auth required — drop_code validation is the access control.
app.post('/api/events/:eventId/register-player', (req, res) => {
  const { drop_code, first_name, last_name, email, phone, tee_box_id, player_index, team_id } = req.body;
  const { eventId } = req.params;

  if (!drop_code || !first_name || !last_name) return res.status(400).json({ error: 'drop_code, first_name, last_name required' });

  const event = db.prepare('SELECT status FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'active') return res.status(403).json({ error: event.status === 'setup' ? 'Tournament has not started yet' : 'Tournament has ended' });

  const code = drop_code.trim().toUpperCase();
  const ball = db.prepare('SELECT * FROM balls WHERE drop_code=? AND event_id=?').get(code, eventId);
  if (!ball) return res.status(404).json({ error: `Code ${code} not found in this tournament's ball pool` });
  if (ball.team_id) return res.status(400).json({ error: `Code ${code} is already registered to a player` });

  db.prepare(`UPDATE balls SET first_name=?,last_name=?,email=?,phone=?,tee_box_id=?,player_index=?,team_id=? WHERE drop_code=? AND event_id=?`)
    .run(first_name.trim(), last_name.trim(), email||null, phone||null, tee_box_id||null, player_index||1, team_id||null, code, eventId);

  res.json({ success: true, drop_code: code, player: `${first_name} ${last_name}` });
});

// Finalize team (set team name after all players registered)
// No auth required — drop_codes must already exist in pool for this event.
app.post('/api/events/:eventId/finalize-team', (req, res) => {
  const { team_name, drop_codes } = req.body;
  const { eventId } = req.params;

  if (!team_name || !drop_codes?.length) return res.status(400).json({ error: 'team_name and drop_codes required' });

  const event = db.prepare('SELECT status FROM events WHERE id=?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'active') return res.status(403).json({ error: event.status === 'setup' ? 'Tournament has not started yet' : 'Tournament has ended' });

  const teamId = uid('TEAM');
  db.prepare('INSERT INTO teams (id,event_id,team_name) VALUES (?,?,?)').run(teamId, eventId, team_name.trim());
  db.prepare(`UPDATE balls SET team_id=? WHERE drop_code IN (${drop_codes.map(()=>'?').join(',')}) AND event_id=?`)
    .run(teamId, ...drop_codes.map(c => c.toUpperCase()), eventId);

  broadcast(eventId);
  res.json({ team_id: teamId, team_name: team_name.trim(), drop_codes });
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
app.post('/api/scan/ld/:code', (req, res) => {
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
app.post('/api/scan/cp/:code', (req, res) => {
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
});

// ─── ADMIN CORRECTIONS ────────────────────────────────────────────────────────
app.post('/api/admin/correct', requireAuth, (req, res) => {
  const { drop_code, event_id, lat, lon, final_yards, penalty_yards, location_type, reason, game } = req.body;
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

  db.prepare('INSERT INTO admin_corrections (id,drop_code,event_id,old_value,new_value,reason) VALUES (?,?,?,?,?,?)')
    .run(uid(), code, event_id, JSON.stringify(oldBall), JSON.stringify(req.body), reason||'');

  broadcast(event_id);
  res.json({ success: true });
});

// Null a ball (rep marks invalid)
app.post('/api/admin/null-ball', requireAuth, (req, res) => {
  const { drop_code, event_id, game, reason } = req.body;
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
app.patch('/api/events/:eventId/balls/:code/reset-scan', requireAuth, (req, res) => {
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
app.post('/api/alerts', (req, res) => {
  const { event_id, drop_code, team_name, player_name, lat, lon, message } = req.body;
  const id = uid('ALERT');
  db.prepare('INSERT INTO rep_alerts (id,event_id,drop_code,team_name,player_name,lat,lon,message) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, event_id, drop_code||null, team_name||null, player_name||null, lat||null, lon||null, message||'Player needs help');
  broadcast(event_id);
  res.json({ success: true, alert_id: id });
});

app.patch('/api/alerts/:id/resolve', requireAuth, (req, res) => {
  db.prepare('UPDATE rep_alerts SET resolved=1 WHERE id=?').run(req.params.id);
  const alert = db.prepare('SELECT * FROM rep_alerts WHERE id=?').get(req.params.id);
  if (alert) broadcast(alert.event_id);
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
  const payload = { event: { ...event, tee_boxes },
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
app.get('/api/config', (req, res) => {
  res.json({ mapbox_token: MAPBOX_TOKEN, version: '1.0.0', build_date: '2026-04-26' });
});

// ─── COURSE SEARCH (from courses.csv) ────────────────────────────────────────
let _coursesCache = null;
function loadCourses() {
  if (_coursesCache) return _coursesCache;
  try {
    const text = fs.readFileSync('./data/courses.csv', 'utf8');
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

// ─── PAGES ───────────────────────────────────────────────────────────────────
const pages = { '/admin': 'admin.html', '/register/:id': 'register.html',
  '/scan': 'scan.html', '/scan/:code': 'scan.html', '/leaderboard/:id': 'leaderboard.html',
  '/dashboard/:eid/:code': 'dashboard.html', '/monitor/:id': 'monitor.html',
  '/global': 'global.html', '/test': 'test.html' };
Object.entries(pages).forEach(([route, file]) => {
  app.get(route, (_, res) => res.sendFile(path.join(__dirname, 'public', file)));
});
app.get('/', (_, res) => res.redirect('/admin'));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   JORD Golf Tournament System  v1.0.0               ║
║   http://localhost:${PORT}                              ║
║                                                      ║
║   Admin:       /admin                               ║
║   Monitor:     /monitor/:eventId                    ║
║   Leaderboard: /leaderboard/:eventId                ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app; // for testing
