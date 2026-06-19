// Mobile-viewport screenshot tour at iPhone 12-ish size (390x844).
// Covers the screens the recent changes touched, so we can eyeball mobile UX:
//   1. Clubhouse landing
//   2. Wizard format settings (Skins with new toggles)
//   3. Tournament detail page (with Edit Game / Clone / Reset buttons)
//   4. Edit Game modal opened (showing the new format-settings panel)
//   5. Share-link landing (with new "Find your name" picker)
//   6. Scorecard (with YOU + teammate highlight)
//   7. Live leaderboard (with bestball team grid)
// Each step writes a PNG into tests/screenshots/mobile-*.png and logs any
// console errors. Run while `node server.js` is up on port 3000.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function api(path_, opts = {}) {
  const r = await fetch(BASE + path_, opts);
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path_} → ${r.status}`);
  return r.json();
}

(async () => {
  const findings = [];
  const note = (msg) => { findings.push(msg); console.log('   ⚠ ' + msg); };

  // ─── Seed: a tournament with players + scores so we have stuff to screenshot
  console.log('[seed] creating mobile-tour tournament');
  const email = `mtour-${Date.now()}@example.com`;
  const sup = await api('/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile Tour', email, password: 'TestPass1234' }),
  });
  const tok = sup.token;
  const H = { 'Content-Type': 'application/json', 'x-user-token': tok };
  const courses = await api('/api/courses', { headers: { 'x-user-token': tok } });

  // 2-team best ball stroke so the scorecard + live leaderboard both have
  // interesting data (team aggregation + per-member highlighting).
  const trn = await api('/api/tournaments', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Mobile Tour BB', type: 'casual',
      course_id: courses[0].id, format: 'better_ball_stroke' }),
  });
  for (const p of [
    { name: 'Alex',  team_name: 'Team 1', handicap_index: 4 },
    { name: 'Bo',    team_name: 'Team 1', handicap_index: 12 },
    { name: 'Cam',   team_name: 'Team 2', handicap_index: 8 },
    { name: 'Drew',  team_name: 'Team 2', handicap_index: 18 },
  ]) {
    await api(`/api/tournaments/${trn.id}/field`, { method: 'POST', headers: H, body: JSON.stringify(p) });
  }
  await api(`/api/rounds/${trn.round_id}/status`, { method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }) });
  const rd = await api(`/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': tok } });
  const scores = [];
  for (const e of rd.entries) {
    for (let h = 1; h <= 9; h++) scores.push({ entry_id: e.id, hole_number: h, strokes: 4 + (h % 3) });
  }
  await api(`/api/rounds/${trn.round_id}/scores`, { method: 'POST', headers: H, body: JSON.stringify({ scores, entered_by: 'tour' }) });
  // Also need the public-route share code for the share-link tour
  const trnPub = await api(`/api/tournaments/${trn.id}`, { headers: { 'x-user-token': tok } });

  // Skins tournament for the wizard-settings shot
  const trnSkins = await api('/api/tournaments', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Mobile Tour Skins', type: 'casual',
      course_id: courses[0].id, format: 'skins',
      format_settings: { value_per_skin: 5, allow_handicaps: true, allow_carryover: true } }),
  });

  // ─── Browser
  console.log('[browser] launching');
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEWPORT });
  const page = await browser.newPage();
  await page.emulate({ viewport: VIEWPORT, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/605.1.15' });
  page.on('pageerror', e => note('JS error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) note('Console: ' + m.text()); });

  // Authenticate the page so it can land directly inside /clubhouse
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem('jord_user_token', t);
  }, tok);

  async function shot(name) {
    const file = path.join(OUT, `mobile-${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log('   📸 ' + file);
  }
  async function shotFull(name) {
    const file = path.join(OUT, `mobile-${name}-full.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('   📸 ' + file);
  }

  // 1. Clubhouse
  console.log('[1] /clubhouse');
  await page.goto(BASE + '/clubhouse', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));
  await shot('01-clubhouse');
  await shotFull('01-clubhouse-full');

  // 2. Wizard at format-settings step (skins with new toggles)
  console.log('[2] wizard skins settings');
  await page.evaluate(() => {
    startWizard();
    S.wiz.type = 'casual';
    S.wiz.course_id = S.courses[0].id;
    S.wiz.name = 'Mobile Skins';
    S.wiz.format = 'skins';
    S.wiz.format_settings = { value_per_skin: 5, allow_handicaps: true, allow_carryover: true };
    S.wiz.step = 'setup';
    renderWizard();
  });
  await new Promise(r => setTimeout(r, 400));
  await shotFull('02-wizard-skins-settings');

  // 3. Tournament detail (with Edit Game / Clone / Reset buttons)
  console.log('[3] tournament detail');
  await page.goto(BASE + '/clubhouse#game/' + trnSkins.id, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  await shotFull('03-tournament-detail');

  // 4. Edit Game modal (showing format settings)
  console.log('[4] edit game modal');
  await page.click('#btn-edit');
  await new Promise(r => setTimeout(r, 500));
  await shotFull('04-edit-game-modal');

  // 5. Share-link landing (the new "find your name" dropdown)
  console.log('[5] share-link landing');
  // Sign-out for an authentic guest view
  await page.evaluate(() => { localStorage.removeItem('jord_user_token'); });
  await page.goto(BASE + '/round/' + trnPub.share_code, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));
  await shotFull('05-share-link-landing');

  // 6. Scorecard (YOU + teammates highlight)
  console.log('[6] scorecard');
  // Land on the bestball tournament's scorecard (different round id) and
  // pre-claim Alex as YOU via localStorage so the highlight shows.
  await page.evaluateOnNewDocument((rid, eid) => {
    localStorage.setItem('jord_claim_' + rid, eid);
  }, trn.round_id, rd.entries[0].id);
  await page.goto(BASE + '/scorecard/' + trn.round_id, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 700));
  await shotFull('06-scorecard-with-you');

  // 7. Live leaderboard
  console.log('[7] live leaderboard');
  await page.goto(BASE + '/live/' + trn.round_id, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));
  await shotFull('07-live-leaderboard');
  // Tap the team row to expand its drawer. The header .lb-row has no
  // data-toggle attribute — selector must skip it.
  const teamRow = await page.$('.lb-row[data-toggle]');
  if (teamRow) {
    await teamRow.click();
    await new Promise(r => setTimeout(r, 500));
    await shotFull('07b-live-team-drawer');
  } else {
    note('Live: no .lb-row[data-toggle] found to expand drawer');
  }

  console.log('\n──────────────────────────────────────────────');
  if (!findings.length) {
    console.log('✅  Mobile tour complete — no console/JS errors detected.');
  } else {
    console.log(`⚠   ${findings.length} runtime finding(s):`);
    for (const f of findings) console.log('   • ' + f);
  }
  console.log('\nScreenshots in: ' + OUT);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
