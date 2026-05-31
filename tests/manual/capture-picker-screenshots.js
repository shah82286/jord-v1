// Capture screenshots of the new format picker for v3.59.
const puppeteer = require('puppeteer');
const path = require('path');
const SHOTS = path.join(__dirname, '..', 'screenshots');

const BASE = 'http://localhost:3000';
const email = `pickshot-${Date.now()}@example.com`;
const password = 'TestPass1234';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  // Sign up + reach wizard step 3 (setup) the long way
  await page.goto(`${BASE}/login?track=personal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#modeSignup.is-active');
  await page.type('#name', 'Pick Shots');
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);

  // Open the wizard
  await page.waitForSelector('#create');
  await page.evaluate(() => { document.querySelectorAll('#toast-stack .toast').forEach(t => t.remove()); });
  await page.click('#create');
  await page.waitForSelector('.pick-card', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 200));

  // Casual tile
  const tile = (await page.$$('.pick-card'))[0];
  await tile.click();
  await new Promise(r => setTimeout(r, 400));

  // Course step: pick the first available course by injecting it into S.wiz
  // and jumping to setup. (Course is selected via autocomplete in the real UI;
  // we skip that interaction since we just want to land on the picker step.)
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => {
    if (window.S && window.S.courses && window.S.courses.length) {
      window.S.wiz.course_id = window.S.courses[0].id;
      window.S.wiz.holes_segment = 'all';
    }
    location.hash = 'new/setup';
  });
  await new Promise(r => setTimeout(r, 600));

  // We may now be on setup step. Capture a wide shot.
  const ok = await page.waitForSelector('#fmtPicker', { timeout: 5000 }).catch(() => null);
  if (!ok) {
    console.log('Skipping picker shots — did not reach setup step (course flow gated)');
    await browser.close();
    process.exit(0);
  }

  // Scroll the picker into view + park the cursor far off the grid so no card
  // sits in a :hover state when the screenshot fires.
  await page.evaluate(() => { const el = document.querySelector('#fmtPicker'); if (el) el.scrollIntoView({ block: 'start' }); });
  await page.mouse.move(2, 2);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '20-picker-default.png'), fullPage: false });
  console.log('1. default picker (Stroke Net selected) with wagering panel hidden');

  // Hover over Skins to surface its bubble
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.fmt-card'));
    const skins = cards.find(c => c.querySelector('.nm')?.textContent === 'Skins');
    if (skins) skins.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    if (skins) skins.classList.add('hover-shot');
  });
  // Force hover via CSS to make the bubble visible for the shot
  await page.addStyleTag({ content: '.fmt-card.hover-shot .fc-bubble { opacity: 1 !important; transform: translateX(-50%) translateY(0) !important; } .fmt-card.hover-shot .fc-emoji { transform: scale(1.18) rotate(-4deg) !important; }' });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '21-picker-hover-skins.png'), fullPage: false });
  console.log('2. hover bubble on Skins');

  // Click Skins → wagering panel appears. Park cursor off the grid before
  // the snap so the bubble doesn't reappear from a leftover hover.
  await page.evaluate(() => {
    document.querySelectorAll('.hover-shot').forEach(c => c.classList.remove('hover-shot'));
    const cards = Array.from(document.querySelectorAll('.fmt-card'));
    const skins = cards.find(c => c.querySelector('.nm')?.textContent === 'Skins');
    if (skins) skins.click();
  });
  await page.mouse.move(2, 2);
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(SHOTS, '22-picker-skins-wager.png'), fullPage: false });
  console.log('3. Skins selected → wagering panel ($/skin)');

  // Click Bingo Bango Bongo → MANUAL badge + point inputs
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.fmt-card'));
    const bbb = cards.find(c => c.querySelector('.nm')?.textContent === 'Bingo Bango Bongo');
    if (bbb) bbb.click();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { const el = document.querySelector('#fmtPicker .fmt-wager'); if (el) el.scrollIntoView({ block: 'center' }); });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '23-picker-bbb.png'), fullPage: false });
  console.log('4. Bingo Bango Bongo selected → point inputs');

  // Click Dots → editable events list
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.fmt-card'));
    const dots = cards.find(c => c.querySelector('.nm')?.textContent === 'Dots');
    if (dots) dots.click();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { const el = document.querySelector('#fmtPicker .fmt-wager'); if (el) el.scrollIntoView({ block: 'center' }); });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '24-picker-dots-events.png'), fullPage: false });
  console.log('5. Dots selected → editable events list');

  // Mobile view
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => { const el = document.querySelector('#fmtPicker'); if (el) el.scrollIntoView({ block: 'start' }); });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, '25-picker-mobile.png'), fullPage: false });
  console.log('6. mobile picker');

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
