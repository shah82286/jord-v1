// Capture screenshots of the new /clubhouse topbar + /account page for review.
// Outputs to tests/screenshots/.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const email = `shot-${Date.now()}@example.com`;
const password = 'TestPass1234';

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: false });

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();

  // Sign up a fresh user
  await page.goto(`${BASE}/login?track=personal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#modeSignup.is-active');
  await page.type('#name', 'Screenshot User');
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
  await page.waitForSelector('.topbar', { timeout: 10000 });
  // Force-dismiss any toasts so the topbar buttons aren't covered
  await page.evaluate(() => { document.querySelectorAll('#toast-stack .toast, .toast').forEach(t => t.remove()); });
  await new Promise(r => setTimeout(r, 300));
  await shot(page, '01-clubhouse-topbar.png');
  console.log('1. clubhouse with Settings + Log out');

  // Crop just the topbar for a tight close-up — clip to topbar bounds
  const topbarBox = await page.$eval('.topbar', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: path.join(SHOTS, '02-clubhouse-topbar-tight.png'), clip: topbarBox });

  // /account top
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 10000 });
  await shot(page, '03-account-top.png');
  console.log('2. /account top (Profile + start of Address)');

  // Scroll to middle (Address + Golf)
  await page.evaluate(() => window.scrollTo(0, 600));
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '04-account-middle-address-golf.png');
  console.log('3. /account middle (Address + Golf)');

  // Scroll further (Golf details + Notifications + Save bar)
  await page.evaluate(() => window.scrollTo(0, 1300));
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '05-account-golf-notifications.png');
  console.log('4. /account Golf + Notifications + Save bar');

  // Bottom (Password section + save bar)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '06-account-bottom-save-bar.png');
  console.log('5. /account bottom with sticky Save bar');

  // Change-email modal
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#btnChangeEmail');
  await page.waitForSelector('#ce_pw');
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '07-modal-change-email.png');
  console.log('6. Change-email modal');

  // Dismiss, then open change-password modal
  await page.click('.modal-footer .btn-ghost');
  await new Promise(r => setTimeout(r, 300));
  await page.click('#btnChangePassword');
  await page.waitForSelector('#cp_cur');
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '08-modal-change-password.png');
  console.log('7. Change-password modal');

  // Mobile view
  await page.setViewport({ width: 390, height: 844 });
  await page.click('.modal-footer .btn-ghost').catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSave', { timeout: 10000 });
  await shot(page, '09-account-mobile-top.png');
  console.log('8. /account mobile top');

  await page.evaluate(() => window.scrollTo(0, 600));
  await new Promise(r => setTimeout(r, 200));
  await shot(page, '10-account-mobile-mid.png');
  console.log('9. /account mobile mid');

  // Mobile clubhouse topbar
  await page.goto(`${BASE}/clubhouse`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar');
  await page.evaluate(() => { document.querySelectorAll('#toast-stack .toast, .toast').forEach(t => t.remove()); });
  await new Promise(r => setTimeout(r, 300));
  await shot(page, '11-clubhouse-mobile-topbar.png');
  console.log('10. /clubhouse mobile topbar');

  await browser.close();
  console.log('\nDONE — screenshots in tests/screenshots/');
})().catch(e => { console.error(e); process.exit(1); });
