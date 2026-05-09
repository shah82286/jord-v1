/**
 * Seed realistic data into the existing event for screenshot capture.
 * - Fixes tee box positions to be a realistic distance from the pin
 * - Creates a few sample teams with names/players
 * - Inserts scored shots (drives) in fairway, rough, and OOB to populate the leaderboard
 *
 * Run: node scripts/seed-screenshot-data.js
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const db = new Database('./data/jord.db');

const EID = 'EVTBEA9495F';

function uid(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const event = db.prepare('SELECT * FROM events WHERE id = ?').get(EID);
if (!event) throw new Error('Event not found: ' + EID);

console.log(`Seeding "${event.name}" at ${event.venue}`);
console.log(`Pin: ${event.pin_lat}, ${event.pin_lon}`);

// ─── Fix tee boxes to be ~300 yd south of the pin ──────────────────────
// 300 yards ≈ 274 meters ≈ 0.00248 degrees latitude at this lat
const pinLat = event.pin_lat;
const pinLon = event.pin_lon;
const teeLat = pinLat - 0.0030;       // ~330 yards south
const teeLon = pinLon + 0.00010;      // tiny offset

db.prepare('DELETE FROM tee_boxes WHERE event_id = ?').run(EID);
db.prepare(`INSERT INTO tee_boxes (id, event_id, name, color, lat, lon, hole_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
  uid('TEE'), EID, 'Main', 'white', teeLat, teeLon, 'longest_drive');
console.log(`Tee box positioned at ${teeLat}, ${teeLon}`);

// Update event hole_distance_yards to match (~330 yd)
db.prepare('UPDATE events SET hole_distance_yards = 330 WHERE id = ?').run(EID);

// ─── Wipe existing teams + balls so we can seed clean ─────────────────
db.prepare('DELETE FROM balls WHERE event_id = ?').run(EID);
db.prepare('DELETE FROM teams WHERE event_id = ?').run(EID);

// ─── Realistic team & player data ─────────────────────────────────────
const seed = [
  {
    teamName: 'The Eagles',
    players: [
      { first: 'Jake',    last: 'Reynolds',  yards: 312, location_type: 'fairway' },
      { first: 'Mike',    last: 'Shah',      yards: 287, location_type: 'fairway' },
      { first: 'Tom',     last: 'Caldwell',  yards: 264, location_type: 'fairway' },
      { first: 'Brad',    last: 'Henson',    yards: 251, location_type: 'fairway' },
    ],
  },
  {
    teamName: 'Birdie Hunters',
    players: [
      { first: 'Sam',     last: 'Kowalski',  yards: 298, location_type: 'fairway' },
      { first: 'Pete',    last: 'Rivera',    yards: 281, location_type: 'fairway' },
      { first: 'Chris',   last: 'Donnelly',  yards: 245, location_type: 'rough'   },
      { first: 'Rob',     last: 'Mancini',   yards: 230, location_type: 'fairway' },
    ],
  },
  {
    teamName: 'The Mulligans',
    players: [
      { first: 'Greg',    last: 'Walsh',     yards: 271, location_type: 'fairway' },
      { first: 'Dan',     last: 'Ortiz',     yards: 258, location_type: 'rough'   },
      { first: 'Kyle',    last: 'Brennan',   yards: 0,   location_type: 'oob'     },
      { first: 'Andy',    last: 'Park',      yards: 224, location_type: 'fairway' },
    ],
  },
  {
    teamName: 'Sand Traps',
    players: [
      { first: 'Justin',  last: 'McGrath',   yards: 256, location_type: 'fairway' },
      { first: 'Will',    last: 'Becker',    yards: 240, location_type: 'fairway' },
      { first: 'Eric',    last: 'Holloway',  yards: 215, location_type: 'rough'   },
      { first: 'Nate',    last: 'Foster',    yards: 198, location_type: 'fairway' },
    ],
  },
  {
    teamName: 'Fairway Frank',
    players: [
      { first: 'Frank',   last: 'DiMarco',   yards: 268, location_type: 'fairway' },
      { first: 'Rick',    last: 'Sutton',    yards: 232, location_type: 'fairway' },
      { first: 'Joe',     last: 'Bishop',    yards: 0,   location_type: null     }, // not yet scanned
      { first: 'Marcus',  last: 'Webb',      yards: 0,   location_type: null     },
    ],
  },
];

// Pin coordinates (where shot final position lands relative to pin)
function deriveCoords(yards, locationType) {
  if (yards === 0) return { lat: null, lon: null };
  // Convert yards traveled FROM tee → final position
  const yardsRemaining = 330 - yards;
  // Position: tee + yards toward pin (north)
  const yardsToDeg = yards / 110640; // ~110640 yards per degree latitude
  const lat = teeLat + yardsToDeg;
  // Add small lateral offset based on location type
  const lonOffset = locationType === 'rough' ? 0.00015 :
                    locationType === 'oob'   ? 0.00040 :
                    (Math.random() - 0.5) * 0.00012; // fairway: tight spread
  const lon = teeLon + lonOffset;
  return { lat, lon, yardsRemaining };
}

const teamStmt = db.prepare(`INSERT INTO teams (id, event_id, team_name, registered_at)
                             VALUES (?, ?, ?, datetime('now', '-1 hour'))`);
const ballStmt = db.prepare(`INSERT INTO balls (
  drop_code, event_id, team_id, player_index, first_name, last_name, phone,
  ld_lat, ld_lon, ld_raw_yards, ld_final_yards, ld_location_type, ld_scanned_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-' || ? || ' minutes'))`);

let totalScored = 0;
let codeCounter = 100000;

seed.forEach((team, ti) => {
  const teamId = uid('TM');
  teamStmt.run(teamId, EID, team.teamName);

  team.players.forEach((p, pi) => {
    const code = String(codeCounter++).padStart(6, '0');
    const phone = '555-' + String(1000 + ti * 10 + pi).padStart(4, '0');
    let lat = null, lon = null, raw = null, final = null, locType = p.location_type;

    if (p.yards > 0) {
      const c = deriveCoords(p.yards, p.location_type);
      lat = c.lat;
      lon = c.lon;
      raw = p.yards;
      final = p.yards;
      // Apply rough penalty: score 0 if rough not allowed; here allow_rough=1, so keep yards
      // Apply OOB: if location is oob and allow_oob=0, final=0
      if (p.location_type === 'oob') final = 0;
      totalScored++;
    } else {
      locType = null; // unscored
    }

    const minutesAgo = 60 - (ti * 8 + pi * 2);
    ballStmt.run(code, EID, teamId, pi + 1,
                 p.first, p.last, phone,
                 lat, lon, raw, final, locType, minutesAgo);
  });
});

console.log(`Seeded ${seed.length} teams, ${totalScored} scored drives.`);
console.log(`\nCheck the leaderboard at: http://localhost:3000/leaderboard/${EID}`);
