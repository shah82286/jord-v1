// Pure-fresh signup flow: visit /login, hit chooser, pick "Play with friends",
// fill the form, submit, land on /clubhouse, stay there.
const puppeteer = require('puppeteer');

(async () => {
  const email = `fresh-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  page.on('response', r => { if (r.url().includes('/api/')) console.log('   RES', r.status(), r.url().replace('http://localhost:3000','')); });

  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle0' });
  console.log('[1] loaded /login (chooser expected)');

  // Pick the personal tile
  await page.waitForSelector('[data-track="personal"]');
  await page.click('[data-track="personal"]');
  await page.waitForSelector('#modeSignup.is-active');
  console.log('[2] picked personal tile, signup tab active');

  await page.type('#name', 'Fresh Test');
  await page.type('#email', email);
  await page.type('#password', password);
  console.log('[3] filled form');

  await page.click('#submitBtn');
  await new Promise(r => setTimeout(r, 2500));
  const url = page.url();
  const tok = await page.evaluate(() => localStorage.getItem('jord_user_token'));
  console.log('[4] final url=', url, ' tok=', tok ? tok.slice(0,16)+'...' : '(none)');

  if (!url.includes('/clubhouse')) { console.error('FAIL: expected /clubhouse'); process.exit(1); }
  if (!tok) { console.error('FAIL: token missing'); process.exit(1); }

  const realErrs = errs.filter(e => !/status of 404/.test(e));
  if (realErrs.length) { console.error('FAIL:', realErrs); process.exit(1); }

  console.log('\nFRESH SIGNUP PASS');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
