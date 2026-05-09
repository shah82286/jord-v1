/**
 * Capture screenshots of the actual JORD Golf experience using Puppeteer.
 * Saves PNGs to public/img/screenshots/.
 *
 * Run: node scripts/capture-screenshots.js
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const EID = 'EVTBEA9495F';
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'public', 'img', 'screenshots');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, type: 'png', ...opts });
  console.log(`  ✓ ${name}.png`);
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function login(page) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });
  await wait(1500);
  await page.type('#login-email', 'shah82286@gmail.com');
  await page.type('#login-pwd', 'jord2026');
  await page.click('#btn-login');
  await wait(3000);
}

(async () => {
  console.log('Launching browser…');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  });

  // ─── 1. Live Leaderboard (hero) ──────────────────────────────────────
  {
    console.log('Capturing leaderboard-hero.png …');
    const page = await browser.newPage();
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(4000);
    await shot(page, 'leaderboard-hero');
    await page.close();
  }

  // ─── 2. Live Leaderboard with map open ───────────────────────────────
  {
    console.log('Capturing leaderboard-map.png …');
    const page = await browser.newPage();
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(3500);
    // Click the Map toggle to expand the map
    try {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')].find(b => /map/i.test(b.textContent || '') && !/google/i.test(b.textContent));
        if (btn) btn.click();
      });
      await wait(3000);
    } catch {}
    await shot(page, 'leaderboard-map');
    await page.close();
  }

  // ─── 3. Standard leaderboard screenshot ──────────────────────────────
  {
    console.log('Capturing leaderboard.png …');
    const page = await browser.newPage();
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(4000);
    await shot(page, 'leaderboard');
    await page.close();
  }

  // ─── 4. End-of-tournament view ───────────────────────────────────────
  {
    console.log('Capturing end-of-tournament.png …');
    const Database = require('better-sqlite3');
    const db = new Database('./data/jord.db');
    const original = db.prepare('SELECT status FROM events WHERE id = ?').get(EID).status;
    db.prepare('UPDATE events SET status = ? WHERE id = ?').run('ended', EID);

    const page = await browser.newPage();
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(4500);
    await shot(page, 'end-of-tournament');
    await page.close();

    db.prepare('UPDATE events SET status = ? WHERE id = ?').run(original, EID);
    db.close();
  }

  // ─── 5. Course Map (admin) — login + click into event + map tab ──────
  {
    console.log('Capturing course-map.png …');
    const page = await browser.newPage();
    await login(page);

    // Click the event card for Bryce Charity Classic (find by venue text match)
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.event-card')];
      const target = cards.find(c => /bryce|meramec/i.test(c.textContent || ''));
      if (target) target.click();
    });
    await wait(2500);

    // Click the "Course Map" nav item
    await page.evaluate(() => {
      const navItems = [...document.querySelectorAll('.editor-nav .nav-item, [data-panel]')];
      const mapNav = navItems.find(n =>
        n.dataset.panel === 'map' || /course\s*map|map/i.test(n.textContent || '')
      );
      if (mapNav) mapNav.click();
    });
    await wait(5500); // map needs time to render WebGL + tiles
    await shot(page, 'course-map');
    await page.close();
  }

  // ─── 6. Mobile leaderboard ───────────────────────────────────────────
  {
    console.log('Capturing leaderboard-mobile.png …');
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(4000);
    await shot(page, 'leaderboard-mobile');
    await page.close();
  }

  // ─── 7. Mobile scan page ─────────────────────────────────────────────
  {
    console.log('Capturing scan-otp.png …');
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(1500);
    await shot(page, 'scan-otp');
    await page.close();
  }

  // ─── 8. Monitor dashboard (admin) ────────────────────────────────────
  {
    console.log('Capturing monitor.png …');
    const page = await browser.newPage();
    // Monitor uses localStorage password — set it before navigating
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.setItem('jord_admin_pwd', 'jord2026'));
    await page.goto(`${BASE}/monitor/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(5000);
    await shot(page, 'monitor');
    await page.close();
  }

  // ─── 9. Landing page ─────────────────────────────────────────────────
  {
    console.log('Capturing landing.png …');
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(2500);
    await shot(page, 'landing');
    await page.close();
  }

  await browser.close();
  console.log('\nDone. Screenshots saved to public/img/screenshots/');
})().catch(err => {
  console.error('Capture failed:', err);
  process.exit(1);
});
