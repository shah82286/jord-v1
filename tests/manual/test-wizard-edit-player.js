// Smoke test for the v3.64.2 wizard player-edit flow:
//  1. Drive the wizard to the Players step (individual stroke-net format)
//  2. Add a player "Alice" with HCP 12
//  3. Click the new ✎ pencil → the form pre-fills, button text changes
//  4. Edit name → "Alice Renamed", HCP → 8
//  5. Save → list row updates
//  6. Click ✎ again → confirm new values pre-fill
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `wize-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Wizard Edit', email, password }),
  })).json();
  // Need a course to reach the players step
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  if (!courses.length) throw new Error('no courses in DB');
  console.log('[1] signed up + have course');

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 900, height: 1100 } });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);

  // Drive the wizard via state-injection (shortcut past the type/course steps)
  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/clubhouse`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof startWizard === 'function', { timeout: 5000 });
  const probe = await page.evaluate(() => ({
    hasS: typeof S !== 'undefined',
    hasStart: typeof startWizard === 'function',
    hasRender: typeof renderWizard === 'function',
    courses: typeof S !== 'undefined' && Array.isArray(S.courses) ? S.courses.length : 'n/a',
  }));
  console.log('   probe:', probe);
  await page.evaluate((courseId) => {
    startWizard();
    S.wiz.type = 'casual';
    S.wiz.course_id = courseId;
    S.wiz.name = 'Edit Test Game';
    S.wiz.format = 'stroke_net';
    S.wiz.step = 'players';
    renderWizard();
  }, courses[0].id);
  await page.waitForSelector('#pName', { timeout: 5000 });
  console.log('[2] at Players step');

  // Add Alice with HCP 12
  await page.type('#pName', 'Alice');
  await page.type('#pHcp', '12');
  await page.click('#pAdd');
  await page.waitForSelector('[data-edit="0"]', { timeout: 5000 });
  let listText = await page.$eval('#pList', el => el.textContent);
  if (!listText.includes('Alice') || !listText.includes('12')) throw new Error('Alice not in list: ' + listText);
  console.log('[3] Alice added');

  // Click ✎ → form should pre-fill
  await page.click('[data-edit="0"]');
  await new Promise(r => setTimeout(r, 200));
  const prefilled = await page.evaluate(() => ({
    name: document.querySelector('#pName').value,
    hcp:  document.querySelector('#pHcp').value,
    addBtnText: document.querySelector('#pAdd').textContent,
    hasCancel: !!document.querySelector('#pCancel'),
  }));
  console.log('[4] edit form pre-filled:', prefilled);
  if (prefilled.name !== 'Alice') throw new Error('name not pre-filled');
  if (prefilled.hcp !== '12') throw new Error('hcp not pre-filled');
  if (!/Save/i.test(prefilled.addBtnText)) throw new Error('button text did not change to Save');
  if (!prefilled.hasCancel) throw new Error('Cancel button missing');

  // Edit name + HCP, save
  await page.$eval('#pName', el => { el.value = ''; });
  await page.type('#pName', 'Alice Renamed');
  await page.$eval('#pHcp', el => { el.value = ''; });
  await page.type('#pHcp', '8');
  await page.click('#pAdd');
  await new Promise(r => setTimeout(r, 200));
  listText = await page.$eval('#pList', el => el.textContent);
  if (!listText.includes('Alice Renamed') || !listText.includes('8')) {
    throw new Error('edits did not save to list: ' + listText);
  }
  // Form should reset
  const afterSave = await page.evaluate(() => ({
    name: document.querySelector('#pName').value,
    addBtnText: document.querySelector('#pAdd').textContent,
  }));
  if (afterSave.name) throw new Error('name field did not clear after save');
  if (!/Add/i.test(afterSave.addBtnText)) throw new Error('button did not revert to Add');
  console.log('[5] save persisted + form reset');

  // Re-click ✎ → confirm new values pre-fill (not stale ones)
  await page.click('[data-edit="0"]');
  await new Promise(r => setTimeout(r, 200));
  const second = await page.evaluate(() => ({
    name: document.querySelector('#pName').value,
    hcp:  document.querySelector('#pHcp').value,
  }));
  console.log('[6] re-edit pre-fills:', second);
  if (second.name !== 'Alice Renamed' || second.hcp !== '8') {
    throw new Error('re-edit shows stale data: ' + JSON.stringify(second));
  }

  // Cancel reverts cleanly
  await page.click('#pCancel');
  await new Promise(r => setTimeout(r, 150));
  const afterCancel = await page.evaluate(() => ({
    name: document.querySelector('#pName').value,
    addBtnText: document.querySelector('#pAdd').textContent,
  }));
  if (afterCancel.name) throw new Error('cancel did not clear name');
  if (!/Add/i.test(afterCancel.addBtnText)) throw new Error('cancel did not revert button');
  console.log('[7] cancel resets form');

  console.log('\nALL PASS — wizard player edit flow works (add → edit → save → re-edit → cancel)');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
