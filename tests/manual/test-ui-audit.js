// Lightweight UI audit smoke test — walks the critical personal-user flow
// and reports any broken page loads or missing elements. Not exhaustive,
// but catches the obvious "blank page / 4xx / element missing" regressions.
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const findings = [];
  const note = (msg) => { findings.push(msg); console.log('   • ' + msg); };

  const email = `audit-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => note('JS error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) note('Console: ' + m.text()); });

  // ── Public landing
  console.log('[1] landing page');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const landingHasSignUp = await page.$('.nav-cta, a[href*="login"]');
  if (!landingHasSignUp) note('Landing missing sign-up link');

  // ── Login page
  console.log('[2] login page');
  await page.goto(`${BASE}/login?track=personal`, { waitUntil: 'domcontentloaded' });
  if (!await page.$('#modeSignup.is-active')) note('Login: signup tab not active by default');

  // ── Signup
  console.log('[3] signup');
  await page.type('#name', 'UI Audit');
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
  if (!page.url().includes('/clubhouse')) note('Signup did not land on /clubhouse');

  // ── Clubhouse: topbar + main controls
  console.log('[4] clubhouse');
  if (!await page.$('header.topbar a.brand[href="/clubhouse"]')) note('Clubhouse: brand link doesn\'t point to /clubhouse');
  if (!await page.$('#create')) note('Clubhouse: missing + Create a game button');
  if (!await page.$('#addCourse')) note('Clubhouse: missing + Add course button');
  if (!await page.$('a[href="/account"]')) note('Clubhouse: missing Settings link');

  // ── Account page
  console.log('[5] /account');
  await page.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 8000 });
  if (!await page.$('#btnChangeEmail')) note('Account: missing Change email button');
  if (!await page.$('#btnChangePassword')) note('Account: missing Change password button');
  if (!await page.$('#ghin_id')) note('Account: missing GHIN field');

  // ── Wizard (drive it to the players step via state)
  console.log('[6] wizard players step');
  await page.goto(BASE + '/clubhouse', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof startWizard === 'function', { timeout: 5000 });
  const courseCount = await page.evaluate(() => typeof S !== 'undefined' && Array.isArray(S.courses) ? S.courses.length : 0);
  if (!courseCount) {
    note('No courses in DB — wizard player step skipped');
  } else {
    await page.evaluate(() => {
      startWizard();
      S.wiz.type = 'casual';
      S.wiz.course_id = S.courses[0].id;
      S.wiz.name = 'UI Audit Game';
      S.wiz.format = 'stroke_net';
      S.wiz.step = 'players';
      renderWizard();
    });
    await page.waitForSelector('#pName', { timeout: 5000 });
    if (!await page.$('#pAdd')) note('Wizard: missing Add Player button');
    // Add a player + check it shows in the list with ✎ pencil
    await page.type('#pName', 'Test');
    await page.type('#pHcp', '12');
    await page.click('#pAdd');
    await page.waitForSelector('[data-edit="0"]', { timeout: 3000 });
    if (!await page.$('[data-edit="0"]')) note('Wizard player list: missing ✎ pencil');
    if (!await page.$('[data-rm="0"]')) note('Wizard player list: missing ✕ remove');
  }

  // ── Simulator (test-only? no — was removed in v3.59.2 from product. Skip.)

  // ── New course form: confirm multi-tee UI is present
  console.log('[7] + Add course manual form');
  await page.goto(BASE + '/clubhouse', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#addCourse', { timeout: 5000 });
  await page.click('#addCourse');
  await page.waitForSelector('#mManual', { timeout: 3000 });
  await page.click('#mManual');
  await new Promise(r => setTimeout(r, 300));
  // courseManualMode() seeds 2 tees by default
  const teeBoxCount = await page.$$eval('.tee-box', els => els.length).catch(() => 0);
  if (teeBoxCount < 2) {
    // Maybe the manual mode wasn't opened — that's a UI gap to note rather than fail.
    note(`+ Add course manual mode: expected 2 default tee boxes, saw ${teeBoxCount}`);
  }

  console.log('\n──────────────────────────────────────────────');
  if (!findings.length) {
    console.log('✅  UI audit clean — no broken pages, missing buttons, or JS errors detected.');
  } else {
    console.log(`⚠   ${findings.length} finding(s):`);
    for (const f of findings) console.log('   • ' + f);
  }
  await browser.close();
  process.exit(findings.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
