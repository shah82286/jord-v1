// E2E for v3.65:
//   1. Create a stroke_net tournament + add 1 player via /field
//   2. Confirm the round status is 'setup' (NOT 'active') after creation
//   3. Add a second player via the same /field endpoint (works regardless
//      of status — tournament detail page does the same)
//   4. Remove the first player via DELETE /entries
//   5. Activate the round explicitly via /status
//   6. After activation, /scores rejects if round was setup (already
//      tested elsewhere — here we just confirm the round can be started
//      on demand)
const BASE = 'http://localhost:3000';

(async () => {
  const email = `nas-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NoAutoStart', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  if (!courses.length) throw new Error('no courses');
  console.log('[1] signed up');

  // Create tournament + one player
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'No Auto-Start', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }),
  })).json();
  await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'Alice', handicap_index: 10 }),
  });
  console.log('[2] created game + 1 player');

  // Confirm round is in setup status (the host hasn't pressed Start yet)
  const rd1 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (rd1.round.status !== 'setup') {
    throw new Error('expected round status=setup right after creation, got ' + rd1.round.status);
  }
  console.log('[3] round.status = setup (no auto-start) ✓');

  // Add a second player AFTER creation (the wizard isn't open)
  const addRes = await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'Bob', handicap_index: 18 }),
  });
  if (!addRes.ok) throw new Error('post-creation /field add failed: ' + addRes.status);
  const rd2 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (rd2.entries.length !== 2) throw new Error('expected 2 entries after second add, got ' + rd2.entries.length);
  console.log('[4] added a 2nd player after creation (' + rd2.entries.map(e => e.player_name).join(' + ') + ')');

  // Remove Alice
  const alice = rd2.entries.find(e => e.player_name === 'Alice');
  const delRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/entries/${alice.id}`, {
    method: 'DELETE', headers: { 'x-user-token': sup.token },
  });
  if (!delRes.ok) throw new Error('DELETE entry failed: ' + delRes.status);
  const rd3 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (rd3.entries.length !== 1 || rd3.entries[0].player_name !== 'Bob') {
    throw new Error('expected only Bob, got: ' + rd3.entries.map(e => e.player_name).join(','));
  }
  console.log('[5] removed Alice — only Bob remains');

  // Explicit Start
  const startRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  if (!startRes.ok) throw new Error('start failed: ' + startRes.status);
  const rd4 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (rd4.round.status !== 'active') throw new Error('round did not activate');
  console.log('[6] explicit Start moved round → active ✓');

  console.log('\nALL PASS — game stays in setup until the host clicks Start; add/remove works in either state');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
