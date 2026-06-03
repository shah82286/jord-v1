// E2E for v3.67 — clone tournament + reset scores.
//   1. Create a 4-player stroke_net round
//   2. Post some scores
//   3. POST /reset-scores → scores gone, status='setup', players intact
//   4. POST /clone → new tournament with same players + format but no scores
const BASE = 'http://localhost:3000';

(async () => {
  const email = `cr-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Clone+Reset', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();

  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Day 1', type: 'casual', course_id: courses[0].id, format: 'skins',
      format_settings: { value_per_skin: 5 } }),
  })).json();
  for (const name of ['Alice', 'Bob', 'Cam', 'Drew']) {
    await fetch(`${BASE}/api/tournaments/${trn.id}/field`, { method: 'POST', headers: H,
      body: JSON.stringify({ name, handicap_index: 10 }) });
  }
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, { method: 'POST', headers: H,
    body: JSON.stringify({ status: 'active' }) });
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const ids = rd.entries.map(e => e.id);
  // Post some scores
  const scores = [];
  for (const eid of ids) for (let h = 1; h <= 3; h++) scores.push({ entry_id: eid, hole_number: h, strokes: 4 + h });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, { method: 'POST', headers: H,
    body: JSON.stringify({ scores, entered_by: 'test' }) });
  const rd1 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const playedCount = rd1.entries.reduce((a, e) => a + Object.keys(e.scores || {}).length, 0);
  console.log('[1] created Day 1 + 4 players + 12 scores; played=' + playedCount);
  if (playedCount !== 12) throw new Error('expected 12 score rows');

  // Reset
  const resRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/reset-scores`, { method: 'POST', headers: H });
  if (!resRes.ok) throw new Error('reset failed: ' + resRes.status);
  const rd2 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const cleared = rd2.entries.reduce((a, e) => a + Object.keys(e.scores || {}).length, 0);
  if (cleared !== 0) throw new Error('expected 0 scores after reset, got ' + cleared);
  if (rd2.round.status !== 'setup') throw new Error('expected status=setup after reset');
  if (rd2.entries.length !== 4) throw new Error('expected 4 entries preserved, got ' + rd2.entries.length);
  console.log('[2] reset-scores cleared all scores, status=setup, entries intact');

  // Clone
  const cloneRes = await fetch(`${BASE}/api/tournaments/${trn.id}/clone`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'Day 2' }),
  });
  if (!cloneRes.ok) throw new Error('clone failed: ' + cloneRes.status + ' ' + await cloneRes.text());
  const cloneOut = await cloneRes.json();
  console.log('[3] cloned to id=' + cloneOut.id);

  // Verify clone
  const newTrn = await (await fetch(`${BASE}/api/tournaments/${cloneOut.id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (newTrn.name !== 'Day 2') throw new Error('name mismatch: ' + newTrn.name);
  if (newTrn.default_format !== 'skins') throw new Error('format not copied');
  if (!newTrn.format_settings || newTrn.format_settings.value_per_skin !== 5) {
    throw new Error('format_settings not copied: ' + JSON.stringify(newTrn.format_settings));
  }
  const newRd = await (await fetch(`${BASE}/api/rounds/${newTrn.rounds[0].id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (newRd.entries.length !== 4) throw new Error('expected 4 entries cloned, got ' + newRd.entries.length);
  const cloneScores = newRd.entries.reduce((a, e) => a + Object.keys(e.scores || {}).length, 0);
  if (cloneScores !== 0) throw new Error('clone should have 0 scores, got ' + cloneScores);
  const playerNames = newRd.entries.map(e => e.player_name).sort();
  if (playerNames.join(',') !== 'Alice,Bob,Cam,Drew') {
    throw new Error('player names not cloned: ' + playerNames.join(','));
  }
  if (newRd.round.status !== 'setup') throw new Error('clone should land in setup status');
  console.log('[4] clone preserved: name="Day 2", format=stroke_net, settings.value_per_skin=5, 4 players (Alice/Bob/Cam/Drew), zero scores, status=setup');

  console.log('\nALL PASS — clone + reset-scores both work end-to-end');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
