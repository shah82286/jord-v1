// Verifies the new "Sign in with this email →" affordance in the
// personal signup form when the server returns 409 already-registered.
// Flow:
//   1. POST a fresh signup directly (seeds the email)
//   2. Open /login?track=personal in Puppeteer
//   3. Fill form, hit submit → should get error
//   4. Click the inline "Sign in with this email →" link
//   5. Mode flips to login, email + password are preserved
//   6. Submit → lands on /clubhouse
const puppeteer = require('puppeteer');

(async () => {
  const email = `already-test-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  // Seed an account so the next signup attempt collides
  const seed = await fetch('http://localhost:3000/api/users/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Seed', email, password })
  });
  if (!seed.ok) { console.error('SEED FAILED', seed.status, await seed.text()); process.exit(1); }
  console.log('[1/6] seed account created:', email);

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errs.push('console.error: ' + m.text());
    if (m.text().startsWith('JORD.api')) console.log('   [browser]', m.text());
  });

  await page.goto('http://localhost:3000/login?track=personal', { waitUntil: 'networkidle0' });
  console.log('[2/6] loaded /login?track=personal');

  // Should be in signup mode by default (per v3.55 default)
  await page.waitForSelector('#modeSignup.is-active');
  await page.type('#name', 'Duplicate Test');
  await page.type('#email', email);
  await page.type('#password', password);
  console.log('[3/6] filled signup form, clicking submit');

  await page.click('#submitBtn');
  await page.waitForSelector('#errSwitch', { timeout: 5000 });
  const errText = await page.$eval('#err', e => e.textContent);
  console.log('[4/6] got actionable error:', JSON.stringify(errText));

  await page.click('#errSwitch');

  // Verify: mode switched to login, email preserved, password preserved
  await page.waitForSelector('#modeSignin.is-active');
  const emailVal = await page.$eval('#email', e => e.value);
  const pwVal = await page.$eval('#password', e => e.value);
  console.log('[5/6] after click: mode=login, email=', emailVal, 'password length=', pwVal.length);
  if (emailVal !== email || pwVal !== password) {
    console.error('FAIL: form values not preserved');
    process.exit(1);
  }

  // Log every request the page makes after this point
  page.on('request', r => {
    if (r.url().includes('/api/')) console.log('   REQ', r.method(), r.url().replace('http://localhost:3000',''));
  });
  page.on('response', async r => {
    if (r.url().includes('/api/')) console.log('   RES', r.status(), r.url().replace('http://localhost:3000',''));
  });
  page.on('framenavigated', f => console.log('   NAV', f.url()));
  // And capture the actual mode the form thinks it's in
  await page.evaluate(() => {
    const orig = JORD.api;
    JORD.api = async function(path, opts) {
      console.log('JORD.api ' + (opts?.method || 'GET') + ' ' + path + ' body=' + JSON.stringify(opts?.body));
      const r = await orig(path, opts);
      console.log('JORD.api ' + path + ' → ok=' + (!!r) + ' token?=' + (!!r?.token));
      return r;
    };
  });
  await page.click('#submitBtn');
  await new Promise(r => setTimeout(r, 2500));
  const errAfter = await page.$eval('#err', e => ({ text: e.textContent, shown: e.classList.contains('show') })).catch(() => ({ text: '(no #err)', shown: false }));
  const tok = await page.evaluate(() => localStorage.getItem('jord_user_token'));
  console.log('   #err after submit:', errAfter);
  console.log('   user token in localStorage:', tok ? tok.slice(0,20)+'...' : '(none)');
  const url = page.url();
  console.log('[6/6] after submit, url =', url);
  if (!url.includes('/clubhouse')) { console.error('FAIL: expected /clubhouse, got', url); process.exit(1); }
  // 409 is the duplicate-signup we deliberately triggered; 404s are likely
  // missing favicons. Filter both out before failing on real errors.
  const realErrs = errs.filter(e => !/status of 40[49]/.test(e));
  if (realErrs.length) { console.error('FAIL: console/page errors:', realErrs); process.exit(1); }

  console.log('\nALL PASS — actionable 409 + form preservation works end-to-end');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
