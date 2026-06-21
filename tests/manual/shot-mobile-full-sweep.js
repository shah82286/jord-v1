// v3.77 — Comprehensive mobile-viewport tour at 390×844 (iPhone 12-ish).
//
// Covers every surface touched since v3.71:
//   PERSONAL (user-token auth):
//     1. /clubhouse                — Active/Finished tabs (v3.74)
//     2. /clubhouse — wizard       — format settings panel
//     3. /clubhouse — game detail  — Edit / Clone / Reset buttons
//     4. /clubhouse — Edit Game    — modal scroll fix (v3.70) + edit settings (v3.69)
//     5. /clubhouse — course Edit  — course edit panel (v3.75)
//     6. /round/:shareCode         — Find your name picker (v3.68)
//     7. /scorecard/:roundId       — 375 px polish (v3.76)
//     8. /live/:roundId            — leaderboard
//     8b. /live drawer expanded    — best-ball team grid (v3.68)
//     9. /card/:roundId            — printable scorecard
//    10. /account                  — profile, GHIN, password change
//   ADMIN (admin-token auth, super admin):
//    20. /admin                    — event list + Help Escalations button (v3.77.1)
//    21. /admin/events/:id         — event editor Settings tab w/ help bubbles (v3.72)
//    22. /admin/events/:id         — Course Map tab
//    23. /admin/events/:id/site/edit  — sponsor logo upload (v3.73)
//    24. /admin/events/:id/pairings   — pairings UI
//    25. /admin/events/:id/pairings/poster  — sponsor strip (v3.76)
//    26. /admin/help-escalations   — AI help review (v3.77)
//    27. AI Help widget closed → open  — chat widget (v3.77)
//   PUBLIC:
//    30. /e/:slug                  — branded public event site

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = 3899;
const BASE = `http://localhost:${PORT}`;
const PW = 'fullsweep-pw';
const EMAIL = 'shah82286@gmail.com';
const OUT = path.join(__dirname, '..', 'screenshots', 'full-sweep');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, headers = {}) {
  const opt = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  const sendBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  if (sendBody) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + p, opt);
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${(data && data.error) || text.slice(0, 200)}`);
  return data;
}

(async () => {
  // ─── Sandbox server with super admin seeded by env
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jord-sweep-'));
  fs.writeFileSync(path.join(sandbox, '.env'),
    `PORT=${PORT}\nADMIN_PASSWORD=${PW}\nAPP_URL=${BASE}\nANTHROPIC_API_KEY=fake-no-real-calls\n`);

  // Stub the Anthropic SDK so the help-widget capture doesn't hit the
  // real API. Same trick as test-ai-help-agent.js.
  const REAL = path.join(PROJECT, 'lib', 'aiHelp.js');
  const BACKUP = path.join(PROJECT, 'lib', 'aiHelp.real.js.bak');
  const FAKE = `module.exports = {
    dailyTokenCap: () => 50000, MODEL: 'fake', looksStuck: () => false,
    async chat({ userMessage }) { return { reply: 'Sure! Try clicking the Settings tab on the left.', usage: {input:50,output:30,cache_creation:0,cache_read:0} }; },
  };`;
  fs.copyFileSync(REAL, BACKUP);
  fs.writeFileSync(REAL, FAKE);
  const restore = () => { try { fs.copyFileSync(BACKUP, REAL); fs.unlinkSync(BACKUP); } catch {} };
  process.on('exit', restore);

  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const shutdown = (code) => {
    try { server.kill(); } catch {}
    restore();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(130));

  try {
    // Wait for server
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      try { const r = await fetch(BASE + '/api/config'); if (r.ok) { ready = true; break; } } catch {}
    }
    if (!ready) { console.error('Server never came up.\n' + log); return shutdown(1); }
    console.log('[server] up on ' + BASE);

    // ─── Seed data
    console.log('[seed] super admin login + charity event + sponsorship + branding');
    const adminAuth = await api('POST', '/api/auth/login', { email: EMAIL, password: PW });
    const adminTok = adminAuth.token;
    const adminH = { 'x-admin-token': adminTok };

    const ev = await api('POST', '/api/events', {
      name: 'Spring Charity Classic', venue: 'Pebble Beach GL',
      starts_at: '2026-07-15T09:00', ends_at: '2026-07-15T18:00',
      has_longest_drive: true, has_closest_pin: true,
      brand_enabled: 1, brand_accent: '#A12C2C',
    }, adminH);

    // Set a slug + publish so the public /e/:slug page loads
    await api('PUT', `/api/admin/events/${ev.id}/site`, {
      slug: 'spring-charity-classic-2026', published: true,
      headline: 'Spring Charity Classic 2026',
      subhead: 'A round for a good cause — register now.',
    }, adminH).catch(e => console.log('  (site PUT failed, public page won\'t load: ' + e.message + ')'));

    // Add a sponsorship with a sample logo (1×1 PNG) so the public site + poster show it
    const SAMPLE_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    let sp = null;
    try {
      sp = await api('POST', `/api/admin/events/${ev.id}/packages`, {
        name: 'Hole 1 Sponsor', description: 'Branded tee marker + signage',
        price_cents: 25000, includes_players: 0,
        package_kind: 'sponsorship', sponsor_type: 'hole',
      }, adminH);
    } catch (e) { console.log('  (sponsor POST failed: ' + e.message + ')'); }
    if (sp && sp.id) {
      try { await api('PATCH', `/api/admin/events/${ev.id}/packages/${sp.id}`, { image_data: SAMPLE_LOGO }, adminH); }
      catch (e) { console.log('  (sponsor PATCH failed: ' + e.message + ')'); }
    }
    // Seed 2 pairing groups so the poster has actual content to render
    for (const g of [
      { name: 'Group 1', starting_hole: 1, tee_time: '08:00 AM', cart_numbers: '12, 13', sort_order: 0 },
      { name: 'Group 2', starting_hole: 2, tee_time: '08:08 AM', cart_numbers: '14, 15', sort_order: 1 },
    ]) {
      try { await api('POST', `/api/admin/events/${ev.id}/pairings/groups`, g, adminH); }
      catch (e) { console.log('  (pairing group POST failed: ' + e.message + ')'); }
    }

    // Personal user + game + scores so we have personal-side data
    const sup = await api('POST', '/api/users/signup', {
      name: 'Mobile Sweep', email: `sweep-${Date.now()}@example.com`, password: 'TestPass1234',
    });
    const userTok = sup.token;
    const userH = { 'x-user-token': userTok };

    // Seed a course so the wizard has something to pick (fresh sandbox DB
    // starts empty). 18 holes, par 4, simple yardages.
    const seedCourse = {
      name: 'Pebble Beach GL', city: 'Pebble Beach', state: 'CA',
      tees: ['Blue', 'White'].map((nm, i) => ({
        name: nm, gender: 'male', course_rating: 71 + i, slope_rating: 130 + i,
        holes: Array.from({length: 18}, (_, h) => ({
          hole_number: h + 1, par: 4, stroke_index: h + 1, yardage: 360 - i * 30,
        })),
      })),
    };
    await api('POST', '/api/courses', seedCourse, userH);
    const courses = await api('GET', '/api/courses', null, userH);
    if (!courses.length) throw new Error('Course seed failed');

    // 1 active best-ball game + 1 finished casual round for the tabs
    const trnActive = await api('POST', '/api/tournaments', {
      name: 'Sunday Best Ball', type: 'casual',
      course_id: courses[0].id, format: 'better_ball_stroke',
    }, userH);
    for (const p of [
      { name: 'Alex',  team_name: 'Team 1', handicap_index: 4 },
      { name: 'Bo',    team_name: 'Team 1', handicap_index: 18 },
      { name: 'Cam',   team_name: 'Team 2', handicap_index: 8 },
      { name: 'Drew',  team_name: 'Team 2', handicap_index: 22 },
    ]) await api('POST', `/api/tournaments/${trnActive.id}/field`, p, userH);
    await api('POST', `/api/rounds/${trnActive.round_id}/status`, { status: 'active' }, userH);
    const rd = await api('GET', `/api/rounds/${trnActive.round_id}`, null, userH);
    const scoreBatch = [];
    for (const e of rd.entries) for (let h = 1; h <= 9; h++) scoreBatch.push({ entry_id: e.id, hole_number: h, strokes: 4 + (h % 3) });
    await api('POST', `/api/rounds/${trnActive.round_id}/scores`, { scores: scoreBatch, entered_by: 'sweep' }, userH);

    const trnDone = await api('POST', '/api/tournaments', {
      name: 'Last Week\'s Round', type: 'casual',
      course_id: courses[0].id, format: 'stroke_net',
    }, userH);
    await api('POST', `/api/rounds/${trnDone.round_id}/status`, { status: 'active' }, userH);
    await api('POST', `/api/rounds/${trnDone.round_id}/status`, { status: 'ended' }, userH);

    const trnPub = await api('GET', `/api/tournaments/${trnActive.id}`, null, userH).catch(() => ({}));
    console.log('  seeded: event=' + ev.id + ' trnActive=' + trnActive.id + ' trnDone=' + trnDone.id);

    // ─── Browser
    console.log('[browser] launching');
    const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEWPORT });
    const page = await browser.newPage();
    await page.emulate({ viewport: VIEWPORT, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/605.1.15' });

    const findings = [];
    page.on('pageerror', e => { findings.push('JS error: ' + e.message); console.log('  ⚠ ' + e.message); });
    page.on('console', m => { if (m.type() === 'error' && !/404|favicon|net::|cors/i.test(m.text())) findings.push('Console: ' + m.text()); });

    async function shot(name) {
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
      console.log('  📸 ' + name);
    }
    async function setUserAuth() {
      await page.evaluateOnNewDocument((t) => {
        try { localStorage.setItem('jord_user_token', t); localStorage.removeItem('jord_admin_token'); } catch {}
      }, userTok);
    }
    async function setAdminAuth() {
      await page.evaluateOnNewDocument((t) => {
        try { localStorage.setItem('jord_admin_token', t); localStorage.removeItem('jord_user_token'); } catch {}
      }, adminTok);
    }

    // ━━━━━━━━━━━━━━━━━━━ PERSONAL CLUBHOUSE ━━━━━━━━━━━━━━━━━━━
    await setUserAuth();
    console.log('\n── PERSONAL ──');

    console.log('[1] /clubhouse  (Active tab default)');
    await page.goto(BASE + '/clubhouse', { waitUntil: 'load' });
    // Give the inline IIFE a moment to fetch state + render.
    await page.waitForFunction(() => typeof JORD !== 'undefined', { timeout: 8000 })
      .catch(() => console.log('  (JORD never appeared — page may be in an error state)'));
    await page.waitForSelector('.games-tabs', { timeout: 8000 }).catch(() => {});
    await sleep(700);
    await shot('p01-clubhouse-active');

    console.log('[2] /clubhouse  (Finished tab)');
    await page.evaluate(() => [...document.querySelectorAll('.games-tab')].find(t => /^Finished/.test(t.textContent.trim()))?.click());
    await sleep(400);
    await shot('p02-clubhouse-finished');

    console.log('[3] /clubhouse#game/X  (game detail w/ Edit/Clone/Reset)');
    await page.goto(BASE + '/clubhouse#game/' + trnActive.id, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await shot('p03-game-detail');

    console.log('[4] Edit Game modal (scroll fix + format settings)');
    const editBtn = await page.$('#btn-edit');
    if (editBtn) { await editBtn.click(); await sleep(600); await shot('p04-edit-game-modal'); await page.keyboard.press('Escape'); await sleep(200); }
    else findings.push('Game detail: #btn-edit not found');

    console.log('[5] Course Edit panel (✎ on a course tile)');
    await page.goto(BASE + '/clubhouse', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const courseEditBtn = await page.$('#courseList [data-edit]');
    if (courseEditBtn) { await courseEditBtn.click(); await sleep(800); await shot('p05-course-edit-panel'); }
    else findings.push('Course list: [data-edit] not found');

    console.log('[6] /round/:share  (Find your name picker)');
    await page.evaluate(() => { try { localStorage.removeItem('jord_user_token'); localStorage.removeItem('jord_admin_token'); } catch {} });
    await page.goto(BASE + '/round/' + trnPub.share_code, { waitUntil: 'domcontentloaded' });
    await sleep(700);
    await shot('p06-share-link-picker');

    console.log('[7] /scorecard  (with YOU + teammate stripe @ 375 polish)');
    // Pre-claim Alex as YOU so the highlight shows
    await page.evaluateOnNewDocument((rid, eid) => {
      try { localStorage.setItem('jord_claim_' + rid, eid); } catch {}
    }, trnActive.round_id, rd.entries[0].id);
    await page.goto(BASE + '/scorecard/' + trnActive.round_id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.p-row', { timeout: 5000 });
    await sleep(700);
    await shot('p07-scorecard-you-pill');

    console.log('[8] /live  (leaderboard)');
    await page.goto(BASE + '/live/' + trnActive.round_id, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await shot('p08-live-leaderboard');

    console.log('[8b] /live drawer expanded (best-ball team grid)');
    const teamRow = await page.$('.lb-row[data-toggle]');
    if (teamRow) { await teamRow.click(); await sleep(500); await shot('p08b-live-team-drawer'); }
    else findings.push('Live: .lb-row[data-toggle] not found');

    console.log('[9] /card  (printable)');
    await setUserAuth();
    await page.goto(BASE + '/card/' + trnActive.round_id, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await shot('p09-card-printable');

    console.log('[10] /account');
    await page.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await shot('p10-account');

    // ━━━━━━━━━━━━━━━━━━━ ADMIN ━━━━━━━━━━━━━━━━━━━
    await setAdminAuth();
    console.log('\n── ADMIN ──');

    console.log('[20] /admin  (event list w/ Help Escalations button)');
    await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await shot('a20-admin-home');

    console.log('[21] /admin/events/:id  (editor — Settings tab + help bubbles)');
    await page.goto(BASE + `/admin/events/${ev.id}`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await shot('a21-editor-settings');

    console.log('[21b] tap a help bubble  (Rough penalty mode)');
    const helpIcon = await page.evaluateHandle(() => {
      const labels = Array.from(document.querySelectorAll('label.label-with-help'));
      for (const l of labels) {
        if (/rough penalty mode/i.test(l.textContent)) return l.querySelector('.help-icon');
      }
      return null;
    });
    if (helpIcon && (await helpIcon.evaluate(x => !!x))) {
      const el = helpIcon.asElement();
      await el.evaluate(b => b.scrollIntoView({ block: 'center' }));
      await sleep(200);
      await el.click();
      await sleep(300);
      await shot('a21b-help-bubble-open');
    } else findings.push('Editor: rough-penalty help bubble not found');

    console.log('[23] /admin/events/:id/site/edit  (sponsor logo upload)');
    await page.goto(BASE + `/admin/events/${ev.id}/site/edit`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await shot('a23-site-editor');
    // Try scrolling to sponsorships section
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2, h3')].find(el => /sponsor/i.test(el.textContent));
      if (h) h.scrollIntoView({ block: 'start' });
    });
    await sleep(400);
    await shot('a23b-site-editor-sponsorships');

    console.log('[24] /admin/events/:id/pairings');
    await page.goto(BASE + `/admin/events/${ev.id}/pairings`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await shot('a24-pairings');

    console.log('[25] /admin/events/:id/pairings/poster  (sponsor strip)');
    await page.goto(BASE + `/admin/events/${ev.id}/pairings/poster`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await shot('a25-pairings-poster');

    console.log('[26] /admin/help-escalations  (super-only review)');
    await page.goto(BASE + '/admin/help-escalations', { waitUntil: 'domcontentloaded' });
    await sleep(700);
    await shot('a26-help-escalations-empty');

    console.log('[27] AI Help widget closed → open');
    await page.goto(BASE + `/admin/events/${ev.id}`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const fab = await page.$('#jha-fab');
    if (fab) {
      await shot('a27a-widget-fab');
      await fab.click();
      await sleep(400);
      await page.type('#jha-input', 'Where do I upload a sponsor logo?');
      await sleep(200);
      await shot('a27b-widget-typed');
      await page.click('#jha-send');
      await sleep(1200);  // fake chat returns instantly but give it room
      await shot('a27c-widget-replied');
    } else findings.push('AI Help widget #jha-fab not mounted on editor');

    // ━━━━━━━━━━━━━━━━━━━ PUBLIC EVENT SITE ━━━━━━━━━━━━━━━━━━━
    console.log('\n── PUBLIC ──');
    await page.evaluate(() => { try { localStorage.removeItem('jord_admin_token'); } catch {} });

    console.log('[30] /e/:slug  (branded public event site)');
    await page.goto(BASE + '/e/spring-charity-classic-2026', { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await shot('x30-public-event-site');
    // Scroll to sponsors section
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find(el => /sponsor/i.test(el.textContent));
      if (h) h.scrollIntoView({ block: 'start' });
    });
    await sleep(400);
    await shot('x30b-public-event-sponsors');

    await browser.close();

    console.log('\n──────────────────────────────────────────────');
    if (findings.length) {
      console.log(`⚠   ${findings.length} runtime finding(s):`);
      for (const f of findings) console.log('   • ' + f);
    } else {
      console.log('✅  No JS errors / missing selectors detected.');
    }
    console.log('\nScreenshots in: ' + OUT);
    shutdown(0);
  } catch (e) {
    console.error('CRASH:', e.message, e.stack);
    console.error('Server log tail:\n' + log.split('\n').slice(-30).join('\n'));
    shutdown(1);
  }
})();
