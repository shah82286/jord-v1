/**
 * Capture the new landing page at desktop + mobile widths.
 * Run: node scripts/capture-landing-preview.js
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'public', 'img', 'screenshots');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Desktop
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    await page.screenshot({ path: path.join(OUT, 'preview-landing-desktop.png'), fullPage: true });
    console.log('Desktop saved');
    await page.close();
  }

  // Mobile
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    await page.screenshot({ path: path.join(OUT, 'preview-landing-mobile.png'), fullPage: true });
    console.log('Mobile saved');
    await page.close();
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
