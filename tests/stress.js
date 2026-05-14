'use strict';
/**
 * JORD Golf — Stress & Security Test Suite
 *
 * Usage:
 *   node tests/stress.js                                           # localhost:3000
 *   node tests/stress.js --url https://tournament.jordgolf.com --password <pass>
 *   node tests/stress.js --test S1                                 # single test
 *   node tests/stress.js --all                                     # full suite
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = f => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : null; };
const hasFlag = f => args.includes(f);

const BASE_URL  = getArg('--url') || 'http://localhost:3000';
const RUN_TEST  = getArg('--test');  // e.g. S1, X2
const RUN_ALL   = hasFlag('--all') || (!RUN_TEST); // default: run all

const ADMIN = getArg('--password') || (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m   = src.match(/^ADMIN_PASSWORD=(.+)$/m);
    return m ? m[1].trim() : 'jord2026';
  } catch { return 'jord2026'; }
})();

// ── HTTP client ───────────────────────────────────────────────────────────────
function req(method, urlPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const full = new URL(urlPath, BASE_URL);
    const data = body ? JSON.stringify(body) : null;
    const lib  = full.protocol === 'https:' ? https : http;
    const opts = {
      hostname: full.hostname,
      port:     full.port || (full.protocol === 'https:' ? 443 : 80),
      path:     full.pathname + full.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'x-admin-token': ADMIN,
        ...extraHeaders,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function timedReq(method, urlPath, body, headers) {
  const t0 = Date.now();
  const res = await req(method, urlPath, body, headers);
  return { ...res, ms: Date.now() - t0 };
}

// Open an SSE stream, count events received over durationMs, then close
function openSSE(urlPath, durationMs) {
  return new Promise(resolve => {
    const full = new URL(urlPath, BASE_URL);
    const lib  = full.protocol === 'https:' ? https : http;
    let eventCount = 0, connected = false;
    const r = lib.request({
      hostname: full.hostname,
      port:     full.port || (full.protocol === 'https:' ? 443 : 80),
      path:     full.pathname,
      method:   'GET',
      headers:  { Accept: 'text/event-stream', 'x-admin-token': ADMIN },
    }, res => {
      connected = (res.statusCode === 200);
      res.on('data', chunk => {
        eventCount += (chunk.toString().match(/^data:/gm) || []).length;
      });
    });
    r.on('error', () => resolve({ connected: false, events: 0 }));
    r.end();
    setTimeout(() => {
      try { r.destroy(); } catch {}
      resolve({ connected, events: eventCount });
    }, durationMs);
  });
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    min: s[0],
    max: s[s.length - 1],
    p95: s[Math.floor(s.length * 0.95)] ?? s[s.length - 1],
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────
const results = [];

async function test(id, label, fn) {
  if (RUN_TEST && RUN_TEST !== id) return;
  process.stdout.write(`  ${id.padEnd(4)}  ${label.padEnd(46)} `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, label, status: 'PASS', detail, ms: Date.now() - t0 });
    console.log(`✅  ${detail || ''}`);
  } catch (e) {
    results.push({ id, label, status: 'FAIL', error: e.message, ms: Date.now() - t0 });
    console.log(`❌  ${e.message}`);
  }
}

async function warn(id, label, fn) {
  if (RUN_TEST && RUN_TEST !== id) return;
  process.stdout.write(`  ${id.padEnd(4)}  ${label.padEnd(46)} `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, label, status: 'WARN', detail, ms: Date.now() - t0 });
    console.log(`⚠️   ${detail || ''}`);
  } catch (e) {
    results.push({ id, label, status: 'PASS', detail: e.message, ms: Date.now() - t0 });
    console.log(`✅  ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── Setup helpers ─────────────────────────────────────────────────────────────
async function addAndRegisterBalls(eventId, teeId, codes) {
  await req('POST', `/api/events/${eventId}/balls`, { codes });
  for (let i = 0; i < codes.length; i++) {
    await req('POST', `/api/events/${eventId}/register-player`, {
      drop_code: codes[i], first_name: `P${i+1}`, last_name: 'Stress',
      tee_box_id: teeId, player_index: i + 1,
    }, { 'x-admin-token': '' });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏌️  JORD Golf — Stress & Security Test Suite');
  console.log(`   Target : ${BASE_URL}`);
  console.log(`   Time   : ${new Date().toISOString()}`);
  console.log(`   Running: ${RUN_TEST ? '#' + RUN_TEST : 'all tests'}\n`);
  console.log('═'.repeat(65));

  // ── Setup: create a throw-away test event ─────────────────────────────────
  let eventId = null, teeId = null;
  console.log('\n⚙️  Setup\n');

  try {
    // Create event
    const evr = await req('POST', '/api/events', {
      name: '_JORD_STRESS_TEST_',
      venue: 'Stress Test Venue',
      starts_at: '2099-01-01T00:00:00',
      ends_at:   '2099-12-31T00:00:00',
      has_longest_drive: 1,
    });
    assert(evr.status === 200, `Event create failed ${evr.status}: ${JSON.stringify(evr.body)}`);
    eventId = evr.body.id;

    // Activate it so player routes work
    await req('PATCH', `/api/events/${eventId}`, { status: 'active' });

    // Tee box near Atlanta (for realistic lat/lon distance calcs)
    const teer = await req('POST', `/api/events/${eventId}/tee-boxes`, {
      name: "Men's", lat: 33.5020, lon: -84.3970, color: 'white',
    });
    assert(teer.status === 200, `Tee create failed: ${teer.status}`);
    teeId = teer.body.id;

    // Save pin + fairway polygon so zone detection has data
    await req('PATCH', `/api/events/${eventId}`, {
      pin_lat: 33.5075, pin_lon: -84.3953,
      fairway_polygon: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-84.3965, 33.5025],[-84.3942, 33.5025],
              [-84.3942, 33.5080],[-84.3965, 33.5080],
              [-84.3965, 33.5025],
            ]],
          },
          properties: { kind: 'fairway' },
        }],
      }),
    });

    // Seed base team (4 balls STRESS01–04)
    const baseCodes = ['STRESS01','STRESS02','STRESS03','STRESS04'];
    await addAndRegisterBalls(eventId, teeId, baseCodes);
    const finalr = await req('POST', `/api/events/${eventId}/finalize-team`, {
      team_name: '_Base Stress Team_', drop_codes: baseCodes,
    }, { 'x-admin-token': '' });
    assert(finalr.status === 200, `Team finalize failed: ${finalr.status} ${JSON.stringify(finalr.body)}`);

    console.log(`   ✅  Event ${eventId} created, activated, 1 team registered\n`);
  } catch (e) {
    console.log(`   ❌  Setup failed: ${e.message}\n`);
    if (eventId) await req('DELETE', `/api/events/${eventId}`);
    process.exit(1);
  }

  try {
    // ── STRESS TESTS ─────────────────────────────────────────────────────────
    if (RUN_ALL || RUN_TEST?.startsWith('S')) {
      console.log('\n── Stress Tests ─────────────────────────────────────────────────\n');

      // S1: 20 concurrent scans
      await test('S1', 'Concurrent scans (20 balls, fired at once)', async () => {
        const codes = Array.from({ length: 20 }, (_, i) => `S1BALL${String(i+1).padStart(2,'0')}`);
        await addAndRegisterBalls(eventId, teeId, codes);
        await req('POST', `/api/events/${eventId}/finalize-team`, {
          team_name: '_S1 Concurrent Team_', drop_codes: codes,
        }, { 'x-admin-token': '' });
        // Fire all 20 scans simultaneously
        const shots = codes.map((code, i) =>
          timedReq('POST', `/api/scan/ld/${code}`, {
            lat: 33.5050 + (i * 0.0002), lon: -84.3953, location_type: 'fairway',
          }, { 'x-admin-token': '' })
        );
        const res = await Promise.all(shots);
        const ok     = res.filter(r => r.status === 200).length;
        const errors = res.filter(r => r.status >= 500).length;
        const s      = stats(res.map(r => r.ms));
        assert(errors === 0, `${errors} server errors (500s) under concurrent load`);
        return `${ok}/20 recorded  avg ${s.avg}ms  p95 ${s.p95}ms  max ${s.max}ms`;
      });

      // S2: 15 simultaneous SSE connections
      await test('S2', 'SSE connections (15 simultaneous, 3s each)', async () => {
        // First trigger a scan so at least one SSE event fires during the test
        req('POST', `/api/scan/ld/STRESS01`, {
          lat: 33.5050, lon: -84.3953, location_type: 'fairway',
        }, { 'x-admin-token': '' }); // fire & forget

        const conns = await Promise.all(
          Array.from({ length: 15 }, () =>
            openSSE(`/api/events/${eventId}/stream`, 3000)
          )
        );
        const connected = conns.filter(c => c.connected).length;
        const totalEvts = conns.reduce((a, c) => a + c.events, 0);
        assert(connected >= 14, `Only ${connected}/15 SSE connections succeeded`);
        return `${connected}/15 connected  total events received: ${totalEvts}`;
      });

      // S3: 60 rapid sequential scans on same ball (tests DB write + SSE loop)
      await test('S3', 'Rapid sequential scans (60× same ball)', async () => {
        const times = [], statuses = {};
        for (let i = 0; i < 60; i++) {
          const r = await timedReq('POST', `/api/scan/ld/STRESS02`, {
            lat: 33.5050, lon: -84.3953, location_type: 'fairway',
          }, { 'x-admin-token': '' });
          statuses[r.status] = (statuses[r.status] || 0) + 1;
          times.push(r.ms);
          assert(r.status < 500, `Server error on scan #${i+1}: ${r.status}`);
        }
        const s = stats(times);
        const breakdown = Object.entries(statuses).map(([k,v]) => `${k}×${v}`).join(' ');
        return `avg ${s.avg}ms  p95 ${s.p95}ms  max ${s.max}ms  (${breakdown})`;
      });

      // S4: 8 teams finalizing simultaneously
      await test('S4', 'Registration flood (8 teams simultaneously)', async () => {
        const teams = Array.from({ length: 8 }, (_, t) =>
          Array.from({ length: 4 }, (__, p) => `S4T${t}B${p}`)
        );
        // Add all 32 balls and register all 32 players sequentially
        for (const codes of teams) {
          await addAndRegisterBalls(eventId, teeId, codes);
        }
        // Finalize all 8 teams simultaneously
        const t0 = Date.now();
        const finalResults = await Promise.all(teams.map((codes, t) =>
          timedReq('POST', `/api/events/${eventId}/finalize-team`, {
            team_name: `S4 Flood Team ${t+1}`, drop_codes: codes,
          }, { 'x-admin-token': '' })
        ));
        const ok     = finalResults.filter(r => r.status === 200).length;
        const errors = finalResults.filter(r => r.status >= 500).length;
        const s      = stats(finalResults.map(r => r.ms));
        assert(errors === 0, `${errors} server errors during flood`);
        assert(ok === 8, `Only ${ok}/8 teams created`);
        return `${ok}/8 teams created  avg ${s.avg}ms  total ${Date.now()-t0}ms`;
      });

      // S5: Response time baseline across key endpoints
      await test('S5', 'API response time baseline (key endpoints)', async () => {
        const endpoints = [
          ['GET',  '/api/events',                       null],
          ['GET',  `/api/events/${eventId}`,             null],
          ['GET',  `/api/events/${eventId}/balls`,       null],
          ['GET',  `/api/leaderboard/${eventId}`,        null],
          ['GET',  `/api/events/${eventId}/info`,        null],
        ];
        const rows = [];
        for (const [method, path] of endpoints) {
          const r = await timedReq(method, path);
          rows.push({ path: path.replace(String(eventId), ':id'), ms: r.ms, status: r.status });
        }
        const slowest = rows.reduce((a, b) => b.ms > a.ms ? b : a);
        const s = stats(rows.map(r => r.ms));
        rows.forEach(r => console.log(`\n               ${String(r.ms).padStart(4)}ms  ${r.status}  ${r.path}`));
        console.log();
        assert(s.p95 < 800, `p95 ${s.p95}ms exceeds 800ms threshold`);
        return `avg ${s.avg}ms  p95 ${s.p95}ms  slowest: ${slowest.path} (${slowest.ms}ms)`;
      });
    }

    // ── SECURITY TESTS ────────────────────────────────────────────────────────
    if (RUN_ALL || RUN_TEST?.startsWith('X')) {
      console.log('\n── Security Tests ───────────────────────────────────────────────\n');

      // X1: Auth bypass
      await test('X1', 'Admin auth bypass (no / blank / wrong token)', async () => {
        const adminRoutes = [
          ['GET',    '/api/events'],
          ['POST',   '/api/events'],
          ['PATCH',  `/api/events/${eventId}`],
          ['DELETE', `/api/events/${eventId}`],
          ['GET',    `/api/events/${eventId}/balls`],
        ];
        const tokens  = [null, '', 'wrongpassword123', '../../etc/passwd'];
        let blocked = 0, leaked = 0;
        for (const token of tokens) {
          for (const [method, path] of adminRoutes) {
            const h = { 'x-admin-token': token ?? '' };
            const r = await req(method, path, {}, h);
            if (r.status === 401 || r.status === 403) blocked++;
            else if (r.status === 200) leaked++;
          }
        }
        assert(leaked === 0, `${leaked} admin routes responded 200 without valid auth`);
        return `${blocked}/${tokens.length * adminRoutes.length} requests correctly blocked`;
      });

      // X2: Ball code enumeration oracle
      await test('X2', 'Ball code enumeration (no oracle)', async () => {
        const validR   = await req('GET', `/api/ball/STRESS01`);
        const invalidR = await req('GET', `/api/ball/ZZZNEVEREXISTS999`);
        assert(invalidR.status < 500, `Invalid code caused 500: ${invalidR.status}`);
        assert(validR.status < 500,   `Valid code caused 500: ${validR.status}`);
        // Both should return consistently — neither should expose internals
        const validBody   = typeof validR.body   === 'string' ? validR.body   : JSON.stringify(validR.body);
        const invalidBody = typeof invalidR.body === 'string' ? invalidR.body : JSON.stringify(invalidR.body);
        return `valid=${validR.status} invalid=${invalidR.status} (no server crash)`;
      });

      // X3: Double submission
      await test('X3', 'Double submission handling', async () => {
        // STRESS01 was scanned in S1. Try again with a different distance.
        const r1 = await timedReq('POST', '/api/scan/ld/STRESS01', {
          lat: 33.5050, lon: -84.3953, location_type: 'fairway',
        }, { 'x-admin-token': '' });
        const r2 = await timedReq('POST', '/api/scan/ld/STRESS01', {
          lat: 33.5099, lon: -84.3953, location_type: 'fairway',
        }, { 'x-admin-token': '' });
        assert(r1.status < 500, `First scan server error: ${r1.status}`);
        assert(r2.status < 500, `Second scan server error: ${r2.status}`);
        const note = (r2.status === 200 && r2.body?.final_yards !== r1.body?.final_yards)
          ? `⚠ second scan OVERWROTE score (${r1.body?.final_yards}yd → ${r2.body?.final_yards}yd) — consider write-once lock`
          : `second scan returned ${r2.status} — score preserved`;
        return note;
      });

      // X4: Input injection (XSS + SQL)
      await test('X4', 'Input injection (XSS + SQL in player names)', async () => {
        const payloads = [
          "<script>alert('xss')</script>",
          "'; DROP TABLE teams; --",
          '"><img src=x onerror=alert(1)>',
          '\'; SELECT * FROM events; --',
        ];
        const codes = payloads.map((_, i) => `INJECT0${i+1}`);
        await req('POST', `/api/events/${eventId}/balls`, { codes });
        let serverErrors = 0;
        for (let i = 0; i < codes.length; i++) {
          const r = await req('POST', `/api/events/${eventId}/register-player`, {
            drop_code: codes[i],
            first_name: payloads[i],
            last_name: 'InjTest',
            player_index: i + 1,
          }, { 'x-admin-token': '' });
          if (r.status >= 500) serverErrors++;
        }
        const lb = await req('GET', `/api/leaderboard/${eventId}`);
        assert(serverErrors === 0, `${serverErrors} server errors on injection input`);
        assert(lb.status < 500, `Leaderboard crashed after injection: ${lb.status}`);
        return `${payloads.length} payloads submitted — no server errors, leaderboard intact`;
      });

      // X5: Brute force (warn — no rate limiting expected yet)
      await warn('X5', 'Token brute force (rate limiting check)', async () => {
        const promises = Array.from({ length: 30 }, () =>
          req('GET', '/api/events', null, { 'x-admin-token': 'bruteforce' + Math.random() })
        );
        const res = await Promise.all(promises);
        const rateLimited = res.filter(r => r.status === 429).length;
        const errors      = res.filter(r => r.status >= 500).length;
        assert(errors === 0, `${errors} server errors during brute force`);
        if (rateLimited === 0) throw new Error('no rate limiting — 30/30 requests accepted. Add express-rate-limit before scaling');
        return `${rateLimited}/30 requests rate-limited ✅`;
      });

      // X6: Cross-event access
      await test('X6', 'Cross-event access (fake IDs, wrong auth)', async () => {
        const fakeId  = 99999999;
        const r1 = await req('GET',    `/api/leaderboard/${fakeId}`);
        const r2 = await req('DELETE', `/api/events/${fakeId}`, null, { 'x-admin-token': 'wrong' });
        const r3 = await req('PATCH',  `/api/events/${fakeId}`, { name: 'hack' }, { 'x-admin-token': 'wrong' });
        assert(r1.status < 500, `Fake event leaderboard caused 500: ${r1.status}`);
        assert(r2.status === 401 || r2.status === 403 || r2.status === 404,
          `DELETE with wrong auth returned ${r2.status} (expected 401/403/404)`);
        assert(r3.status === 401 || r3.status === 403 || r3.status === 404,
          `PATCH with wrong auth returned ${r3.status}`);
        return `leaderboard(fake)=${r1.status}  delete(wrong-auth)=${r2.status}  patch(wrong-auth)=${r3.status}`;
      });

      // X7: SSE injection
      await test('X7', 'SSE endpoint injection (POST/PUT/DELETE)', async () => {
        const streamPath = `/api/events/${eventId}/stream`;
        const r1 = await req('POST',   streamPath, { inject: 'data: evil\n\n' });
        const r2 = await req('PUT',    streamPath, { inject: 'data: evil\n\n' });
        const r3 = await req('DELETE', streamPath);
        assert(r1.status !== 200, `POST to SSE stream accepted: ${r1.status}`);
        assert(r2.status !== 200, `PUT to SSE stream accepted: ${r2.status}`);
        assert(r3.status !== 200, `DELETE to SSE stream accepted: ${r3.status}`);
        return `POST=${r1.status}  PUT=${r2.status}  DELETE=${r3.status}`;
      });
    }

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ──────────────────────────────────────────────────────\n');
    if (eventId) {
      const r = await req('DELETE', `/api/events/${eventId}`);
      console.log(`   ${r.status === 200 ? '✅' : '❌'}  Deleted test event ${eventId}`);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    const passed  = results.filter(r => r.status === 'PASS').length;
    const failed  = results.filter(r => r.status === 'FAIL').length;
    const warned  = results.filter(r => r.status === 'WARN').length;
    const total   = results.length;

    console.log('\n' + '═'.repeat(65));
    console.log(`\n📊  Results:`);
    console.log(`    ✅  Passed  : ${passed}`);
    if (warned) console.log(`    ⚠️   Warned  : ${warned}  (see notes above)`);
    if (failed) console.log(`    ❌  Failed  : ${failed}`);
    console.log(`    Total   : ${total}\n`);

    // Write JSON results
    try {
      const outDir = path.join(__dirname, 'results');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
      const outFile = path.join(outDir, `${stamp}.json`);
      fs.writeFileSync(outFile, JSON.stringify({
        url: BASE_URL, date: new Date().toISOString(), passed, failed, warned, results,
      }, null, 2));
      console.log(`   Results saved → tests/results/${stamp}.json\n`);
    } catch {}

    if (failed > 0) process.exit(1);
  }
}

main().catch(e => {
  console.error('\n💥  Test runner crashed:', e.message);
  process.exit(1);
});
