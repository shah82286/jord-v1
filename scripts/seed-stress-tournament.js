/**
 * Seed "The Dancing Hockey Guys Classic" stress-test tournament.
 *
 * Creates:
 *   - 1 event at Pevely Farms (Crescent/Eureka MO area), status=setup
 *   - 144 ball codes DHG001..DHG144
 *   - 36 teams of 4 players each, realistic mixed names, fake contacts
 *
 * Status is left as 'setup' so admin can map zones + place tee/pin
 * before clicking "Start tournament" in the UI.
 *
 * Run: node scripts/seed-stress-tournament.js
 *      node scripts/seed-stress-tournament.js --reset    (delete & recreate)
 */

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

// Resolve DB path the same way server.js does
const env = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim();
  });
} catch {}
const DB_PATH = env.DB_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jord.db');
const db = new Database(DB_PATH);

const RESET = process.argv.includes('--reset');
const TOURNAMENT_NAME = 'The Dancing Hockey Guys Classic';
const VENUE = 'Pevely Farms Golf Club';
const VENUE_LAT = 38.520164;
const VENUE_LON = -90.600368;
const TOTAL_PLAYERS = 144;
const TEAM_SIZE = 4;
const TOTAL_TEAMS = TOTAL_PLAYERS / TEAM_SIZE; // 36

const uid = (prefix) => prefix + crypto.randomBytes(4).toString('hex').toUpperCase();

// ── Realistic mixed-name pool ──────────────────────────────────────────────
const FIRST_NAMES = [
  'James','Michael','Robert','John','David','William','Richard','Thomas','Mark','Steven',
  'Paul','Andrew','Joshua','Kevin','Brian','George','Edward','Ronald','Anthony','Kenneth',
  'Jason','Matthew','Gary','Timothy','Jose','Larry','Jeffrey','Frank','Scott','Eric',
  'Stephen','Justin','Brandon','Benjamin','Samuel','Gregory','Patrick','Alexander','Jack','Dennis',
  'Jerry','Tyler','Aaron','Jose','Henry','Adam','Douglas','Nathan','Peter','Zachary',
  'Walter','Kyle','Harold','Carl','Jeremy','Keith','Roger','Gerald','Ethan','Arthur',
  'Terry','Christian','Sean','Lawrence','Austin','Joe','Noah','Jesse','Albert','Bryan',
  'Billy','Bruce','Willie','Jordan','Dylan','Alan','Ralph','Gabriel','Roy','Juan'
];
const LAST_NAMES = [
  'Anderson','Bailey','Bell','Bennett','Brooks','Carter','Clark','Collins','Cook','Cooper',
  'Cox','Davis','Edwards','Evans','Fisher','Foster','Garcia','Gonzalez','Gray','Green',
  'Hall','Harris','Hayes','Hernandez','Hill','Howard','Hughes','Jackson','James','Jenkins',
  'Johnson','Jones','Kelly','King','Lewis','Long','Lopez','Martin','Martinez','Miller',
  'Mitchell','Moore','Morgan','Morris','Murphy','Nelson','Parker','Perez','Peterson','Phillips',
  'Powell','Price','Ramirez','Reed','Richardson','Rivera','Roberts','Robinson','Rodriguez','Rogers',
  'Ross','Russell','Sanchez','Scott','Smith','Stewart','Sullivan','Taylor','Thomas','Thompson',
  'Torres','Turner','Walker','Ward','Watson','White','Williams','Wilson','Wood','Wright','Young'
];
const TEAM_NAMES = [
  'The Mulligans','Birdie Boys','Eagles Nest','Sand Trap Kings','Fairway Finders',
  'The Slicers','Bogey Brothers','Par Partners','Green Giants','Hole-in-One Heroes',
  'Tee Time Titans','The Hookers','The Shanksters','Putting Pros','The Caddyshack Crew',
  'Driving Range Demons','Saturday Swingers','The Whiff Wizards','Bunker Busters','Iron Eagles',
  'The Dimpled Dozen','Country Club Cowboys','The Linksters','Rough Riders','Fairway Foxes',
  'The Backspinners','Pin Seekers','Divot Diggers','The Albatross','Course Crushers',
  'Greenside Gunners','The Pivotals','Lost Ball Legends','Wedge Wizards','Three Putt Trio',
  'The Mashie Maulers'
];

// ── Reset existing test event if requested ─────────────────────────────────
const existing = db.prepare(`SELECT id FROM events WHERE name=?`).all(TOURNAMENT_NAME);
if (existing.length && RESET) {
  for (const e of existing) {
    db.prepare('DELETE FROM admin_corrections WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM rep_alerts WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM sms_log WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM balls WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM teams WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM tee_boxes WHERE event_id=?').run(e.id);
    db.prepare('DELETE FROM events WHERE id=?').run(e.id);
    console.log(`✖  Removed existing event ${e.id}`);
  }
} else if (existing.length) {
  console.error(`\n❌  Event "${TOURNAMENT_NAME}" already exists (id=${existing[0].id}).`);
  console.error(`   Re-run with --reset to delete and recreate, or open the admin panel to use it as-is.\n`);
  process.exit(1);
}

