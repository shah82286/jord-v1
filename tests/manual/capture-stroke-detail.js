// Screenshot the scorecard for a Scramble round showing the per-member
// handicap breakdown + strokes-on-this-hole banner.
const puppeteer = require('puppeteer');
const path = require('path');
const SHOTS = path.join(__dirname, '..', 'screenshots');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `shotstrk-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'Shot', email, password }),
  })).json();
  const H = { 'Content-Type':'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers:{'x-user-token':sup.token} })).json();

  // 2-Man Scramble
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Scramble Detail', type:'casual',
      course_id: courses[0].id, format:'scramble_2man' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Team Birdie',
      players:[{name:'Alex',handicap_index:4},{name:'Brooke',handicap_index:18}] }),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/teams`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Team Eagle',
      players:[{name:'Cam',handicap_index:12},{name:'Drew',handicap_index:24}] }),
  });
  await fetch(`${BASE}/api/rounds/${trn.round_id}/status`, {
    method:'POST', headers:H, body: JSON.stringify({ status:'active' }),
  });
  // Post a few scores to give the scorecard substance
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, {
    headers:{'x-user-token': sup.token}
  })).json();
  const teamIds = rd.entries.map(e => e.id);
  await fetch(`${BASE}/api/rounds/${trn.round_id}/scores`, {
    method:'POST', headers:H,
    body: JSON.stringify({
      scores: [
        { entry_id: teamIds[0], hole_number: 1, strokes: 4 },
        { entry_id: teamIds[0], hole_number: 2, strokes: 5 },
        { entry_id: teamIds[1], hole_number: 1, strokes: 5 },
        { entry_id: teamIds[1], hole_number: 2, strokes: 4 },
      ],
      entered_by: 'screenshot',
    }),
  });

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 600, height: 1100 } });
  const page = await browser.newPage();

  await page.goto(`${BASE}/scorecard/${trn.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.members-list', { timeout: 10000 });
  // Navigate to hole 4 (par 4, SI 1) so the banner shows handicap strokes
  await page.evaluate(() => {
    const four = Array.from(document.querySelectorAll('[data-h]')).find(d => +d.dataset.h === 4);
    if (four) four.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOTS, '50-scramble-stroke-detail.png') });
  console.log('1. scramble scorecard (hole 4, SI 1) — per-member strokes visible');

  // Live leaderboard
  await page.setViewport({ width: 600, height: 1100 });
  await page.goto(`${BASE}/live/${trn.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-row', { timeout: 10000 });
  // Click the first row to expand the drawer
  await page.evaluate(() => {
    const r = document.querySelector('.lb-row.expandable');
    if (r) r.click();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(SHOTS, '51-live-leaderboard-strokes.png') });
  console.log('2. live leaderboard with hole-by-hole drawer + Strk row');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
