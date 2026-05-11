/**
 * Re-capture the in-page screenshots referenced by /about and /landing
 * (leaderboard.png, leaderboard-map.png, scan-otp.png, course-map.png,
 *  monitor.png, end-of-tournament.png) using the new cream editorial theme.
 *
 * Run: node scripts/capture-about-screenshots.js
 * Requires: dev server on localhost:3000 with event EVTBEA9495F accessible.
 *
 * Viewport choices:
 *   - Desktop pages: 1280 × variable, deviceScaleFactor 2 (matches /about max-width 1280)
 *   - Mobile pages:   390 × 844, deviceScaleFactor 2 (iPhone 14)
 *   - fullPage: true for content pages so nothing is clipped at the bottom
 *
 * For end-of-tournament.png, this script temporarily flips the event's status
 * to 'ended' via a direct DB write (bypassing /api/events/:id/end so no Klaviyo
 * notifications fire), captures the closing screen, then flips back to 'active'.
 */
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'public', 'img', 'screenshots');
const EID = 'EVTBEA9495F';
const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'data', 'jord.db');
const ADMIN_EMAIL = 'shah82286@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jord2026';

// Desktop / mobile viewports.  Width matches /about screen-frame max-width
// so the captured PNG fills the frame edge-to-edge without resampling artifacts.
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 2 };
const DESKTOP_TALL = { width: 1280, height: 1600, deviceScaleFactor: 2 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function setEventStatus(status) {
  const db = new Database(DB_PATH);
  try {
    db.prepare('UPDATE events SET status=? WHERE id=?').run(status, EID);
    const after = db.prepare('SELECT status FROM events WHERE id=?').get(EID);
    console.log(`  DB → event ${EID} status: ${after?.status}`);
  } finally {
    db.close();
  }
}

async function loginAsAdmin(page) {
  await page.waitForSelector('#login-email', { timeout: 10000 });
  await page.type('#login-email', ADMIN_EMAIL);
  await page.type('#login-pwd', ADMIN_PASSWORD);
  await page.click('#btn-login');
  // Wait for the gate to be dismissed.  Different pages use different IDs:
  //   admin.html        → #gate
  //   monitor.html      → #gate-section
  await page.waitForFunction(() => {
    const a = document.getElementById('gate');
    const b = document.getElementById('gate-section');
    const aGone = !a || a.style.display === 'none' || !a.offsetParent;
    const bGone = !b || b.style.display === 'none' || !b.offsetParent;
    return aGone && bGone;
  }, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // ─── 1. leaderboard.png (scores-only view) ────────────────────────
  {
    const page = await browser.newPage();
    await page.setViewport(DESKTOP);
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3500);
    await page.screenshot({ path: path.join(OUT, 'leaderboard.png'), fullPage: false });
    console.log('✓ leaderboard.png');
    await page.close();
  }

  // ─── 2. leaderboard-map.png (map toggled open, split view) ────────
  {
    const page = await browser.newPage();
    await page.setViewport(DESKTOP);
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);
    try {
      await page.click('#btn-map');
      await sleep(4500); // allow map tiles to load
    } catch (e) { console.warn('  ! Could not click map button:', e.message); }
    await page.screenshot({ path: path.join(OUT, 'leaderboard-map.png'), fullPage: false });
    console.log('✓ leaderboard-map.png');
    await page.close();
  }

  // ─── 3. scan-otp.png (mobile, OTP boxes lit) ──────────────────────
  {
    const page = await browser.newPage();
    await page.setViewport(MOBILE);
    await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    try {
      await page.keyboard.type('ABC');
      await sleep(800);
    } catch (e) {}
    await page.screenshot({ path: path.join(OUT, 'scan-otp.png'), fullPage: false });
    console.log('✓ scan-otp.png');
    await page.close();
  }

  // ─── 4. course-map.png (admin → event → Course Map tab) ───────────
  {
    const page = await browser.newPage();
    await page.setViewport(DESKTOP_TALL);
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
    try {
      await loginAsAdmin(page);
      await page.waitForSelector('.event-card', { timeout: 10000 });
      await page.click('.event-card');
      await sleep(2500);
      // Click "Course Map" nav item
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.editor-nav .nav-item'));
        const m = items.find(el => /course\s*map/i.test(el.textContent));
        if (m) m.click();
      });
      await sleep(5000); // wait for Mapbox tiles
      // Scroll to top so the editor header is in shot
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(500);
    } catch (e) {
      console.warn('  ! course-map step failed:', e.message);
    }
    await page.screenshot({ path: path.join(OUT, 'course-map.png'), fullPage: true });
    console.log('✓ course-map.png (fullPage)');
    await page.close();
  }

  // ─── 5. monitor.png (monitor page, logged in) ─────────────────────
  {
    const page = await browser.newPage();
    await page.setViewport(DESKTOP_TALL);
    await page.goto(`${BASE}/monitor/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
    try {
      const hasGate = await page.$('#login-email');
      if (hasGate) await loginAsAdmin(page);
      await sleep(5000); // wait for SSE snapshot + map tiles
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(500);
    } catch (e) {
      console.warn('  ! monitor step failed:', e.message);
    }
    await page.screenshot({ path: path.join(OUT, 'monitor.png'), fullPage: true });
    console.log('✓ monitor.png (fullPage)');
    await page.close();
  }

  // ─── 6. end-of-tournament.png — REAL ended view ───────────────────
  // Flip event to 'ended' via direct DB write (no Klaviyo / no ball mutations),
  // capture the closing screen with stats + champion showcase + hall of fame,
  // then flip back to 'active' in a finally block so we don't leave it broken.
  let restoredOk = false;
  try {
    console.log('  Flipping event to ended for capture…');
    setEventStatus('ended');
    const page = await browser.newPage();
    await page.setViewport(DESKTOP_TALL);
    await page.goto(`${BASE}/leaderboard/${EID}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(6000); // wait for SSE snap + hall-of-fame async fetch + map tiles
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, 'end-of-tournament.png'), fullPage: true });
    console.log('✓ end-of-tournament.png (real ended state, fullPage)');
    await page.close();
  } catch (e) {
    console.error('  ! end-of-tournament capture failed:', e.message);
  } finally {
    try {
      console.log('  Restoring event to active…');
      setEventStatus('active');
      restoredOk = true;
    } catch (e) {
      console.error('  !! CRITICAL: failed to restore event status — DB may be left as ended:', e.message);
    }
  }

  await browser.close();
  if (!restoredOk) {
    console.error('\n⚠️  Event status restore failed. Manually run:');
    console.error(`   sqlite3 data/jord.db "UPDATE events SET status='active' WHERE id='${EID}';"`);
    process.exit(2);
  }
  console.log('\nDone — screenshots written to', OUT);
})().catch(e => { console.error(e); process.exit(1); });
