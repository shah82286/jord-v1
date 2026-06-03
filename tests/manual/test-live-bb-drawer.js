// E2E + screenshot for the live-page best-ball drawer (v3.66.1).
// Creates a 2-pair best-ball game, posts scores, opens /live/:id, expands
// a team row, and confirms each member's hole grid renders with the
// winning cell outlined.
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `lbb-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Live BB Drawer', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // Better Ball Stroke + 2 teams of 2
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'BB Live', type: 'casual',
      course_id: courses[0].id, format: 'better_ball_stroke' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Pair Birdie', players: [
      { name: 'Alex',   handicap_index: 0 },
      { name: 'Brooke', handicap_index: 0 },
    ]}),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Pair Eagle', players: [
      { name: 'Cam',  handicap_index: 0 },
      { name: 'Drew', handicap_index: 0 },
    ]}),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }),
  });
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const id = name => rd.entries.find(e => e.player_name === name).id;
  // Post varied scores to give the drawer something to outline
  await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ scores: [
      { entry_id: id('Alex'),   hole_number: 1, strokes: 4 },
      { entry_id: id('Brooke'), hole_number: 1, strokes: 6 },
      { entry_id: id('Alex'),   hole_number: 2, strokes: 5 },
      { entry_id: id('Brooke'), hole_number: 2, strokes: 4 },
      { entry_id: id('Alex'),   hole_number: 3, strokes: 4 },
      { entry_id: id('Brooke'), hole_number: 3, strokes: 4 },
      { entry_id: id('Cam'),    hole_number: 1, strokes: 5 },
      { entry_id: id('Drew'),   hole_number: 1, strokes: 5 },
    ], entered_by: 'test' }),
  });
  console.log('[2] best-ball game set up + scores posted');

  // Open live page, expand the first team
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 600, height: 1200 } });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);
  await page.goto(`${BASE}/live/${trn.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-row.expandable', { timeout: 10000 });
  // Click the first team row to expand
  await page.click('.lb-row.expandable');
  await page.waitForSelector('.lb-drawer.is-open .member-section', { timeout: 5000 });

  // Verify member sections rendered + at least one "used" cell exists
  const probe = await page.evaluate(() => {
    const drawer = document.querySelector('.lb-drawer.is-open');
    const sections = drawer.querySelectorAll('.member-section');
    const memberNames = Array.from(sections).map(s => s.querySelector('.nm')?.textContent.trim());
    const usedCells = drawer.querySelectorAll('.cell.score.used').length;
    return { sectionCount: sections.length, memberNames, usedCells };
  });
  console.log('[3] drawer probe:', probe);
  if (probe.sectionCount < 2) throw new Error('expected 2 member sections, got ' + probe.sectionCount);
  if (probe.usedCells < 1)    throw new Error('expected at least 1 cell with .used class');

  await page.screenshot({ path: 'tests/screenshots/71-live-bb-drawer.png' });
  console.log('[4] screenshot saved');

  await browser.close();
  console.log('\nALL PASS — live drawer shows member sub-grids with winning cell outlined');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
