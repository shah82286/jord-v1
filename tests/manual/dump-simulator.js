// Format verification harness. Runs every format in lib/formats.js through
// the real scoring.buildLeaderboard() with a deterministic 4-or-6-player
// sample roster, then prints a per-format report you can scroll through to
// confirm each game is scored sensibly.
//
// No server, no DB, no fake users — this is a pure-function test against
// the scoring engine. Run it with `node tests/manual/dump-simulator.js`.
const sim = require('../sim/simulator');

const results = sim.simulateAll(42);

for (const f of results) {
  const lb = f.leaderboard;
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${f.emoji}  ${f.name} · ${f.sub}`);
  console.log(`    tier=${f.tier}  engine=${f.engine}  ${f.scored ? 'AUTO-SCORED' : 'MANUAL'}`);
  console.log(`    scoring: ${f.scoringExplained}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (Object.keys(f.settingsApplied || {}).length) {
    console.log('  settings:', JSON.stringify(f.settingsApplied));
  }

  for (const p of f.scorecard) {
    const dot = p.totalNet - p.totalPar;
    const tag = dot === 0 ? 'E' : (dot > 0 ? '+' : '') + dot;
    const team = p.teamName ? `[${p.teamName}]`.padEnd(18) : ''.padEnd(18);
    console.log(`  ${p.playerName.padEnd(18)} ${team} gross ${String(p.totalGross).padStart(3)} / net ${String(p.totalNet).padStart(3)} (${tag})`);
  }
  if (lb && lb.rows && lb.rows.length) {
    console.log('  leaderboard (scoreType=' + lb.scoreType + '):');
    for (const r of lb.rows) {
      const score = r.total != null
        ? (lb.scoreType === 'topar' ? `${r.score} (${r.total > 0 ? '+' : ''}${r.total === 0 ? 'E' : r.total})` : String(r.total))
        : '—';
      console.log(`    ${String(r.position ?? '?').padStart(2)}. ${(r.playerName || '').padEnd(18)} ${score}`);
    }
  } else if (f.manualScoring) {
    console.log('  manual scoring — leaderboard tally is hand-entered (auto-tally engine coming in v3.60)');
  }
}

console.log(`\n${results.length} formats scored — all engines executed without error.`);
