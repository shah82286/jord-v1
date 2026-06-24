// Captures the marketing-landing screenshots from the seeded demo event.
// Run AFTER `node scripts/seed-landing-demo.js` against the same server.
//
//   node scripts/shot-landing-screenshots.js [--port=3000] [--password=jord2026]
//
// Writes high-res desktop PNGs into public/img/landing/ so the landing
// page can reference them by relative URL.
'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PORT = (process.argv.find(a => a.startsWith('--port=')) || '--port=3000').split('=')[1];
const PW = (process.argv.find(a => a.startsWith('--password=')) || '--password=jord2026').split('=')[1];
const EMAIL = 'shah82286@gmail.com';
const BASE = `http://localhost:${PORT}`;
const SLUG = 'spring-charity-classic-2026';
const OUT = path.join(__dirname, '..', 'public', 'img', 'landing');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE  = { width: 390,  height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path_, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const sendBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  const r = await fetch(BASE + path_, { method, headers, body: sendBody ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${path_} → ${r.status}`);
  return data;
}

(async () => {
  // Find the demo event id by querying events
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PW });
  const tok = login.token;
  const evs = await api('GET', '/api/events', null, tok);
  const ev = evs.find(e => e.name === 'Spring Charity Classic 2026');
  if (!ev) { console.error('No demo event — run seed-landing-demo.js first.'); process.exit(1); }
  console.log('[ok] demo event id=' + ev.id);

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: DESKTOP });
  const page = await browser.newPage();

  // Pre-set admin token for the admin shots.
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('jord_admin_token', t); } catch {}
  }, tok);

  async function shotDesktop(url, name, opts = {}) {
    await page.emulate({ viewport: DESKTOP, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_0) AppleWebKit/605.1.15' });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(opts.wait || 1500);
    if (opts.scrollTo) await page.evaluate((s) => window.scrollTo(0, s), opts.scrollTo);
    if (opts.clip) await page.screenshot({ path: path.join(OUT, name + '.png'), clip: opts.clip });
    else           await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!opts.fullPage });
    console.log('  📸 desktop ' + name);
  }
  async function shotMobile(url, name, opts = {}) {
    await page.emulate({ viewport: MOBILE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(opts.wait || 1500);
    if (opts.scrollTo) await page.evaluate((s) => window.scrollTo(0, s), opts.scrollTo);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!opts.fullPage });
    console.log('  📸 mobile  ' + name);
  }

  // 1. Public event site — hero
  await shotDesktop('/e/' + SLUG, 'event-site-hero', { wait: 2000 });
  // 2. (skipped — full-page desktop scroll PNG was unused on the landing)
  // 3. Mobile public event site
  await shotMobile('/e/' + SLUG, 'event-site-mobile', { wait: 1500 });

  // 4. Admin event editor — Settings tab (full-page so screenshots see the form)
  await shotDesktop('/admin/events/' + ev.id, 'admin-event-editor', { wait: 2500 });

  // 5. Admin event editor — Site/Sponsorships
  await shotDesktop('/admin/events/' + ev.id + '/site/edit', 'admin-site-editor', { wait: 2500 });

  // 6. Pairings page
  await shotDesktop('/admin/events/' + ev.id + '/pairings', 'admin-pairings', { wait: 2500 });

  // 7. Pairings poster (desktop = real 24x36 scaled-down preview)
  await shotDesktop('/admin/events/' + ev.id + '/pairings/poster', 'pairings-poster', { wait: 3000 });

  // 8. Mobile pairings poster (the v3.79 readable view)
  await shotMobile('/admin/events/' + ev.id + '/pairings/poster', 'pairings-mobile', { wait: 2000 });

  // 9. Auction (public)
  await shotDesktop('/e/' + SLUG + '/auction', 'auction-public', { wait: 2000 });

  // 10. Help escalations (super admin) — to show the AI agent in the lineup
  await shotDesktop('/admin/help-escalations', 'help-escalations', { wait: 1500 });

  await browser.close();
  console.log('\nAll captures in: ' + OUT);
  process.exit(0);
})().catch(e => { console.error('SHOT FAILED:', e.message); process.exit(1); });
