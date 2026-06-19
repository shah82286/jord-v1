/**
 * JORD Golf — Manual (server-dependent) test runner.
 *
 * Many tests under tests/manual/ hit a live http://localhost:3000 and so are
 * NOT part of `node tests/run-tests.js` (which is pure in-process unit tests).
 * This runner boots the server once, runs each listed script as a child
 * process, then shuts the server down — so the server-dependent tests don't
 * get forgotten.
 *
 *   npm run test:manual        # boot server, run all listed tests, tear down
 *
 * If a server is already listening on :3000 it is reused (and left running).
 *
 * To add a test: drop its path into TESTS below. Each script must exit 0 on
 * pass / non-zero on fail (the existing manual tests already do this).
 * Pure-screenshot capture scripts (capture-*.js, shot-*.js) are intentionally
 * excluded — they produce images, not pass/fail, and are run on their own.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

// Server-dependent manual tests, in run order. Keep this list curated —
// only scripts that are current and exit 0/1.
const TESTS = [
  'tests/manual/test-skins-gross.js',   // skins handicap + carry-over logic (no server, but a real pass/fail test)
  'tests/manual/test-edit-settings.js', // PATCH format_settings + side_bets on an existing tournament (v3.69)
  'tests/manual/test-branding.js',      // per-event branding persist/flow/validate + delete-ownership guard (v3.71)
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function serverUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${BASE}/api/config`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp()) return true;
    await sleep(500);
  }
  return false;
}

function runTest(rel) {
  return new Promise(resolve => {
    const child = spawn('node', [rel], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ rel, code, out }));
    child.on('error', err => resolve({ rel, code: 1, out: String(err) }));
  });
}

(async () => {
  console.log('\n🧪 JORD Manual (server-dependent) tests\n');

  let server = null;
  const alreadyUp = await serverUp();
  if (alreadyUp) {
    console.log(`  ↻ Reusing server already running on :${PORT}\n`);
  } else {
    console.log(`  ▶ Booting server (node server.js) on :${PORT}…`);
    server = spawn('node', ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let boot = '';
    server.stdout.on('data', d => { boot += d; });
    server.stderr.on('data', d => { boot += d; });
    const ok = await waitForServer();
    if (!ok) {
      console.error('  ❌ Server did not become ready in time. Last output:\n');
      console.error(boot.split('\n').slice(-15).join('\n'));
      if (server) server.kill();
      process.exit(1);
    }
    console.log('  ✓ Server ready\n');
  }

  const results = [];
  for (const rel of TESTS) {
    process.stdout.write(`  • ${rel} … `);
    const r = await runTest(rel);
    results.push(r);
    if (r.code === 0) {
      console.log('✅');
    } else {
      console.log('❌');
      // Show the failing script's output (indented) so the cause is visible.
      console.log(r.out.split('\n').map(l => '      ' + l).join('\n'));
    }
  }

  // Tear down the server only if WE started it.
  if (server) server.kill();

  const passed = results.filter(r => r.code === 0).length;
  const failed = results.length - passed;
  console.log('\n' + '─'.repeat(52));
  console.log(`\n📊  ${passed}/${results.length} manual tests passed  |  ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\n💥 run-manual crashed:', e.message, '\n'); process.exit(1); });
