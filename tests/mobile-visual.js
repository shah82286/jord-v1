/**
 * JORD Golf — Mobile Visual Layout Tests
 *
 * What it does:
 *   - Boots iPhone 14 + Pixel 7 emulated viewports via Puppeteer
 *   - Walks through landing/scan/global/qr/about/signup/admin-login
 *   - If EVENT_ID env var is set, also walks register/leaderboard/monitor for that event
 *   - Screenshots every page (full-page) to tests/visual-report/<page>-<device>.png
 *   - Runs deterministic layout checks: page-level horizontal scroll, elements that
 *     extend past the viewport, content clipped by overflow:hidden parents
 *   - Writes findings.json with all issues found
 *
 * What it does NOT do:
 *   - Doesn't judge "unreadable" or aesthetic issues (eyeball work)
 *   - Doesn't auto-fix CSS or commit changes
 *   - Doesn't log into the admin panel (only screenshots the login screen)
 *
 * Run:
 *   1. npm start                                   (in another terminal)
 *   2. node tests/mobile-visual.js                 (or with EVENT_ID=<uuid> prefix)
 */

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, 'visual-report');
const EVENT_ID = process.env.EVENT_ID || '';

const DEVICES = {
  'iphone-14': {
    width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-7': {
    width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
};

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'scan-entry', path: '/scan' },
  { name: 'global-leaderboard', path: '/global' },
  { name: 'qr', path: '/qr.html' },
  { name: 'about', path: '/about.html' },
  { name: 'signup', path: '/signup' },
  { name: 'admin-login', path: '/admin' },
  { name: 'login', path: '/login' },
  { name: 'event-site', path: '/e/fairway-fund-classic-2026' },
  { name: 'event-register', path: '/e/fairway-fund-classic-2026/register' },
];

if (EVENT_ID) {
  PAGES.push(
    { name: 'register-event', path: `/register/${EVENT_ID}` },
    { name: 'leaderboard-event', path: `/leaderboard/${EVENT_ID}` },
    { name: 'monitor-event', path: `/monitor/${EVENT_ID}` },
  );
}

function shortSelector(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = (typeof el.className === 'string' && el.className.trim())
    ? `.${el.className.trim().split(/\s+/)[0]}`
    : '';
  return `${tag}${id}${cls}`;
}

async function detectIssues(page) {
  return await page.evaluate((shortSelectorSrc) => {
    const shortSelector = new Function('return ' + shortSelectorSrc)();
    const issues = [];
    const vw = document.documentElement.clientWidth;

    if (document.documentElement.scrollWidth > vw + 1) {
      issues.push({
        type: 'page-horizontal-scroll',
        detail: `Document width ${document.documentElement.scrollWidth}px exceeds viewport ${vw}px`,
      });
    }

    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (rect.right > vw + 1) {
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        issues.push({
          type: 'element-extends-past-viewport',
          selector: shortSelector(el),
          right: Math.round(rect.right),
          viewportWidth: vw,
          text,
        });
      }

      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        const computed = getComputedStyle(el);
        if (computed.overflowX === 'auto' || computed.overflowX === 'scroll') continue;
        if (['html', 'body'].includes(el.tagName.toLowerCase())) continue;
        issues.push({
          type: 'content-clipped',
          selector: shortSelector(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: computed.overflowX,
        });
      }
    }

    return issues.slice(0, 30);
  }, shortSelector.toString());
}

async function testPage(browser, deviceName, deviceConfig, pageDef) {
  const ctx = await browser.createBrowserContext();
  const tab = await ctx.newPage();
  try {
    await tab.setViewport({
      width: deviceConfig.width,
      height: deviceConfig.height,
      deviceScaleFactor: deviceConfig.deviceScaleFactor,
      isMobile: deviceConfig.isMobile,
      hasTouch: deviceConfig.hasTouch,
    });
    await tab.setUserAgent(deviceConfig.userAgent);

    const response = await tab.goto(BASE + pageDef.path, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 600));

    const screenshotName = `${pageDef.name}-${deviceName}.png`;
    const screenshotPath = path.join(OUT_DIR, screenshotName);
    await tab.screenshot({ path: screenshotPath, fullPage: true });

    const issues = await detectIssues(tab);

    return {
      device: deviceName,
      page: pageDef.name,
      path: pageDef.path,
      status: response ? response.status() : null,
      screenshot: screenshotName,
      issues,
    };
  } finally {
    await ctx.close();
  }
}

async function main() {
  try {
    const res = await fetch(BASE);
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`✗ Server not reachable at ${BASE} (${e.message})`);
    console.error(`  Start it in another terminal:  npm start`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: 'new' });
  const results = [];

  for (const [deviceName, deviceConfig] of Object.entries(DEVICES)) {
    for (const pageDef of PAGES) {
      process.stdout.write(`→ ${deviceName.padEnd(10)} ${pageDef.path.padEnd(40)}`);
      try {
        const r = await testPage(browser, deviceName, deviceConfig, pageDef);
        results.push(r);
        const mark = r.issues.length === 0 ? '✓' : '⚠';
        console.log(`${mark} ${r.issues.length} issue(s) [HTTP ${r.status}]`);
      } catch (e) {
        console.log(`✗ ${e.message}`);
        results.push({ device: deviceName, page: pageDef.name, path: pageDef.path, error: e.message });
      }
    }
  }

  await browser.close();

  const reportPath = path.join(OUT_DIR, 'findings.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  const totalIssues = results.reduce((s, r) => s + (r.issues?.length || 0), 0);
  const failed = results.filter(r => r.error).length;

  console.log('\n=== Summary ===');
  console.log(`Tests:        ${results.length}`);
  console.log(`Layout issues: ${totalIssues}`);
  console.log(`Failed loads:  ${failed}`);
  console.log(`Report:       ${path.relative(process.cwd(), reportPath)}`);
  console.log(`Screenshots:  ${path.relative(process.cwd(), OUT_DIR)}/`);

  if (totalIssues > 0) {
    const top = results
      .flatMap(r => (r.issues || []).map(i => ({ ...i, where: `${r.device}:${r.page}` })))
      .slice(0, 10);
    console.log('\nTop issues:');
    top.forEach((i, n) => {
      const id = i.selector || i.detail || '';
      console.log(`  ${n + 1}. [${i.where}] ${i.type} ${id}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
