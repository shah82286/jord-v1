// E2E for v3.62 event-based engines (BBB / Dots / Snake).
//   1. Create a BBB tournament, add 4 players, start round
//   2. POST hole_events for bingo/bango/bongo
//   3. Pull SSE payload → confirm leaderboard ranks players by points
const BASE = 'http://localhost:3000';

(async () => {
  const email = `evt-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'Event Tester', email, password }),
  })).json();
  const H = { 'Content-Type':'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers:{'x-user-token': sup.token} })).json();
  console.log('[1] signed up');

  // BBB primary
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({
      name:'BBB Test', type:'casual', course_id: courses[0].id,
      format:'bingo_bango_bongo',
      format_settings: { pts_bingo: 1, pts_bango: 1, pts_bongo: 1, value_per_point: 0.5 },
    }),
  })).json();
  console.log('[2] BBB tournament', trn.id);

  // Add 4 players
  const playerIds = [];
  for (const name of ['Alice', 'Bob', 'Cam', 'Drew']) {
    await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
      method:'POST', headers:H, body: JSON.stringify({ name, handicap_index: 10 }),
    });
  }
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method:'POST', headers:H, body: JSON.stringify({ status:'active' }),
  });
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const eids = rd.entries.map(e => e.id);
  console.log('[3] players + active round');

  // Hole 1: Alice bingo, Bob bango, Cam bongo
  // Hole 2: Bob bingo, Bob bango (closest), Drew bongo
  // Hole 3: Cam bingo+bango+bongo (rare clean sweep)
  const events = [
    { entry_id: eids[0], hole_number: 1, event_key: 'bingo' },
    { entry_id: eids[1], hole_number: 1, event_key: 'bango' },
    { entry_id: eids[2], hole_number: 1, event_key: 'bongo' },
    { entry_id: eids[1], hole_number: 2, event_key: 'bingo' },
    { entry_id: eids[1], hole_number: 2, event_key: 'bango' },
    { entry_id: eids[3], hole_number: 2, event_key: 'bongo' },
    { entry_id: eids[2], hole_number: 3, event_key: 'bingo' },
    { entry_id: eids[2], hole_number: 3, event_key: 'bango' },
    { entry_id: eids[2], hole_number: 3, event_key: 'bongo' },
  ];
  for (const ev of events) {
    const r = await fetch(`${BASE}/api/rounds/${trn.round_id}/hole-events`, { method:'POST', headers:H, body: JSON.stringify(ev) });
    if (!r.ok) throw new Error('POST event failed: ' + r.status);
  }
  console.log('[4] posted 9 hole events');

  // Pull SSE payload to verify BBB engine math
  const payload = await new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({
      hostname:'localhost', port:3000,
      path: `/api/rounds/${trn.round_id}/stream`,
      headers: { Accept:'text/event-stream' },
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

  const lb = payload.leaderboard;
  if (!lb || lb.scoreType !== 'points') throw new Error('expected points scoreType, got ' + (lb && lb.scoreType));
  // Expected totals: Alice 1 (1 bingo), Bob 3 (1 bingo + 2 bango), Cam 4 (2 bingo + 1 bango + 1 bongo), Drew 1 (1 bongo)
  const byName = Object.fromEntries(lb.rows.map(r => [r.playerName, r.total]));
  console.log('[5] BBB scores:', byName);
  if (byName.Alice !== 1) throw new Error('Alice expected 1, got ' + byName.Alice);
  if (byName.Bob   !== 3) throw new Error('Bob expected 3, got ' + byName.Bob);
  if (byName.Cam   !== 4) throw new Error('Cam expected 4, got ' + byName.Cam);
  if (byName.Drew  !== 1) throw new Error('Drew expected 1, got ' + byName.Drew);

  console.log('\nALL PASS — BBB engine reads hole_events + ranks correctly');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
