// Comprehensive Vegas verification — every aspect of the format end-to-end.
//
//  1. Personal user signup
//  2. Create Vegas tournament with custom settings (value_per_point=0.5, flip_birdie=true)
//  3. Confirm format_settings round-trip on GET
//  4. Add 2 pairs of 2 players each via /teams endpoint (the wizard flow)
//  5. Activate the round
//  6. Post realistic per-hole scores for all 4 players
//  7. Pull SSE payload → confirm:
//       a. Vegas leaderboard exists with scoreType='vegas'
//       b. Exactly 2 rows (one per pair)
//       c. Combined-pair margin math is correct (hand-verified case)
//       d. format_settings.value_per_point flows through
//  8. Verify birdie-flip toggle changes the result (rebuild the same scores
//     with flip_birdie=false and confirm the margin differs)
//  9. Multi-pair stretch: build a 4-pair (8-player) Vegas tournament and
//     confirm the round-robin engine produces a 4-row leaderboard

const BASE = 'http://localhost:3000';

const ssePayload = (roundId) => new Promise((resolve, reject) => {
  const http = require('http');
  const req = http.request({
    hostname:'localhost', port:3000, path:`/api/rounds/${roundId}/stream`,
    headers:{ Accept:'text/event-stream' },
  }, (res) => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      const m = buf.match(/^data: (\{.*\})\n\n/);
      if (m) { try { resolve(JSON.parse(m[1])); } catch (e) { reject(e); } req.destroy(); }
    });
    res.on('error', reject);
  });
  req.on('error', reject); req.end();
  setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 5000);
});

async function signup() {
  const email = `vfull-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const r = await (await fetch(`${BASE}/api/users/signup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'Vegas Full', email, password }),
  })).json();
  return { token: r.token, email };
}

async function createVegas(token, courseId, settings) {
  const H = { 'Content-Type':'application/json', 'x-user-token': token };
  const r = await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({
      name:'Vegas Full Test', type:'casual', course_id: courseId,
      format:'vegas', format_settings: settings,
    }),
  });
  if (!r.ok) throw new Error('POST tournament failed: ' + r.status + ' ' + await r.text());
  return await r.json();
}

async function addTeam(token, roundId, name, players) {
  const H = { 'Content-Type':'application/json', 'x-user-token': token };
  const r = await fetch(`${BASE}/api/rounds/${roundId}/teams`, {
    method:'POST', headers:H, body: JSON.stringify({ name, players }),
  });
  if (!r.ok) throw new Error(`POST team ${name} failed: ${r.status} ${await r.text()}`);
}

async function activate(token, roundId) {
  const H = { 'Content-Type':'application/json', 'x-user-token': token };
  const r = await fetch(`${BASE}/api/rounds/${roundId}/status`, {
    method:'POST', headers:H, body: JSON.stringify({ status:'active' }),
  });
  if (!r.ok) throw new Error('activate failed: ' + r.status);
}

async function postScores(token, roundId, scores) {
  const H = { 'Content-Type':'application/json', 'x-user-token': token };
  const r = await fetch(`${BASE}/api/rounds/${roundId}/scores`, {
    method:'POST', headers:H, body: JSON.stringify({ scores, entered_by:'test' }),
  });
  if (!r.ok) throw new Error('postScores failed: ' + r.status + ' ' + await r.text());
}

