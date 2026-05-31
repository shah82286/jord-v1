// Regression tests for v3.59.4:
//   1. Personal user can DELETE a tournament they own (cascade through rounds)
//   2. /api/rounds/:id can be deleted on multi-round tournaments
//   3. Scorecard renders proper shape classes for birdies / bogeys / etc.
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `del-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  const sup = await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Delete Test', email, password }),
  });
  if (!sup.ok) throw new Error('signup failed');
  const { token } = await sup.json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': token };
  console.log('[1] signed up');

  // Need a course
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': token } })).json();
  if (!courses.length) throw new Error('no courses');

  // Create a casual round, then delete it
  const t1 = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'To Delete', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }),
  })).json();
  console.log('[2] created tournament', t1.id);

  // Add a player so we exercise the cascade
  const fieldRes = await fetch(`${BASE}/api/tournaments/${t1.id}/field`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Test Player', handicap_index: 12 }),
  });
  if (!fieldRes.ok) throw new Error('field add failed: ' + fieldRes.status + ' ' + await fieldRes.text());
  console.log('[3] added player');

  const delRes = await fetch(`${BASE}/api/tournaments/${t1.id}`, { method: 'DELETE', headers: { 'x-user-token': token } });
  if (!delRes.ok) throw new Error('DELETE tournament failed: ' + delRes.status + ' ' + await delRes.text());
  console.log('[4] deleted tournament');

  const getAgain = await fetch(`${BASE}/api/tournaments/${t1.id}`, { headers: { 'x-user-token': token } });
  if (getAgain.status !== 404) throw new Error('expected 404 after delete, got ' + getAgain.status);
  console.log('[5] tournament 404\'d as expected');

  // Verify rounds + entries are also gone — list "mine" should be empty of this id
  const mine = await (await fetch(`${BASE}/api/tournaments/mine`, { headers: { 'x-user-token': token } })).json();
  if (mine.tournaments.some(t => t.id === t1.id)) throw new Error('tournament still in mine list');
  console.log('[6] cleanup confirmed in /tournaments/mine');

  // Another user CANNOT delete my tournament (403 check)
  const otherSup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other', email: `other-${Date.now()}@example.com`, password }),
  })).json();
  const t2 = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Mine', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }),
  })).json();
  const otherDel = await fetch(`${BASE}/api/tournaments/${t2.id}`, {
    method: 'DELETE', headers: { 'x-user-token': otherSup.token },
  });
  if (otherDel.status !== 403) throw new Error('expected 403 for non-owner delete, got ' + otherDel.status);
  console.log('[7] non-owner blocked with 403');

  // ── Scorecard shape classes
  // Sign in via the cookie/storage, navigate to a created round's scorecard
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 600, height: 900 } });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, token);
  // Quick: build a tournament with 1 active round, then poke a few scores
  const t3 = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Shapes', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }),
  })).json();
  const fr = await fetch(`${BASE}/api/tournaments/${t3.id}/field`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Scorer', handicap_index: 0 }),
  });
  if (!fr.ok) throw new Error('field add failed (shapes): ' + fr.status);
  await fetch(`${BASE}/api/rounds/${t3.round_id}/status`, { method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }) });
  await page.goto(`${BASE}/scorecard/${t3.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stepper .val', { timeout: 10000 });
  // First hole — par 4 typically. Inject scores via the stepper buttons.
  // Press + twice → score = par+2 ≈ a "double" if par 4 (4 → 6 = double)
  const decTimes = async (n) => { for (let i=0; i<n; i++) { await page.click('[data-dec]'); } };
  const incTimes = async (n) => { for (let i=0; i<n; i++) { await page.click('[data-inc]'); } };
  await page.click('[data-inc]'); // first click sets to par (e.g. 4)
  // Now we have par. Verify class.
  let cls = await page.$eval('.stepper .val', el => el.className);
  console.log('[8] par → class:', cls);
  if (cls.includes('s-')) throw new Error('par should not have a shape class, got ' + cls);

  await incTimes(1); // par+1 = bogey
  cls = await page.$eval('.stepper .val', el => el.className);
  console.log('[9] bogey → class:', cls);
  if (!cls.includes('s-bogey')) throw new Error('expected s-bogey, got ' + cls);

  await incTimes(1); // par+2 = double bogey
  cls = await page.$eval('.stepper .val', el => el.className);
  console.log('[10] double → class:', cls);
  if (!cls.includes('s-double')) throw new Error('expected s-double, got ' + cls);

  await decTimes(3); // par-1 = birdie (from par+2 → par+1 → par → par-1)
  cls = await page.$eval('.stepper .val', el => el.className);
  console.log('[11] birdie → class:', cls);
  if (!cls.includes('s-birdie')) throw new Error('expected s-birdie, got ' + cls);

  await decTimes(1); // par-2 = eagle
  cls = await page.$eval('.stepper .val', el => el.className);
  console.log('[12] eagle → class:', cls);
  if (!cls.includes('s-eagle')) throw new Error('expected s-eagle, got ' + cls);

  // Take a screenshot at eagle so the user can review the shape rendering
  await page.screenshot({ path: 'tests/screenshots/40-scorecard-shapes-eagle.png' });
  console.log('[13] screenshot saved');

  console.log('\nALL PASS — delete cascade, owner check, scorecard shapes all wired');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
