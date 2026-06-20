// v3.74 — verify the Clubhouse "Active / Finished" tabs at mobile width.
// Seeds 1 active + 1 finished tournament for a personal user, then screenshots
// both tab states. The tab counts should reflect the seeded games and tab
// selection should persist across renders.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path_, opts = {}) {
  const r = await fetch(BASE + path_, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path_} → ${r.status}: ${body?.error || ''}`);
  return body;
}

(async () => {
  console.log('[seed] creating user + 1 active + 1 finished tournament');
  const email = `ct-${Date.now()}@example.com`;
  const sup = await api('/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Clubhouse Tabs', email, password: 'TestPass1234' }),
  });
  const tok = sup.token;
  const H = { 'Content-Type': 'application/json', 'x-user-token': tok };
  const courses = await api('/api/courses', { headers: { 'x-user-token': tok } });

  // Active game — never started, just sits in setup.
  await api('/api/tournaments', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Sunday Round (active)', type: 'casual',
      course_id: courses[0].id, format: 'stroke_net' }) });

  // Finished game — create, start the round, then end it.
  const done = await api('/api/tournaments', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Last Week\'s Round (finished)', type: 'casual',
      course_id: courses[0].id, format: 'stroke_net' }) });
  await api(`/api/rounds/${done.round_id}/status`, { method: 'POST', headers: H,
    body: JSON.stringify({ status: 'active' }) });
  await api(`/api/rounds/${done.round_id}/status`, { method: 'POST', headers: H,
    body: JSON.stringify({ status: 'ended' }) });

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEWPORT });
  const page = await browser.newPage();
  await page.emulate({ viewport: VIEWPORT, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/605.1.15' });
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('jord_user_token', t); }, tok);
  page.on('pageerror', e => console.log('  ⚠ JS:', e.message));

  console.log('[1] Active tab (default)');
  await page.goto(BASE + '/clubhouse', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.games-tabs', { timeout: 5000 });
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'clubhouse-tab-active.png'), fullPage: true });

  // Verify counts
  const counts = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.games-tab')];
    return tabs.map(t => ({ label: t.textContent.replace(/\s+/g, ' ').trim(), active: t.classList.contains('is-active') }));
  });
  console.log('  tabs:', JSON.stringify(counts));
  const activeTab = counts.find(c => /^Active/.test(c.label));
  const finishedTab = counts.find(c => /^Finished/.test(c.label));
  if (!activeTab || !/1$/.test(activeTab.label)) throw new Error('Active tab should show count 1, got: ' + activeTab?.label);
  if (!finishedTab || !/1$/.test(finishedTab.label)) throw new Error('Finished tab should show count 1, got: ' + finishedTab?.label);
  if (!activeTab.active) throw new Error('Active tab should be selected by default');

  console.log('[2] tap Finished tab');
  const finishedBtn = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('.games-tab')].find(t => /^Finished/.test(t.textContent.trim()));
  });
  await finishedBtn.asElement().click();
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'clubhouse-tab-finished.png'), fullPage: true });

  const afterClick = await page.evaluate(() => {
    return [...document.querySelectorAll('.games-tab')].map(t => ({
      label: t.textContent.replace(/\s+/g, ' ').trim(),
      active: t.classList.contains('is-active'),
    }));
  });
  const fActive = afterClick.find(c => /^Finished/.test(c.label));
  if (!fActive.active) throw new Error('Finished tab should be selected after click');

  // Verify the finished tile is visible and the "+ New game" tile is NOT.
  const tileNames = await page.evaluate(() => [...document.querySelectorAll('#trnList h3')].map(h => h.textContent.trim()));
  console.log('  visible tiles:', JSON.stringify(tileNames));
  if (!tileNames.some(n => /finished/i.test(n))) throw new Error('Finished game not visible on Finished tab');
  const newTile = await page.$('[data-new]');
  if (newTile) throw new Error('"+ New game" tile should be hidden on Finished tab');

  console.log('[3] reload — selected tab should persist via sessionStorage');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.games-tabs', { timeout: 5000 });
  await sleep(400);
  const afterReload = await page.evaluate(() => {
    return [...document.querySelectorAll('.games-tab')].map(t => ({
      label: t.textContent.replace(/\s+/g, ' ').trim(),
      active: t.classList.contains('is-active'),
    }));
  });
  const stillFinished = afterReload.find(c => /^Finished/.test(c.label));
  if (!stillFinished.active) throw new Error('Selected tab should persist across reload (sessionStorage)');

  await browser.close();
  console.log('\n✅ ALL PASS — tabs filter correctly, counts accurate, selection persists');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
