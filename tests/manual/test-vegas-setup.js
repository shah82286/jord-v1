// Regression test for the v3.59.2 401 fix: a personal user creates a Vegas
// game from scratch. Verifies the previously-admin-only endpoints
// (/api/rounds/:id/teams, /api/rounds/:id/status) now accept user tokens
// when the user owns the parent tournament.
const BASE = 'http://localhost:3000';

(async () => {
  const email = `vegas-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  // Sign up + grab token
  const sup = await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Vegas Tester', email, password }),
  });
  if (!sup.ok) throw new Error('signup failed: ' + sup.status);
  const { token } = await sup.json();
  console.log('[1] signed up', email);

  const H = { 'Content-Type': 'application/json', 'x-user-token': token };

  // Need a course
  const cRes = await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': token } });
  const courses = await cRes.json();
  if (!courses.length) throw new Error('no courses available');
  console.log('[2] using course', courses[0].id);

  // Create Vegas tournament
  const trnRes = await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Test Vegas Setup',
      type: 'casual',
      course_id: courses[0].id,
      format: 'vegas',
      format_settings: { value_per_point: 0.5, flip_birdie: true },
    }),
  });
  if (!trnRes.ok) throw new Error('POST tournament failed: ' + trnRes.status + ' ' + await trnRes.text());
  const trn = await trnRes.json();
  console.log('[3] created Vegas tournament', trn.id, 'round', trn.round_id);

  // Create the two pair teams — THIS used to 401 for personal users
  for (const team of [
    { name: 'Team Birdie', players: [{ name: 'Alex',   handicap_index: 4  }, { name: 'Brooke', handicap_index: 12 }] },
    { name: 'Team Eagle',  players: [{ name: 'Cam',    handicap_index: 18 }, { name: 'Drew',   handicap_index: 24 }] },
  ]) {
    const tRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
      method: 'POST', headers: H, body: JSON.stringify(team),
    });
    if (!tRes.ok) throw new Error(`POST team ${team.name} failed: ${tRes.status} ${await tRes.text()}`);
    console.log(`[4.${team.name}] team created`);
  }

  // Start the round — THIS also used to 401 for personal users
  const statRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  if (!statRes.ok) throw new Error('POST status failed: ' + statRes.status + ' ' + await statRes.text());
  console.log('[5] round activated');

  // Read back the tournament — confirm format_settings persisted
  const back = await fetch(`${BASE}/api/tournaments/${trn.id}`, { headers: { 'x-user-token': token } });
  if (!back.ok) throw new Error('GET tournament failed: ' + back.status);
  const trnFull = await back.json();
  if (!trnFull.format_settings || trnFull.format_settings.value_per_point !== 0.5) {
    throw new Error('format_settings did not round-trip: ' + JSON.stringify(trnFull.format_settings));
  }
  console.log('[6] format_settings round-tripped:', trnFull.format_settings);

  console.log('\nALL PASS — personal-user Vegas setup works end-to-end (no 401)');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
