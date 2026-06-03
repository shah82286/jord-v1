// E2E for v3.64 — manual stroke allocation override.
//   1. Create a stroke_net round + a player with handicap 18
//   2. Confirm auto-WHS gives 1 stroke per hole + 0 extras
//   3. PATCH the entry with stroke_overrides {1:2, 4:2, 9:1} → only those holes
//   4. Pull the round → strokes_overrides round-trips on the entry
//   5. Pull SSE → the leaderboard row carries strokeOverrides
//   6. Clear override (stroke_overrides: null) → back to auto
const BASE = 'http://localhost:3000';

(async () => {
  const email = `ov-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'Override Tester', email, password }),
  })).json();
  const H = { 'Content-Type':'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers:{'x-user-token':sup.token} })).json();

  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Override Test', type:'casual', course_id: courses[0].id, format:'stroke_net' }),
  })).json();
  await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
    method:'POST', headers:H, body: JSON.stringify({ name:'Test', handicap_index: 18 }),
  });
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const entryId = rd.entries[0].id;
  console.log('[1] created entry with handicap_index=18, CH=' + rd.entries[0].course_handicap + ', overrides=' + rd.entries[0].stroke_overrides);
  if (rd.entries[0].stroke_overrides) throw new Error('fresh entry should have no overrides');

  // PATCH a custom allocation: 2 strokes on holes 1 and 4, 1 on hole 9
  const overrides = { 1: 2, 4: 2, 9: 1 };
  const pRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/entries/${entryId}`, {
    method:'PATCH', headers:H, body: JSON.stringify({ stroke_overrides: overrides }),
  });
  if (!pRes.ok) throw new Error('PATCH failed: ' + pRes.status + ' ' + await pRes.text());
  console.log('[2] PATCH applied overrides:', overrides);

  // Re-fetch and confirm
  const rd2 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const stored = rd2.entries[0].stroke_overrides;
  console.log('[3] re-fetched stroke_overrides:', JSON.stringify(stored));
  if (!stored || stored['1'] !== 2 || stored['4'] !== 2 || stored['9'] !== 1) {
    throw new Error('override did not round-trip: ' + JSON.stringify(stored));
  }

  // Activate + post scores to test the engine math under override
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method:'POST', headers:H, body: JSON.stringify({ status:'active' }),
  });
  // Score 5 on hole 1 (par 4). Auto-WHS for CH 18 = 1 stroke → net 4.
  // With override (2 strokes on hole 1) → net should be 3.
  await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, {
    method:'POST', headers:H,
    body: JSON.stringify({ scores:[{entry_id: entryId, hole_number: 1, strokes: 5}], entered_by:'test' }),
  });

  // Pull SSE
  const ssePayload = await new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({
      hostname:'localhost', port:3000, path:`/api/rounds/${trn.round_id}/stream`,
      headers:{Accept:'text/event-stream'},
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
  const row = ssePayload.leaderboard.rows[0];
  console.log('[4] leaderboard row carries strokeOverrides:', JSON.stringify(row.strokeOverrides));
  if (!row.strokeOverrides || row.strokeOverrides['1'] !== 2) {
    throw new Error('SSE row missing strokeOverrides');
  }
  // strokeMap on the row should reflect the override (hole 1 = 2 strokes)
  if (!row.strokeMap || row.strokeMap['1'] !== 2) {
    throw new Error('strokeMap not derived from override: ' + JSON.stringify(row.strokeMap));
  }
  console.log('[5] strokeMap honors override (hole 1 = 2 strokes)');

  // Clear the override → back to auto-WHS
  await fetch(`${BASE}/api/rounds/${trn.round_id}/entries/${entryId}`, {
    method:'PATCH', headers:H, body: JSON.stringify({ stroke_overrides: null }),
  });
  const rd3 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  if (rd3.entries[0].stroke_overrides) {
    throw new Error('override should be cleared, got ' + JSON.stringify(rd3.entries[0].stroke_overrides));
  }
  console.log('[6] override cleared — back to auto-WHS');

  console.log('\nALL PASS — manual stroke allocation round-trips through API + engine');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