// ── Find super admin to attach as creator ──────────────────────────────────
const superAdmin = db.prepare(`SELECT id FROM admins WHERE role='super' ORDER BY created_at LIMIT 1`).get();
if (!superAdmin) {
  console.error('\n❌  No super admin found in DB. Boot the server once to seed one, then re-run.\n');
  process.exit(1);
}

// ── Create the event ───────────────────────────────────────────────────────
const eventId = uid('EVT');
const now = new Date();
const startsAt = now.toISOString().slice(0, 19); // today
const endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19);

db.prepare(`INSERT INTO events
  (id, name, venue, starts_at, ends_at, status,
   has_longest_drive, has_closest_pin, combined_scoring,
   allow_rough, rough_penalty_mode, rough_fixed_yards,
   allow_oob, oob_penalty_mode, oob_fixed_yards,
   hole_distance_yards, venue_lat, venue_lon, admin_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  eventId, TOURNAMENT_NAME, VENUE, startsAt, endsAt, 'setup',
  1, 0, 0,
  1, 'perpendicular', 0,
  1, 'half_hole', 0,
  380, // typical par-4 hole length in yards (admin can edit)
  VENUE_LAT, VENUE_LON, superAdmin.id
);
console.log(`✅  Event created: ${eventId}  ${TOURNAMENT_NAME}`);

// ── Create 144 ball codes ──────────────────────────────────────────────────
const ballInsert = db.prepare(`INSERT INTO balls
  (drop_code, event_id, status, tournament_name, tournament_venue, tournament_date)
  VALUES (?,?,?,?,?,?)`);
const codes = [];
const ballTx = db.transaction(() => {
  for (let i = 1; i <= TOTAL_PLAYERS; i++) {
    const code = `DHG${String(i).padStart(3, '0')}`;
    codes.push(code);
    ballInsert.run(code, eventId, 'tournament', TOURNAMENT_NAME, VENUE, startsAt.split('T')[0]);
  }
});
ballTx();
console.log(`✅  ${codes.length} ball codes added (DHG001 .. DHG${String(TOTAL_PLAYERS).padStart(3, '0')})`);

// ── Create 36 teams + assign 4 players each ────────────────────────────────
const teamInsert = db.prepare(`INSERT INTO teams (id, event_id, team_name, share_code, registered_at)
                               VALUES (?,?,?,?,datetime('now'))`);
const ballAssign = db.prepare(`UPDATE balls
  SET team_id=?, player_index=?, first_name=?, last_name=?, email=?, phone=?
  WHERE drop_code=? AND event_id=?`);

let codeCursor = 0;
const usedNames = new Set();
const pickName = () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const key = `${f} ${l}`;
    if (!usedNames.has(key)) { usedNames.add(key); return { first: f, last: l }; }
  }
  // Fallback if 50 collisions in a row (unlikely)
  return { first: 'Player', last: String(usedNames.size + 1) };
};

const teamTx = db.transaction(() => {
  for (let t = 0; t < TOTAL_TEAMS; t++) {
    const teamId   = uid('TEAM');
    const teamName = TEAM_NAMES[t];
    const shareCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    teamInsert.run(teamId, eventId, teamName, shareCode);

    for (let p = 1; p <= TEAM_SIZE; p++) {
      const code = codes[codeCursor++];
      const { first, last } = pickName();
      // Obviously fake contacts: 555-01XX phones, @example.test emails
      const phone = `555-01${String(t).padStart(2, '0')}-${String(p).padStart(2, '0')}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}.${t}${p}@example.test`;
      ballAssign.run(teamId, p, first, last, email, phone, code, eventId);
    }
  }
});
teamTx();
console.log(`✅  ${TOTAL_TEAMS} teams created, ${TOTAL_PLAYERS} players assigned`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`   Tournament : ${TOURNAMENT_NAME}`);
console.log(`   Venue      : ${VENUE} (lat ${VENUE_LAT}, lon ${VENUE_LON})`);
console.log(`   Event ID   : ${eventId}`);
console.log(`   Status     : setup  (admin can map zones, then click Start)`);
console.log(`   Players    : ${TOTAL_PLAYERS} across ${TOTAL_TEAMS} teams`);
console.log(`   Ball codes : DHG001 .. DHG${String(TOTAL_PLAYERS).padStart(3, '0')}`);
console.log('═'.repeat(60));
console.log(`\n   Open admin: http://localhost:3000/admin#${eventId}/map`);
console.log(`   Then map zones on hole 2 of Pevely Farms, place tee + pin,`);
console.log(`   click "Start tournament", and tell me to "run the tournament".\n`);