(async () => {
  const { token } = await signup();
  const courses = await (await fetch(`${BASE}/api/courses`, { headers:{'x-user-token': token} })).json();
  if (!courses.length) throw new Error('no courses in DB');
  const courseId = courses[0].id;
  console.log('[1] signed up; course=', courseId);

  // ── 2-PAIR VEGAS ─────────────────────────────────────────────
  // flip_birdie ON, $/point = $0.50
  const trn = await createVegas(token, courseId, { value_per_point: 0.5, flip_birdie: true });
  console.log('[2] 2-pair Vegas tournament', trn.id);

  // Round-trip the settings
  const trnFull = await (await fetch(`${BASE}/api/tournaments/${trn.id}`, {
    headers: {'x-user-token': token}
  })).json();
  if (trnFull.format_settings?.value_per_point !== 0.5) {
    throw new Error('value_per_point did not round-trip: ' + JSON.stringify(trnFull.format_settings));
  }
  if (trnFull.format_settings?.flip_birdie !== true) {
    throw new Error('flip_birdie did not round-trip: ' + JSON.stringify(trnFull.format_settings));
  }
  console.log('[3] settings round-trip OK:', trnFull.format_settings);

  // Add 2 pairs of 2
  await addTeam(token, trn.round_id, 'Team Birdie', [
    { name:'Alex',   handicap_index: 0 },
    { name:'Brooke', handicap_index: 0 },
  ]);
  await addTeam(token, trn.round_id, 'Team Eagle', [
    { name:'Cam',    handicap_index: 0 },
    { name:'Drew',   handicap_index: 0 },
  ]);
  await activate(token, trn.round_id);
  console.log('[4] 2 pairs created + round active');

  // Pull entry IDs for scoring
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, {
    headers:{'x-user-token': token}
  })).json();
  // Sort by team_name for predictability
  rd.entries.sort((a,b) => (a.team_name||'').localeCompare(b.team_name||'') || a.player_name.localeCompare(b.player_name));
  const eAlex   = rd.entries.find(e => e.player_name === 'Alex').id;
  const eBrooke = rd.entries.find(e => e.player_name === 'Brooke').id;
  const eCam    = rd.entries.find(e => e.player_name === 'Cam').id;
  const eDrew   = rd.entries.find(e => e.player_name === 'Drew').id;

  // ── Hand-computable Vegas scenario ───────────────────────────
  // 3 holes only. All par 4. No flip first.
  // Hole 1: Birdie=(4,6)=46 ; Eagle=(5,5)=55 → Birdie wins by 9
  // Hole 2: Birdie=(5,5)=55 ; Eagle=(4,4)=44 → Eagle wins by 11
  // Hole 3: Birdie=(4,5)=45 ; Eagle=(5,5)=55 → Birdie wins by 10
  // No birdies (all par or worse) → flip doesn't matter on these holes.
  // Total: Birdie +9 -11 +10 = +8, Eagle -8
  const scores = [
    { entry_id: eAlex,   hole_number: 1, strokes: 4 },
    { entry_id: eBrooke, hole_number: 1, strokes: 6 },
    { entry_id: eCam,    hole_number: 1, strokes: 5 },
    { entry_id: eDrew,   hole_number: 1, strokes: 5 },
    { entry_id: eAlex,   hole_number: 2, strokes: 5 },
    { entry_id: eBrooke, hole_number: 2, strokes: 5 },
    { entry_id: eCam,    hole_number: 2, strokes: 4 },
    { entry_id: eDrew,   hole_number: 2, strokes: 4 },
    { entry_id: eAlex,   hole_number: 3, strokes: 4 },
    { entry_id: eBrooke, hole_number: 3, strokes: 5 },
    { entry_id: eCam,    hole_number: 3, strokes: 5 },
    { entry_id: eDrew,   hole_number: 3, strokes: 5 },
  ];
  await postScores(token, trn.round_id, scores);
  console.log('[5] 12 scores posted (3 holes × 4 players)');

  // Pull the SSE
  const p1 = await ssePayload(trn.round_id);
  if (!p1.leaderboard || p1.leaderboard.scoreType !== 'vegas') {
    throw new Error('expected scoreType=vegas, got ' + (p1.leaderboard && p1.leaderboard.scoreType));
  }
  if (p1.leaderboard.rows.length !== 2) {
    throw new Error('expected 2 rows, got ' + p1.leaderboard.rows.length);
  }
  const birdie = p1.leaderboard.rows.find(r => r.teamName === 'Team Birdie');
  const eagle  = p1.leaderboard.rows.find(r => r.teamName === 'Team Eagle');
  if (birdie.total !== 8 || eagle.total !== -8) {
    throw new Error(`expected Birdie +8 / Eagle -8, got ${birdie.total} / ${eagle.total}`);
  }
  if (p1.format_settings?.value_per_point !== 0.5) {
    throw new Error('SSE payload missing value_per_point');
  }
  console.log('[6] Vegas math correct:  Birdie=+8 / Eagle=-8 ; $/pt=$0.50');
  console.log('     position 1:', p1.leaderboard.rows[0].playerName, 'total=', p1.leaderboard.rows[0].total);

  // ── Birdie-flip toggle: same scenario but with one player birdieing
  // (par 4 → score 3) and flip_birdie=false vs true. Build two parallel
  // tournaments and compare.
  const flipScenario = async (flipBirdie) => {
    const t = await createVegas(token, courseId, { value_per_point: 1, flip_birdie: flipBirdie });
    await addTeam(token, t.round_id, 'A', [{name:'A1', handicap_index:0}, {name:'A2', handicap_index:0}]);
    await addTeam(token, t.round_id, 'B', [{name:'B1', handicap_index:0}, {name:'B2', handicap_index:0}]);
    await activate(token, t.round_id);
    const r = await (await fetch(`${BASE}/api/rounds/${t.round_id}`, { headers:{'x-user-token':token} })).json();
    const ids = Object.fromEntries(r.entries.map(e => [e.player_name, e.id]));
    // Hole 1 par 4. A: 3 + 6 (A birdied). B: 5 + 6.
    // No flip: A=36, B=56 → A wins by 20
    // Flip on: A birdied, B must put high first → 65 ; A=36 → A wins by 29
    await postScores(token, t.round_id, [
      { entry_id: ids.A1, hole_number: 1, strokes: 3 }, // birdie
      { entry_id: ids.A2, hole_number: 1, strokes: 6 },
      { entry_id: ids.B1, hole_number: 1, strokes: 5 },
      { entry_id: ids.B2, hole_number: 1, strokes: 6 },
    ]);
    const p = await ssePayload(t.round_id);
    return p.leaderboard.rows.find(r => r.teamName === 'A').total;
  };
  const noFlip = await flipScenario(false);
  const flip   = await flipScenario(true);
  if (noFlip !== 20)  throw new Error(`expected noFlip=20, got ${noFlip}`);
  if (flip   !== 29)  throw new Error(`expected flip=29, got ${flip}`);
  console.log('[7] birdie-flip rule:  noFlip=+20  /  flipOn=+29  (delta=' + (flip - noFlip) + ')');

  // ── 4-PAIR (round-robin) VEGAS ───────────────────────────────
  const t4 = await createVegas(token, courseId, { value_per_point: 1, flip_birdie: false });
  for (const team of ['Pair-1', 'Pair-2', 'Pair-3', 'Pair-4']) {
    await addTeam(token, t4.round_id, team, [
      { name: team+'-A', handicap_index: 0 },
      { name: team+'-B', handicap_index: 0 },
    ]);
  }
  await activate(token, t4.round_id);
  const r4 = await (await fetch(`${BASE}/api/rounds/${t4.round_id}`, { headers:{'x-user-token':token} })).json();
  const ids4 = Object.fromEntries(r4.entries.map(e => [e.player_name, e.id]));
  // Easy round-robin scenario: each pair plays par on hole 1 (par 4, 4+4 = 44),
  // except Pair-4 plays bogey (4+5=45). All 6 head-to-head matchups:
  //  P1 vs P2 = 44 vs 44 = tie (0)
  //  P1 vs P3 = 44 vs 44 = tie
  //  P1 vs P4 = 44 vs 45 → P1 wins by 1
  //  P2 vs P3 = 44 vs 44 = tie
  //  P2 vs P4 = 44 vs 45 → P2 wins by 1
  //  P3 vs P4 = 44 vs 45 → P3 wins by 1
  // Totals: P1=+1, P2=+1, P3=+1, P4=-3
  await postScores(token, t4.round_id, [
    { entry_id: ids4['Pair-1-A'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-1-B'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-2-A'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-2-B'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-3-A'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-3-B'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-4-A'], hole_number: 1, strokes: 4 },
    { entry_id: ids4['Pair-4-B'], hole_number: 1, strokes: 5 },
  ]);
  const p4 = await ssePayload(t4.round_id);
  if (p4.leaderboard.rows.length !== 4) {
    throw new Error('expected 4 rows for 4-pair Vegas, got ' + p4.leaderboard.rows.length);
  }
  const totals = Object.fromEntries(p4.leaderboard.rows.map(r => [r.teamName, r.total]));
  if (totals['Pair-1'] !== 1 || totals['Pair-2'] !== 1 || totals['Pair-3'] !== 1 || totals['Pair-4'] !== -3) {
    throw new Error('round-robin totals wrong: ' + JSON.stringify(totals));
  }
  console.log('[8] 4-pair round-robin: P1=+1 P2=+1 P3=+1 P4=-3 ✓');

  console.log('\nALL PASS — Vegas works end-to-end:');
  console.log('  • settings round-trip (value_per_point + flip_birdie)');
  console.log('  • 2-pair scoring math correct');
  console.log('  • birdie-flip toggle changes margin from +20 → +29');
  console.log('  • 4-pair round-robin produces all 6 pair-vs-pair matchups');
  console.log('  • SSE payload carries the Vegas leaderboard + format_settings');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
