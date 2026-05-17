/**
 * Render public/og-card.html at exactly 1200×630 and save it as the
 * link-preview image used by Open Graph / Twitter cards.
 *
 * Needs the server running (npm start). Run: node scripts/capture-og-image.js
 * Output: public/img/og-cover.jpg
 */
const puppeteer = require('puppeteer');
const path = require('path');

const URL = (process.env.TEST_URL || 'http://localhost:3000') + '/og-card.html';
const OUT = path.join(__dirname, '..', 'public', 'img', 'og-cover.jpg');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  // Make sure web fonts + the background photo have painted before the shot.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({
    path: OUT, type: 'jpeg', quality: 90,
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });
  await browser.close();
  console.log('Saved link-preview image → public/img/og-cover.jpg');
})().catch(e => { console.error(e); process.exit(1); });
