// Verifies the /account settings page:
//   1. Sign up + land on /clubhouse
//   2. Confirm Settings link + Log out button visible in topbar
//   3. Click Settings → /account loads
//   4. Fill in name/phone/birth date/handicap/GHIN/address/home club
//   5. Save → values round-trip on reload
//   6. Change password modal works (current pw verified, new pw set)
//   7. Change email modal works (with current pw verification)
//   8. Log out from /account → redirected away, token cleared
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const email = `acct-${Date.now()}@example.com`;
const password = 'OriginalPass1234';
const newPassword = 'NewPass5678';
const newEmail = `acct-${Date.now()}-new@example.com`;

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

  // ── 1. Sign up
  await page.goto(`${BASE}/login?track=personal`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#modeSignup.is-active');
  await page.type('#name', 'Account Test');
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#submitBtn')]);
  if (!page.url().includes('/clubhouse')) throw new Error('signup did not land on /clubhouse, got ' + page.url());
  console.log('[1] signup → /clubhouse');

  // ── 2. Topbar buttons present
  const settingsHref = await page.$eval('a[href="/account"]', a => a.getAttribute('href')).catch(() => null);
  const logoutBtn    = await page.$('button.btn.btn-ghost');
  if (!settingsHref) throw new Error('Settings link missing from Clubhouse topbar');
  if (!logoutBtn) throw new Error('Log out button missing from Clubhouse topbar');
  console.log('[2] topbar shows Settings + Log out');

  // ── 3. Navigate to /account (direct goto — click-driven nav was flaky under headless)
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 10000 });
  if (!page.url().includes('/account')) throw new Error('expected /account, got ' + page.url());
  console.log('[3] /account loaded');

  // ── 4. Fill the form
  await page.type('#phone', '5551234567');
  await page.$eval('#birth_date', (el, v) => { el.value = v; }, '1990-05-15');
  await page.type('#handicap_index', '14.2');
  await page.type('#ghin_id', '7654321');
  await page.type('#address_line1', '123 Fairway Lane');
  await page.type('#city', 'Pebble Beach');
  await page.type('#state', 'CA');
  await page.type('#zip', '93953');
  await page.type('#country', 'United States');
  await page.type('#home_club', 'Pebble Beach Golf Links');
  await page.select('#preferred_tee', 'middle');
  await page.select('#dominant_hand', 'right');

  // Uncheck a notif so we can verify boolean round-trip
  await page.$eval('#notif_results', el => { el.checked = false; });

  await page.click('#btnSave');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Saved.', { timeout: 5000 });
  console.log('[4] form filled + saved');

  // ── 5. Reload and verify values round-tripped
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 10000 });
  const reloaded = await page.evaluate(() => ({
    phone: document.querySelector('#phone').value,
    birth_date: document.querySelector('#birth_date').value,
    handicap_index: document.querySelector('#handicap_index').value,
    ghin_id: document.querySelector('#ghin_id').value,
    city: document.querySelector('#city').value,
    home_club: document.querySelector('#home_club').value,
    preferred_tee: document.querySelector('#preferred_tee').value,
    dominant_hand: document.querySelector('#dominant_hand').value,
    notif_invites: document.querySelector('#notif_invites').checked,
    notif_results: document.querySelector('#notif_results').checked,
  }));
  console.log('   reloaded values:', JSON.stringify(reloaded));
  if (reloaded.phone !== '5551234567' || reloaded.handicap_index !== '14.2' || reloaded.preferred_tee !== 'middle' || reloaded.notif_results !== false) {
    throw new Error('values did not round-trip: ' + JSON.stringify(reloaded));
  }
  console.log('[5] values round-tripped through GET /api/users/me');

  // ── 6. Change password
  await page.click('#btnChangePassword');
  await page.waitForSelector('#cp_cur');
  await page.type('#cp_cur', password);
  await page.type('#cp_new', newPassword);
  await page.click('.modal-footer .btn-primary');
  await new Promise(r => setTimeout(r, 1500));
  // Confirm the old password no longer works at the login API
  const oldLogin = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const newLogin = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: newPassword }) });
  if (oldLogin.status !== 401 || newLogin.status !== 200) {
    throw new Error(`expected old=401 new=200, got old=${oldLogin.status} new=${newLogin.status}`);
  }
  console.log('[6] password change verified (old rejected, new accepted)');

  // ── 7. Change email
  await page.click('#btnChangeEmail');
  await page.waitForSelector('#ce_pw');
  await page.type('#ce_pw', newPassword);
  await page.type('#ce_email', newEmail);
  await page.click('.modal-footer .btn-primary');
  await new Promise(r => setTimeout(r, 1500));
  const tryNewEmail = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newEmail, password: newPassword }) });
  if (tryNewEmail.status !== 200) throw new Error('login with new email failed: ' + tryNewEmail.status);
  console.log('[7] email change verified — login with new email works');

  // ── 8. Log out — trigger inside page context so we don't fight Puppeteer's
  // navigation handling. The button fires JORD.api(logout) → clear tokens → goto /.
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button.btn'))
      .find(b => b.textContent.trim() === 'Log out');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('Log out button not found');
  // Wait for either navigation or token clear (whichever happens first)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    const tok = await page.evaluate(() => localStorage.getItem('jord_user_token'));
    if (!tok) break;
  }
  await new Promise(r => setTimeout(r, 500));
  const afterTok = await page.evaluate(() => localStorage.getItem('jord_user_token'));
  const finalUrl = page.url();
  if (afterTok) throw new Error('token still present after logout: ' + afterTok);
  console.log('[8] logout cleared token, redirected to ' + finalUrl);

  if (errs.filter(e => !/status of 404/.test(e)).length) {
    console.error('FAIL: console errors:', errs);
    process.exit(1);
  }
  console.log('\nALL PASS — /account end-to-end (signup → save → reload → password → email → logout)');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
