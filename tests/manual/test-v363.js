// E2E for v3.63 — verify:
//  1. Edit individual player entry via PATCH (name, handicap_index, tee_id)
//     → course_handicap is recomputed
//  2. Edit team member via PATCH → member handicap updates + team handicap
//     recomputes from the new roster
//  3. /card/:roundId page loads + renders
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `v363-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'V363 Tester', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // ── 1. Individual stroke-net tournament + one player + PATCH it
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'V363', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }),
  })).json();
  const addRes = await fetch(`${BASE}/api/tournaments/${trn.id}/field`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'OriginalName', handicap_index: 10 }),
  });
  if (!addRes.ok) throw new Error('field add failed: ' + addRes.status);
  // Get the entry id from the round
  const rd1 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const entryId = rd1.entries[0].id;
  const beforeHcp = rd1.entries[0].course_handicap;
  console.log('[2] created stroke_net with player; course_handicap=', beforeHcp);

  // PATCH the entry — change name + handicap_index
  const pRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/entries/${entryId}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ name: 'RenamedPlayer', handicap_index: 22 }),
  });
  if (!pRes.ok) throw new Error('PATCH failed: ' + pRes.status + ' ' + await pRes.text());
  const rd2 = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const afterHcp = rd2.entries[0].course_handicap;
  if (rd2.entries[0].player_name !== 'RenamedPlayer') throw new Error('name did not update');
  if (afterHcp === beforeHcp) throw new Error('course_handicap did not recompute (was ' + beforeHcp + ', still ' + afterHcp + ')');
  console.log('[3] PATCH entry: name -> RenamedPlayer, hcp 10→22, CH', beforeHcp, '→', afterHcp);

  // ── 2. Scramble + team-member PATCH
  const trn2 = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'V363 Team', type: 'casual', course_id: courses[0].id, format: 'scramble_2man' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${trn2.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Team A',
      players: [{ name: 'Alice', handicap_index: 4 }, { name: 'Bob', handicap_index: 18 }],
    }),
  });
  const rd3 = await (await fetch(`${BASE}/api/rounds/${trn2.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const teamEntry = rd3.entries[0];
  const beforeTeamHcp = teamEntry.course_handicap;
  const bobMember = teamEntry.members.find(m => m.player_name === 'Bob');
  const beforeBobCh = bobMember.course_handicap;
  console.log('[4] scramble team — team CH', beforeTeamHcp, '; Bob CH', beforeBobCh, '(HCP 18)');

  const mRes = await fetch(`${BASE}/api/rounds/${trn2.round_id}/team-members/${bobMember.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ handicap_index: 30 }),
  });
  if (!mRes.ok) throw new Error('member PATCH failed: ' + mRes.status + ' ' + await mRes.text());
  const rd4 = await (await fetch(`${BASE}/api/rounds/${trn2.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const teamEntry2 = rd4.entries[0];
  const bobMember2 = teamEntry2.members.find(m => m.player_name === 'Bob');
  if (bobMember2.handicap_index !== 30) throw new Error('Bob HCP did not update');
  if (bobMember2.course_handicap === beforeBobCh) throw new Error('Bob CH did not recompute');
  if (teamEntry2.course_handicap === beforeTeamHcp) throw new Error('team CH did not recompute');
  console.log('[5] PATCH member: Bob HCP 18→30, CH', beforeBobCh, '→', bobMember2.course_handicap,
              '; team CH', beforeTeamHcp, '→', teamEntry2.course_handicap);

  // ── 3. /card/:roundId page loads
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);

  // Activate the scramble round + post a couple scores so the card has data
  await fetch(`${BASE}/api/rounds/${trn2.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  await fetch(`${BASE}/api/rounds/${trn2.round_id}/scores`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      scores: [
        { entry_id: teamEntry.id, hole_number: 1, strokes: 4 },
        { entry_id: teamEntry.id, hole_number: 2, strokes: 5 },
        { entry_id: teamEntry.id, hole_number: 4, strokes: 5 },
      ],
      entered_by: 'test',
    }),
  });

  await page.goto(`${BASE}/card/${trn2.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.gridcard', { timeout: 10000 });
  // Verify a Par row, Strk pattern, and member sub-row exist
  const hasPar = await page.$$eval('tr.par', rows => rows.length >= 1);
  const hasPlayer = await page.$$eval('tr.player', rows => rows.length >= 1);
  const hasMember = await page.$$eval('tr.member', rows => rows.length >= 1);
  if (!hasPar || !hasPlayer || !hasMember) throw new Error(`grid missing rows: par=${hasPar} player=${hasPlayer} member=${hasMember}`);
  console.log('[6] /card/:id renders par + player + member sub-rows');

  await page.screenshot({ path: 'tests/screenshots/60-card-view.png', fullPage: false });
  console.log('[7] screenshot saved');

  await browser.close();
  console.log('\nALL PASS — v3.63 (edit players + scorecard grid)');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
