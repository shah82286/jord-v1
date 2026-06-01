// E2E for v3.62.2 — verify a Scramble round exposes per-team-member
// handicaps so the scorecard can break out who gets strokes on each hole.
const BASE = 'http://localhost:3000';

(async () => {
  const email = `strk-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Stroke Tester', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // Create a 2-Man Scramble (engine='scramble', allowance='scramble2')
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Scramble Detail', type: 'casual',
      course_id: courses[0].id, format: 'scramble_2man',
    }),
  })).json();
  console.log('[2] Scramble tournament', trn.id);

  // Add 2 teams of 2 with varied handicaps
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Team Birdie',
      players: [
        { name: 'Alex',   handicap_index: 4  },
        { name: 'Brooke', handicap_index: 18 },
      ],
    }),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Team Eagle',
      players: [
        { name: 'Cam',    handicap_index: 12 },
        { name: 'Drew',   handicap_index: 24 },
      ],
    }),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  console.log('[3] 2 teams created + activated');

  // Pull the round payload
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, {
    headers: { 'x-user-token': sup.token }
  })).json();
  console.log('[4] /api/rounds/:id returned', rd.entries.length, 'entries');

  if (rd.entries.length !== 2) throw new Error('expected 2 team cards, got ' + rd.entries.length);

  for (const e of rd.entries) {
    console.log(`    ${e.player_name} — team CH ${e.course_handicap}`);
    if (!Array.isArray(e.members) || !e.members.length) {
      throw new Error('entry ' + e.player_name + ' missing members array');
    }
    for (const m of e.members) {
      if (m.handicap_index == null) throw new Error('member ' + m.player_name + ' missing handicap_index');
      if (m.course_handicap == null) throw new Error('member ' + m.player_name + ' missing course_handicap');
      console.log(`      • ${m.player_name}  HCP ${m.handicap_index}  CH ${m.course_handicap}`);
    }
  }
  console.log('[5] every team carries its full per-player roster + handicaps');

  console.log('\nALL PASS — scramble round exposes individual member handicaps');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
