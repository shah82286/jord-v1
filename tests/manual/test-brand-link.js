// Verifies the topbar brand link auto-resolves to /clubhouse for signed-in
// personal users (was hard-coded to / before v3.59.3).
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `brand-${Date.now()}@example.com`;
  const password = 'TestPass1234';

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // 1. Anonymous: brand should point to /
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const anonHref = await page.$eval('header.topbar a.brand', a => a.getAttribute('href'));
  console.log('[1] anonymous /login brand →', anonHref);
  if (anonHref !== '/') throw new Error('expected / for anonymous, got ' + anonHref);

  // 2. Sign up
  await page.goto(`${BASE}/login?track=personal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#modeSignup.is-active');
  await page.type('#name', 'Brand Test');
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
  if (!page.url().includes('/clubhouse')) throw new Error('signup did not land on /clubhouse');

  // 3. Signed-in user on /clubhouse — brand should point to /clubhouse
  const clubHref = await page.$eval('header.topbar a.brand', a => a.getAttribute('href'));
  console.log('[2] signed-in /clubhouse brand →', clubHref);
  if (clubHref !== '/clubhouse') throw new Error('expected /clubhouse, got ' + clubHref);

  // 4. Same user on /account — brand should also point to /clubhouse
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 10000 });
  const acctHref = await page.$eval('header.topbar a.brand', a => a.getAttribute('href'));
  console.log('[3] signed-in /account brand →', acctHref);
  if (acctHref !== '/clubhouse') throw new Error('expected /clubhouse, got ' + acctHref);

  console.log('\nALL PASS — brand link auto-resolves correctly');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
