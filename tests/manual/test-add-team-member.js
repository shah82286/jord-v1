// E2E for v3.65.1:
//  1. Create a 2-Man Scramble round + add one team (Alex, Brooke)
//  2. POST /api/rounds/:id/teams/:teamId/members → add Cam to the same team
//  3. Confirm the team now has 3 members + the team handicap recomputed
//  4. Best-ball pair flavor: same flow with `better_ball_stroke` — adding
//     a player to an existing team creates a new round_entry instead of
//     a member row
const BASE = 'http://localhost:3000';

(async () => {
  const email = `atm-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AddTeamMember', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // ── One-ball format: 4-Person Scramble (team tier, 25/20/15/10 allowance)
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'AddMem Scramble', type: 'casual', course_id: courses[0].id, format: 'scramble_team' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Team Eagle',
      players: [{ name: 'Alex', handicap_index: 4 }, { name: 'Brooke', handicap_index: 12 }, { name: 'Cam', handicap_index: 18 }] }),
  });
  const rd1 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const teamEntry = rd1.entries[0];
  const teamId = teamEntry.team_id;
  const beforeTeamHcp = teamEntry.course_handicap;
  console.log('[2] 4-person scramble team starts with 3 members, team CH=' + beforeTeamHcp);

  // Add Drew (handicap 24) as the 4th member — this uses the 10% slot so
  // the team CH should shift.
  const r = await fetch(`${BASE}/api/rounds/${trn.round_id}/teams/${teamId}/members`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'Drew', handicap_index: 24 }),
  });
  if (!r.ok) throw new Error('add member failed: ' + r.status + ' ' + await r.text());
  const rd2 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const teamEntry2 = rd2.entries[0];
  if (!teamEntry2.members || teamEntry2.members.length !== 4) {
    throw new Error('expected 4 members after add, got ' + (teamEntry2.members || []).length);
  }
  const drew = teamEntry2.members.find(m => m.player_name === 'Drew');
  if (!drew) throw new Error('Drew not in members');
  // 4-person scramble uses 25/20/15/10 — adding a 4th player pulls in the
  // 10% slot, so the team handicap should INCREASE.
  if (teamEntry2.course_handicap === beforeTeamHcp) {
    throw new Error('team handicap did not recompute (still ' + beforeTeamHcp + ')');
  }
  console.log('[3] Drew added (CH ' + drew.course_handicap + '), team CH recomputed: ' +
    beforeTeamHcp + ' → ' + teamEntry2.course_handicap);

  // ── Best-ball pair flavor
  const trn2 = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'AddMem BB', type: 'casual', course_id: courses[0].id, format: 'better_ball_stroke' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${trn2.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Pair Birdie',
      players: [{ name: 'Ed', handicap_index: 8 }, { name: 'Fred', handicap_index: 16 }] }),
  });
  const rdBB = await (await fetch(`${BASE}/api/rounds/${trn2.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const teamIdBB = rdBB.entries[0].team_id;
  if (rdBB.entries.length !== 2) throw new Error('expected 2 entries (one per player) in BB, got ' + rdBB.entries.length);
  console.log('[4] better-ball pair created with 2 individual round_entries');

  const r2 = await fetch(`${BASE}/api/rounds/${trn2.round_id}/teams/${teamIdBB}/members`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'Gina', handicap_index: 22 }),
  });
  if (!r2.ok) throw new Error('add BB member failed: ' + r2.status);
  const rdBB2 = await (await fetch(`${BASE}/api/rounds/${trn2.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (rdBB2.entries.length !== 3) throw new Error('expected 3 entries after add, got ' + rdBB2.entries.length);
  const gina = rdBB2.entries.find(e => e.player_name === 'Gina');
  if (!gina) throw new Error('Gina missing');
  if (gina.team_id !== teamIdBB) throw new Error('Gina not in the same team');
  console.log('[5] Gina added as 3rd player on Pair Birdie (team_id matches, CH=' + gina.course_handicap + ')');

  console.log('\nALL PASS — add-to-existing-team works for both one-ball and best-ball formats');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
