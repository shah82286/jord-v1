/**
 * Capture preview screenshots of all marketing + player-facing pages
 * at desktop and mobile sizes.
 * Run: node scripts/capture-preview-all.js
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'public', 'img', 'screenshots');
const EID = 'EVTBEA9495F';
const BASE = 'http://localhost:3000';

const PAGES = [
  { route: '/',        name: 'preview-landing' },
  { route: '/about',   name: 'preview-about' },
  { route: '/signup',  name: 'preview-signup' },
  { route: `/leaderboard/${EID}`, name: 'preview-leaderboard' },
  { route: '/scan',    name: 'preview-scan' },
  { route: `/register/${EID}`, name: 'preview-register' },
];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const p of PAGES) {
    // Desktop
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
      await page.goto(BASE + p.route, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      await page.screenshot({ path: path.join(OUT, p.name + '-desktop.png'), fullPage: true });
      console.log(`✓ ${p.name}-desktop`);
      await page.close();
    }
    // Mobile
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
      await page.goto(BASE + p.route, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      await page.screenshot({ path: path.join(OUT, p.name + '-mobile.png'), fullPage: true });
      console.log(`✓ ${p.name}-mobile`);
      await page.close();
    }
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
