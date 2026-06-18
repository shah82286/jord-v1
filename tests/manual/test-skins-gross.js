// v3.68 — verify the allow_handicaps toggle on Skins.
// Setup: 2 players, identical raw scores, different course handicaps.
//   - With handicaps ON (default): the player with the higher hcp gets a stroke
//     on the stroke-index-1 hole and wins that skin on net.
//   - With handicaps OFF (gross): the two players tie on every hole, so every
//     skin carries — nobody wins any.
const { buildLeaderboard } = require('../../lib/scoring');

const holes = [
  { hole_number: 1, par: 4, handicap_index: 1 },
  { hole_number: 2, par: 4, handicap_index: 2 },
  { hole_number: 3, par: 3, handicap_index: 3 },
];
const entries = [
  { entryId: 'A', playerName: 'A-low',  courseHandicap: 0,  holes,
    scores: { 1: 4, 2: 4, 3: 3 } },
  { entryId: 'B', playerName: 'B-high', courseHandicap: 18, holes,
    scores: { 1: 4, 2: 4, 3: 3 } },
];

function run(label, settings) {
  const lb = buildLeaderboard(entries, { format: 'skins', format_settings: settings });
  const skinsByName = {};
  for (const r of lb.rows) skinsByName[r.playerName] = r.total;
  const wonByName = {};
  for (const r of lb.rows) wonByName[r.playerName] = r.skinHoles.map(h => `${h.hole}(${h.value})`).join(',') || '-';
  const tied = (lb.rows[0] && lb.rows[0].skinTiedHoles) || [];
  console.log(`[${label}] totals=${JSON.stringify(skinsByName)} won=${JSON.stringify(wonByName)} tied=[${tied.join(',')}]`);
  return { skinsByName, wonByName, tied };
}

const a = run('default (net)', undefined);
if (a.skinsByName['B-high'] !== 3) throw new Error('NET: B-high (hcp 18 / 3 holes = 6 strokes per hole) should sweep all 3 skins');
if (a.skinsByName['A-low']  !== 0) throw new Error('NET: A-low should win nothing');
if (a.tied.length !== 0)            throw new Error('NET: nothing should be tied (B gets strokes on every hole)');

const b = run('toggle ON  (net)', { allow_handicaps: true });
if (b.skinsByName['B-high'] !== 3) throw new Error('toggle ON: should match default-net behavior');

const c = run('toggle OFF (gross)', { allow_handicaps: false });
if (c.skinsByName['A-low']  !== 0) throw new Error('GROSS: nobody should win — all holes tied');
if (c.skinsByName['B-high'] !== 0) throw new Error('GROSS: nobody should win — all holes tied');
if (c.tied.length !== 3)            throw new Error(`GROSS: all 3 holes should carry, saw ${c.tied.length}`);

// ── Carryover toggle test ─────────────────────────────────────────────
// 3 holes, 2 players. Hole 1 = tie. Hole 2 = A wins outright.
// With carryover ON: A's hole-2 win is worth 2 (1 carry + 1 fresh).
// With carryover OFF: A's hole-2 win is worth 1 (the tied skin died).
const carryHoles = [
  { hole_number: 1, par: 4, handicap_index: 1 },
  { hole_number: 2, par: 4, handicap_index: 2 },
  { hole_number: 3, par: 4, handicap_index: 3 },
];
const carryEntries = [
  { entryId: 'A', playerName: 'A', courseHandicap: 0, holes: carryHoles,
    scores: { 1: 4, 2: 3, 3: 4 } },
  { entryId: 'B', playerName: 'B', courseHandicap: 0, holes: carryHoles,
    scores: { 1: 4, 2: 5, 3: 4 } },
];
function runCarry(label, settings) {
  const lb = require('../../lib/scoring').buildLeaderboard(carryEntries, { format: 'skins', format_settings: settings });
  const aRow = lb.rows.find(r => r.playerName === 'A');
  const bRow = lb.rows.find(r => r.playerName === 'B');
  const wonA = aRow.skinHoles.map(h => `${h.hole}(${h.value})`).join(',') || '-';
  const wonB = bRow.skinHoles.map(h => `${h.hole}(${h.value})`).join(',') || '-';
  console.log(`[${label}] A=${aRow.total} won=${wonA} | B=${bRow.total} won=${wonB} | tied=[${aRow.skinTiedHoles.join(',')}]`);
  return { aTotal: aRow.total, aWon: aRow.skinHoles };
}
const d = runCarry('carry ON  (default)', undefined);
if (d.aTotal !== 2) throw new Error(`carry ON: A should have 2 skins (1 carried + 1 fresh), got ${d.aTotal}`);
if (d.aWon[0].value !== 2) throw new Error('carry ON: A\'s hole-2 win should be worth 2');

const e = runCarry('carry OFF',           { allow_carryover: false });
if (e.aTotal !== 1) throw new Error(`carry OFF: A should have 1 skin (tied skin dies), got ${e.aTotal}`);
if (e.aWon[0].value !== 1) throw new Error('carry OFF: A\'s hole-2 win should be worth 1 (carryover disabled)');

console.log('\nALL PASS — Skins allow_handicaps + allow_carryover toggles both work');
process.exit(0);
