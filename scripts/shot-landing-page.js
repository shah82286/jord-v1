// Captures the marketing landing page itself at desktop + mobile to verify
// the redesign renders correctly. Run after starting the dev server.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'tests', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('JS:', e.message));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'landing-desktop.png'), fullPage: true });
  console.log('📸 landing-desktop.png');

  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'landing-mobile.png'), fullPage: true });
  console.log('📸 landing-mobile.png');

  await browser.close();
})();
