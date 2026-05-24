/**
 * Seed a demo event with a fully-populated public site at /e/<slug>.
 * Idempotent — re-running is a no-op if the slug already exists.
 *
 * Run: node scripts/seed-event-site.js
 */
'use strict';
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const db = new Database('./data/jord.db');
const uid = p => p + crypto.randomBytes(4).toString('hex').toUpperCase();

const SLUG = 'fairway-fund-classic-2026';
const existing = db.prepare('SELECT event_id FROM event_sites WHERE slug=?').get(SLUG);
if (existing) {
  console.log('Demo event-site already exists:', SLUG, '→ http://localhost:3000/e/' + SLUG);
  process.exit(0);
}

const eventId = uid('EVT');
db.prepare(`INSERT INTO events (id, name, venue, starts_at, ends_at, is_charity)
            VALUES (?, ?, ?, ?, ?, 1)`)
  .run(eventId, 'Fairway Fund Charity Classic', 'Pebble Beach Golf Links',
       '2026-09-12 08:00:00', '2026-09-12 19:00:00');

const schedule = [
  { time: '7:30 AM', title: 'Registration & Bag Drop',  note: 'Coffee + breakfast bar at the clubhouse.' },
  { time: '9:00 AM', title: 'Shotgun Start',            note: 'All players tee off simultaneously.' },
  { time: '1:00 PM', title: 'Lunch on the Green',       note: 'Live music + lunch buffet.' },
  { time: '5:00 PM', title: 'Awards Dinner',            note: 'Champion crowning, raffle, silent auction.' },
];

const faq = [
  { q: 'Who benefits from this tournament?', a: '100% of net proceeds support the Fairway Fund — a youth golf program for under-served communities.' },
  { q: 'What format is the tournament?',     a: 'Four-person scramble with optional Team Longest Drive and Closest to Pin contests.' },
  { q: 'Are mulligans available?',           a: 'Yes — mulligan packs and on-course games will be available at registration check-in.' },
  { q: 'Is lunch included?',                 a: 'Yes, lunch and the awards dinner are included with every registration.' },
  { q: "What's the dress code?",             a: 'Standard golf attire — collared shirt and golf shoes preferred.' },
];

db.prepare(`INSERT INTO event_sites
  (event_id, slug, headline, subhead, hero_image, starts_at, location_name,
   about_html, schedule_json, course_info, faq_json,
   contact_name, contact_email, contact_phone, published)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
  eventId, SLUG,
  'Fairway Fund Charity Classic',
  'A day on the links to raise critical funding for youth golf programs across the region.',
  '/img/lifestyle/editorial-two-walking-1600.jpg',
  '2026-09-12 09:00:00',
  'Pebble Beach Golf Links · Pebble Beach, CA',
  `Every year we bring 144 golfers together for a day on one of the most iconic courses in the world — all in support of the Fairway Fund. Net proceeds fund equipment, instruction, and tournament travel for the next generation of young golfers in our community.

Four-person scramble. On-course contests. Silent auction. Awards dinner with live music.`,
  JSON.stringify(schedule),
  'Pebble Beach Golf Links plays along the rugged Pacific coast — narrow fairways, dramatic ocean greens, and the legendary 7th. Black, Blue, White and Red tees.',
  JSON.stringify(faq),
  'Maddie Chen', 'maddie@fairwayfund.example', '(555) 123-0420',
);

const packages = [
  ['Individual Player', 'A single player slot — includes lunch, awards dinner, and goodie bag.',           22500, 1,   null, 1],
  ['Foursome',          'A team of four — best value for a corporate group. Includes a team tee sign.',    80000, 4,   36,   2],
  ['Birdie Patron',     'Foursome + a hole sponsorship + recognition on event signage.',                  150000, 4,   8,    3],
  ['Eagle Sponsor',     'Foursome + premium hole + drink-cart sponsorship + logo on awards.',             300000, 4,   4,    4],
];
const insertPkg = db.prepare(`INSERT INTO registration_packages
  (id, event_id, name, description, price_cents, includes_players, quantity_limit, sort_order, active)
  VALUES (?,?,?,?,?,?,?,?,1)`);
for (const [name, desc, price, players, qty, sort] of packages) {
  insertPkg.run(uid('PKG'), eventId, name, desc, price, players, qty, sort);
}

console.log('✅ Seeded demo event:', eventId);
console.log('   Public site → http://localhost:3000/e/' + SLUG);
