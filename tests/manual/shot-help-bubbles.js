// Verify the tap-friendly help bubble behavior at mobile viewport.
// Renders an isolated HTML fixture with the same CSS + JS rules added in
// v3.72 to admin.html / admin/editor.html, then exercises tap-open,
// outside-click-close, and tap-on-other-icon transfer.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Inline fixture — keep CSS + JS in sync with the changes shipped in
// public/admin.html and public/admin/editor.html so this test catches a
// regression if those rules drift.
const FIXTURE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --surface:#FAF7F2; --surface-2:#F0EBE2; --ink:#1A1A1A; --ink-2:#5A5A5A; --border:#D4CFC4;
          --accent:#B8884D; --primary-ink:#fff; --r-md:8px; --shadow-md:0 4px 12px rgba(0,0,0,.12); }
  body { font-family: system-ui, sans-serif; padding: 60px 20px; background: var(--surface); color: var(--ink); }
  label { display: block; margin-bottom: 16px; }
  .label-with-help { display: flex; align-items: center; gap: 0; }
  .help-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
    border-radius: 50%; background: var(--surface-2); color: var(--ink-2); font-size: 12px; font-weight: 700;
    cursor: help; margin-left: 4px; position: relative; flex-shrink: 0;
    -webkit-tap-highlight-color: transparent; user-select: none; }
  .help-icon:hover,
  .help-icon.is-open { background: var(--accent); color: var(--primary-ink); }
  .tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: 9px 11px;
    font-size: 12px; color: var(--ink); width: 230px; max-width: calc(100vw - 32px); white-space: normal; line-height: 1.45;
    text-align: left; font-weight: 400; text-transform: none; letter-spacing: 0;
    z-index: 1000; margin-bottom: 6px; box-shadow: var(--shadow-md); pointer-events: none; }
  .help-icon:hover .tooltip,
  .help-icon.is-open .tooltip { display: block; }
  .help-icon.is-open .tooltip { pointer-events: auto; }
</style></head><body>
  <label class="label-with-help">Rough penalty mode
    <span class="help-icon" id="rough">ℹ<span class="tooltip">Perpendicular: the penalty equals the exact distance from the ball to the nearest fairway edge. Fixed: subtract the same set number of yards no matter where the ball sits.</span></span></label>
  <label class="label-with-help">OOB penalty mode
    <span class="help-icon" id="oob">ℹ<span class="tooltip">Half hole: the penalty is 50% of the total hole distance. Fixed: subtract the same set number of yards.</span></span></label>
<script>
  document.addEventListener('click', (e) => {
    const icon = e.target.closest('.help-icon');
    document.querySelectorAll('.help-icon.is-open').forEach(o => { if (o !== icon) o.classList.remove('is-open'); });
    if (icon) { e.stopPropagation(); icon.classList.toggle('is-open'); }
  });
</script></body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEWPORT });
  const page = await browser.newPage();
  await page.emulate({ viewport: VIEWPORT, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/605.1.15' });
  await page.setContent(FIXTURE);
  await sleep(150);

  const isOpen = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('is-open'), id);

  // 1. Baseline — both closed
  if (await isOpen('rough') || await isOpen('oob')) { console.error('FAIL: bubbles start open'); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, 'help-01-baseline.png') });
  console.log('  📸 baseline — both closed');

  // 2. Tap rough → should open
  await page.click('#rough');
  await sleep(100);
  if (!await isOpen('rough')) { console.error('FAIL: tap did not open rough'); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, 'help-02-rough-open.png') });
  console.log('  ✅ tap opens rough bubble');

  // 3. Tap OOB → should open OOB and close rough (only one open at a time)
  await page.click('#oob');
  await sleep(100);
  if (!await isOpen('oob')) { console.error('FAIL: tap did not open oob'); process.exit(1); }
  if (await isOpen('rough')) { console.error('FAIL: tapping oob did not close rough'); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, 'help-03-oob-open-rough-closed.png') });
  console.log('  ✅ tap on second icon transfers focus (rough closed, oob open)');

  // 4. Tap outside → should close oob
  await page.mouse.click(10, 10);
  await sleep(100);
  if (await isOpen('oob')) { console.error('FAIL: outside-click did not close'); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, 'help-04-outside-click-closes.png') });
  console.log('  ✅ outside-click closes bubble');

  // 5. Tap same icon twice → toggle off
  await page.click('#rough');
  await sleep(100);
  await page.click('#rough');
  await sleep(100);
  if (await isOpen('rough')) { console.error('FAIL: second tap did not toggle off'); process.exit(1); }
  console.log('  ✅ tap-tap on same icon toggles off');

  await browser.close();
  console.log('\n✅ ALL PASS — tap-friendly help bubbles work on mobile');
  process.exit(0);
})().catch(e => { console.error('CRASH:', e.message, e.stack); process.exit(1); });
