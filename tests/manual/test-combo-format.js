// E2E for v3.60 combo formats: a personal user creates a Stroke Net + Skins
// side-bet game, posts scores, and pulls the round payload to confirm both
// leaderboards are present.
const BASE = 'http://localhost:3000';

(async () => {
  const email = `combo-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Combo Tester', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up, course id:', courses[0].id);

  // Create tournament with primary=stroke_net + Skins side-bet
  const trnRes = await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Combo Test',
      type: 'casual',
      course_id: courses[0].id,
      format: 'stroke_net',
      format_settings: {},
      side_bets: [{ format_id: 'skins', settings: { value_per_skin: 10 } }],
    }),
  });
  if (!trnRes.ok) throw new Error('POST tournament failed: ' + trnRes.status + ' ' + await trnRes.text());
  const trn = await trnRes.json();
  console.log('[2] created combo tournament', trn.id);

  // Read back — confirm side_bets persisted
  const trnFull = await (await fetch(`${BASE}/api/tournaments/${trn.id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (!Array.isArray(trnFull.side_bets) || trnFull.side_bets.length !== 1) {
    throw new Error('side_bets did not round-trip: ' + JSON.stringify(trnFull.side_bets));
  }
  if (trnFull.side_bets[0].format_id !== 'skins' || trnFull.side_bets[0].settings.value_per_skin !== 10) {
    throw new Error('side_bets shape wrong: ' + JSON.stringify(trnFull.side_bets));
  }
  console.log('[3] side_bets round-tripped:', trnFull.side_bets);

  // Add two players + start the round
  for (const name of ['Alice', 'Bob']) {
    const r = await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
      method: 'POST', headers: H, body: JSON.stringify({ name, handicap_index: 0 }),
    });
    if (!r.ok) throw new Error(`POST field ${name} failed: ${r.status}`);
  }
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  console.log('[4] players + round active');

  // Pull the round data — get the two entries' ids
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const aliceId = rd.entries[0].id, bobId = rd.entries[1].id;

  // Post a few scores so each engine has data
  const scores = [
    { entry_id: aliceId, hole_number: 1, strokes: 4 },
    { entry_id: bobId,   hole_number: 1, strokes: 5 },
    { entry_id: aliceId, hole_number: 2, strokes: 5 },
    { entry_id: bobId,   hole_number: 2, strokes: 4 },
    { entry_id: aliceId, hole_number: 3, strokes: 4 },
    { entry_id: bobId,   hole_number: 3, strokes: 5 },
  ];
  const sres = await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, {
    method: 'POST', headers: H, body: JSON.stringify({ scores, entered_by: 'test' }),
  });
  if (!sres.ok) throw new Error('POST scores failed: ' + sres.status);
  console.log('[5] posted 6 scores');

  // Pull the live SSE payload (first event) — confirm sideBets[] is populated
  // alongside the primary leaderboard.
  const ssePayload = await new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({
      hostname: 'localhost', port: 3000,
      path: `/api/rounds/${trn.round_id}/stream`,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/^data: (\{.*\})\n\n/);
        if (m) {
          try { resolve(JSON.parse(m[1])); } catch (e) { reject(e); }
          req.destroy();
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 5000);
  });

  if (!ssePayload.leaderboard || !ssePayload.leaderboard.rows) {
    throw new Error('SSE payload missing primary leaderboard');
  }
  if (!Array.isArray(ssePayload.sideBets) || ssePayload.sideBets.length !== 1) {
    throw new Error('SSE payload missing sideBets[1]: ' + JSON.stringify(ssePayload.sideBets));
  }
  if (ssePayload.sideBets[0].formatId !== 'skins') {
    throw new Error('sideBets[0] wrong format: ' + JSON.stringify(ssePayload.sideBets[0]));
  }
  if (!ssePayload.sideBets[0].leaderboard.rows.length) {
    throw new Error('Skins side-bet leaderboard empty');
  }
  console.log('[6] SSE payload has primary + Skins side-bet leaderboard');
  console.log('     primary scoreType=' + ssePayload.leaderboard.scoreType + ' rows=' + ssePayload.leaderboard.rows.length);
  console.log('     side-bet  scoreType=' + ssePayload.sideBets[0].leaderboard.scoreType + ' rows=' + ssePayload.sideBets[0].leaderboard.rows.length);

  console.log('\nALL PASS — combo format persists + live SSE serves both leaderboards');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
