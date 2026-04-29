/**
 * JORD Golf — Auto Test Watcher
 * Watches all source files and re-runs tests automatically on every save.
 *
 * Usage:
 *   node tests/watch.js            — unit tests only (no server needed)
 *   node tests/watch.js --live     — unit + live API tests (requires npm run dev)
 */
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT      = path.resolve(__dirname, '..');
const WATCH_EXT = new Set(['.js', '.html', '.css', '.json']);
const SKIP_DIR  = ['node_modules', '.git', 'data'];

const FORCE_LIVE = process.argv.includes('--live');

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const R  = '\x1b[0m';
const DIM  = '\x1b[2m';
const BOLD = '\x1b[1m';
const GRN  = '\x1b[32m';
const YLW  = '\x1b[33m';
const CYN  = '\x1b[36m';
const RED  = '\x1b[31m';

// ─── State ────────────────────────────────────────────────────────────────────
let debounceTimer = null;
let isRunning     = false;
let queuedTrigger = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearScreen() { process.stdout.write('\x1Bc'); }

function canReachServer() {
  return new Promise(resolve => {
    const r = http.request(
      { hostname: 'localhost', port: 3000, path: '/api/server-info', method: 'GET' },
      () => resolve(true)
    );
    r.setTimeout(1200, () => { r.destroy(); resolve(false); });
    r.on('error', () => resolve(false));
    r.end();
  });
}

function runScript(scriptPath) {
  return new Promise(resolve => {
    const child = spawn('node', [scriptPath], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// ─── Main test run ────────────────────────────────────────────────────────────

async function runAll(trigger) {
  if (isRunning) { queuedTrigger = trigger || queuedTrigger; return; }
  isRunning = true;

  clearScreen();
  const ts = new Date().toLocaleTimeString();
  console.log(`\n${BOLD}${CYN}⚡  JORD Auto-Test Runner${R}  ${DIM}${ts}${R}`);
  if (trigger) console.log(`${DIM}   ↳ changed: ${trigger}${R}`);
  console.log('');

  // Always run unit tests (no server needed)
  console.log(`${BOLD}Unit Tests${R}`);
  const unitOk = await runScript('tests/run-tests.js');

  // Live tests — auto-detect server, or forced with --live
  const serverUp = FORCE_LIVE || await canReachServer();
  let liveOk = true;

  if (serverUp) {
    console.log(`\n${DIM}─────────────────────────────────────────────${R}`);
    console.log(`${BOLD}Live API Tests${R}  ${DIM}(server detected on :3000)${R}\n`);
    liveOk = await runScript('tests/live-tests.js');
  } else {
    console.log(`\n${DIM}ℹ  Server not running — skipping live tests.${R}`);
    console.log(`${DIM}   Start with 'npm run dev' to enable live API testing.${R}`);
  }

  const allOk = unitOk && liveOk;
  console.log(allOk
    ? `\n${GRN}${BOLD}✔  All tests passed${R}\n`
    : `\n${RED}${BOLD}✖  Tests failed — fix issues above${R}\n`
  );

  console.log(`${DIM}👁  Watching for changes... (Ctrl+C to stop)${R}\n`);
  isRunning = false;

  // Re-run if a change came in while we were running
  if (queuedTrigger) {
    const next = queuedTrigger;
    queuedTrigger = null;
    schedule(next);
  }
}

function schedule(trigger) {
  if (isRunning) { queuedTrigger = trigger; return; }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runAll(trigger), 500);
}

// ─── File watcher ─────────────────────────────────────────────────────────────

try {
  fs.watch(ROOT, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const ext = path.extname(filename);
    if (!WATCH_EXT.has(ext)) return;
    // Skip ignored directories (handles both / and \ separators)
    if (SKIP_DIR.some(d => filename.includes(d))) return;
    schedule(filename);
  });
} catch (e) {
  console.warn(`${YLW}Warning: File watching unavailable (${e.message}).${R}`);
  console.warn(`${YLW}Tests will only run once. Use 'npm test' to run manually.${R}\n`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}${CYN}JORD Golf — Auto Test Watcher${R}`);
console.log(`${DIM}Watching: server.js · public/ · tests/${R}\n`);

runAll(null);
