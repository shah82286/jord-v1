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

console.log('\nALL PASS — Skins allow_handicaps toggle switches between net and gross correctly');
process.exit(0);
