// E2E for v3.66.3 — skins leaderboard drawer shows which holes the player
// won + carryover indicators on tied holes.
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `sk-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Skins Drawer', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // Skins round + 3 players
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Skins Drawer Test', type: 'casual',
      course_id: courses[0].id, format: 'skins',
      format_settings: { value_per_skin: 5 } }),
  })).json();
  for (const name of ['Alice', 'Bob', 'Fitzy']) {
    await fetch(`${BASE}/api/tournaments/${trn.id}/field`, { method: 'POST', headers: H,
      body: JSON.stringify({ name, handicap_index: 0 }) });
  }
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, { method: 'POST', headers: H,
    body: JSON.stringify({ status: 'active' }) });
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const id = name => rd.entries.find(e => e.player_name === name).id;
  // Hole 1: Alice 4, Bob 5, Fitzy 5 — Alice wins skin (value 1).
  // Hole 2: Alice 4, Bob 4, Fitzy 4 — tied, carries to hole 3.
  // Hole 3: Alice 5, Bob 5, Fitzy 4 — Fitzy wins skin (value 2, includes carry).
  // Hole 4: Alice 5, Bob 4, Fitzy 4 — tied between Bob+Fitzy, carries.
  await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ scores: [
      { entry_id: id('Alice'), hole_number: 1, strokes: 4 },
      { entry_id: id('Bob'),   hole_number: 1, strokes: 5 },
      { entry_id: id('Fitzy'), hole_number: 1, strokes: 5 },
      { entry_id: id('Alice'), hole_number: 2, strokes: 4 },
      { entry_id: id('Bob'),   hole_number: 2, strokes: 4 },
      { entry_id: id('Fitzy'), hole_number: 2, strokes: 4 },
      { entry_id: id('Alice'), hole_number: 3, strokes: 5 },
      { entry_id: id('Bob'),   hole_number: 3, strokes: 5 },
      { entry_id: id('Fitzy'), hole_number: 3, strokes: 4 },
      { entry_id: id('Alice'), hole_number: 4, strokes: 5 },
      { entry_id: id('Bob'),   hole_number: 4, strokes: 4 },
      { entry_id: id('Fitzy'), hole_number: 4, strokes: 4 },
    ], entered_by: 'test' }),
  });
  console.log('[2] scores posted');

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 600, height: 1200 } });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);
  await page.goto(`${BASE}/live/${trn.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-row.expandable', { timeout: 10000 });
  // Find Fitzy's row + click it to expand
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.lb-row.expandable'));
    const fitzy = rows.find(r => r.textContent.includes('Fitzy'));
    if (fitzy) fitzy.click();
  });
  await page.waitForSelector('.lb-drawer.is-open .cell.skin', { timeout: 5000 });

  const probe = await page.evaluate(() => {
    const drawer = document.querySelector('.lb-drawer.is-open');
    const winCells = drawer.querySelectorAll('.cell.skin:not(.empty):not(.carry)');
    const carryCells = drawer.querySelectorAll('.cell.skin.carry');
    const winText = [...winCells].map(c => c.textContent.trim());
    const carryCount = carryCells.length;
    return { winText, carryCount };
  });
  console.log('[3] Fitzy drawer probe:', probe);
  // Fitzy should have won hole 3 with value 2 (carry), so text reads "💰×2"
  if (!probe.winText.some(t => t.includes('💰'))) {
    throw new Error('expected at least one 💰 win marker, got ' + JSON.stringify(probe.winText));
  }
  // Hole 2 is a tied carryover (and hole 4 is too since the round ends mid-game)
  if (probe.carryCount < 1) throw new Error('expected at least one ↻ carry marker, got ' + probe.carryCount);

  await page.screenshot({ path: 'tests/screenshots/73-skins-drawer.png' });
  console.log('[4] screenshot saved');

  await browser.close();
  console.log('\nALL PASS — skins drawer shows win + carryover markers');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
