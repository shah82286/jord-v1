// PHASE-2 — visual capture: branded player pages + admin Settings branding section.
const puppeteer = require('puppeteer');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = 'tests/screenshots';

// A visible SVG logo so the branded topbar is obvious in screenshots.
const SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='40'><rect width='180' height='40' rx='6' fill='#1E7A46'/><text x='14' y='27' fill='#fff' font-family='Arial' font-weight='700' font-size='18'>ACME GOLF</text></svg>";
const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(SVG).toString('base64');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // Set up a branded event via API
  const su = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'shah82286@gmail.com', password: 'jord2026' }) })).json();
  const H = { 'Content-Type': 'application/json', 'x-admin-token': su.token };
  const now = new Date().toISOString().slice(0, 16);
  const ev = await (await fetch(BASE + '/api/events', { method: 'POST', headers: H, body: JSON.stringify({ name: 'ACME Charity Classic', venue: 'Acme National', starts_at: now, ends_at: now, has_longest_drive: 1, has_closest_pin: 1 }) })).json();
  await fetch(BASE + '/api/events/' + ev.id, { method: 'PATCH', headers: H, body: JSON.stringify({ brand_enabled: 1, brand_accent: '#1E7A46', brand_logo: LOGO }) });
  console.log('branded event', ev.id);

  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    // 1) Register page — mobile 375px (branded topbar logo + accent + footer)
    const m = await browser.newPage();
    await m.setViewport({ width: 375, height: 800 });
    await m.goto(BASE + '/register/' + ev.id, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await m.screenshot({ path: OUT + '/phase2-register-mobile.png', fullPage: true });
    console.log('shot: register (mobile)');

    // 2) Leaderboard — desktop (footer reworded "Powered by JORD Golf")
    const lb = await browser.newPage();
    await lb.setViewport({ width: 1200, height: 800 });
    await lb.goto(BASE + '/leaderboard/' + ev.id, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
    await lb.screenshot({ path: OUT + '/phase2-leaderboard.png' });
    console.log('shot: leaderboard');

    // 3) Admin Settings tab — inject token, open the event editor, scroll to Branding
    const a = await browser.newPage();
    await a.setViewport({ width: 1100, height: 1000 });
    await a.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_admin_token', tok); }, su.token);
    await a.goto(BASE + '/admin/events/' + ev.id, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
    // Scroll the Branding heading into view if present
    await a.evaluate(() => {
      const h = [...document.querySelectorAll('h4')].find(x => /Branding/i.test(x.textContent));
      if (h) h.scrollIntoView({ block: 'center' });
    });
    await new Promise(r => setTimeout(r, 300));
    await a.screenshot({ path: OUT + '/phase2-admin-settings.png', fullPage: true });
    const hasBranding = await a.evaluate(() => !!document.getElementById('brand-logo-preview') && !!document.getElementById('brand-accent'));
    console.log('shot: admin settings — branding controls present:', hasBranding);

    // 4) Scan page (demo mode) — mobile, branded topbar + footer
    const s = await browser.newPage();
    await s.setViewport({ width: 375, height: 800 });
    await s.goto(BASE + '/scan/DEMO?demo=1&eventId=' + ev.id, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1200));
    await s.screenshot({ path: OUT + '/phase2-scan-mobile.png', fullPage: true });
    console.log('shot: scan demo (mobile)');

    // cleanup
    await fetch(BASE + '/api/events/' + ev.id, { method: 'DELETE', headers: H });
    console.log('\nScreenshots written to ' + OUT + '/phase2-*.png');
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
