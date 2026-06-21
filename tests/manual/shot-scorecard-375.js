// Capture the scorecard at iPhone-SE width (375px) so we can see what's
// cramped. Seeds a bestball game with 4 players (so we get the stepper +
// "YOU" pill + teammate stripe + strokes-given panel all visible at once).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${r.status}: ${body?.error || ''}`);
  return body;
}

(async () => {
  console.log('[seed] bestball game w/ 4 players + scores entered');
  const sup = await api('/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SC 375', email: `sc375-${Date.now()}@example.com`, password: 'TestPass1234' }),
  });
  const tok = sup.token;
  const H = { 'Content-Type': 'application/json', 'x-user-token': tok };
  const courses = await api('/api/courses', { headers: { 'x-user-token': tok } });

  const trn = await api('/api/tournaments', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Tight Phone Round', type: 'casual',
      course_id: courses[0].id, format: 'better_ball_stroke' }) });
  for (const p of [
    { name: 'Alex',  team_name: 'Team 1', handicap_index: 4 },
    { name: 'Bo',    team_name: 'Team 1', handicap_index: 18 },
    { name: 'Cam',   team_name: 'Team 2', handicap_index: 8 },
    { name: 'Drew',  team_name: 'Team 2', handicap_index: 22 },
  ]) {
    await api(`/api/tournaments/${trn.id}/field`, { method: 'POST', headers: H, body: JSON.stringify(p) });
  }
  await api(`/api/rounds/${trn.round_id}/status`, { method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }) });
  const rd = await api(`/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': tok } });

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEWPORT });
  const page = await browser.newPage();
  await page.emulate({ viewport: VIEWPORT, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/605.1.15' });
  // Pre-claim Alex as YOU so we see the YOU pill + teammate stripe
  await page.evaluateOnNewDocument((rid, eid) => {
    localStorage.setItem('jord_claim_' + rid, eid);
  }, trn.round_id, rd.entries[0].id);

  await page.goto(`${BASE}/scorecard/${trn.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.p-row', { timeout: 5000 });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'sc375-before.png'), fullPage: true });
  console.log('  📸 sc375-before.png');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
