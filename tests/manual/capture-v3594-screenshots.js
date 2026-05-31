// Screenshots showing v3.59.4: delete UI + scorecard shapes
const puppeteer = require('puppeteer');
const path = require('path');
const SHOTS = path.join(__dirname, '..', 'screenshots');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `shot-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  // Sign up
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Shots', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();

  // Create two games so we can see the delete X
  for (const name of ['Saturday Skins', 'Charity Scramble']) {
    await fetch(`${BASE}/api/tournaments`, { method: 'POST', headers: H,
      body: JSON.stringify({ name, type: 'casual', course_id: courses[0].id, format: 'stroke_net' }) });
  }

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);

  // Clubhouse with delete X (hover state simulated via CSS class)
  await page.goto(`${BASE}/clubhouse`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tile-del', { timeout: 10000 });
  await page.evaluate(() => { document.querySelectorAll('#toast-stack .toast').forEach(t => t.remove()); });
  // Force-show the delete X by adding inline style override
  await page.addStyleTag({ content: '.tile-del { display: flex !important; }' });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '41-clubhouse-delete-x.png'), fullPage: false });
  console.log('1. Clubhouse with delete X visible');

  // Scorecard — show several shapes by playing through holes
  // Create a fresh game to use
  const t = await (await fetch(`${BASE}/api/tournaments`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Shapes Demo', type: 'casual', course_id: courses[0].id, format: 'stroke_net' }) })).json();
  await fetch(`${BASE}/api/tournaments/${t.id}/field`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Demo Player', handicap_index: 0 }) });
  await fetch(`${BASE}/api/rounds/${t.round_id}/status`, { method: 'POST', headers: H,
    body: JSON.stringify({ status: 'active' }) });

  // Score 5 holes with each shape: eagle, birdie, par, bogey, double
  const rd = await (await fetch(`${BASE}/api/rounds/${t.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  const entryId = rd.entries[0].id;
  // Pull hole layout from the course's first tee
  const tee = rd.course?.tees?.[0];
  const holes = (tee?.holes || Array.from({length:18}, (_, i) => ({ hole_number: i+1, par: 4 }))).slice(0, 5);
  // For each, post a score with a specific diff
  const diffs = [-2, -1, 0, +1, +2];
  const batch = holes.map((h, i) => ({ entry_id: entryId, hole_number: h.hole_number, strokes: h.par + diffs[i] }));
  await fetch(`${BASE}/api/rounds/${t.round_id}/scores`, { method: 'POST', headers: H,
    body: JSON.stringify({ scores: batch, entered_by: 'demo' }) });

  // Now drive the scorecard UI and screenshot each hole
  await page.setViewport({ width: 600, height: 900 });
  for (let i = 0; i < 5; i++) {
    const h = holes[i];
    await page.goto(`${BASE}/scorecard/${t.round_id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stepper .val', { timeout: 10000 });
    // Click into hole i+1 via the dot navigation
    await page.evaluate((n) => {
      const dots = document.querySelectorAll('[data-h]');
      const d = Array.from(dots).find(d => +d.dataset.h === n);
      if (d) d.click();
    }, h.hole_number);
    await new Promise(r => setTimeout(r, 200));
    const labels = ['eagle','birdie','par','bogey','double'];
    await page.screenshot({ path: path.join(SHOTS, `42-shape-${i+1}-${labels[i]}.png`) });
    console.log(`${i+2}. ${labels[i]} on hole ${h.hole_number}`);
  }

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
