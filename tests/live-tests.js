/**
 * JORD Golf — Live API Integration Tests
 * Requires the server to be running: npm run dev
 * Run: node tests/live-tests.js
 */
'use strict';

const http  = require('http');
const https = require('https');

let passed = 0, failed = 0, total = 0;

const ADMIN = (() => {
  try {
    const src = require('fs').readFileSync('.env', 'utf8');
    const m   = src.match(/^ADMIN_PASSWORD=(.+)$/m);
    return m ? m[1].trim() : 'jord2026';
  } catch { return 'jord2026'; }
})();

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function req(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type':  'application/json',
        'x-admin-token': ADMIN,
        ...extraHeaders,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, res => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────

async function test(name, fn) {
  total++;
  try   { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}\n      → ${e.message}`); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// ─── Tests ────────────────────────────────────────────────────────────────────

async function main() {
  let eventId = null;

  console.log('\n🌐 Live API Tests\n');

  // ── Mapbox token ────────────────────────────────────────────────────────────
  console.log('🗺️  Mapbox\n');

  await test('GET /api/config returns 200', async () => {
    const r = await req('GET', '/api/config');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('Mapbox token is set (maps will be blank without it)', async () => {
    const r = await req('GET', '/api/config');
    const t = r.body.mapbox_token || '';
    assert(t.length > 10, 'mapbox_token is empty — open mapbox.com, create a free account, copy your Public access token, and paste it into .env as MAPBOX_TOKEN=pk.ey...');
  });

  await test('Mapbox token starts with pk. (public token format)', async () => {
    const r = await req('GET', '/api/config');
    const t = r.body.mapbox_token || '';
    assert(t.startsWith('pk.'), `Token is "${t.slice(0, 20)}..." — must start with pk. (get one at mapbox.com → Tokens)`);
  });

  await test('Mapbox token is accepted by Mapbox API (live tile request)', async () => {
    const r  = await req('GET', '/api/config');
    const t  = r.body.mapbox_token || '';
    if (!t.startsWith('pk.')) throw new Error('Skip — token format invalid');
    const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12?access_token=${t}`;
    const status = await httpsGet(url).catch(() => { throw new Error('Could not reach Mapbox API — check internet connection'); });
    assert(status !== 401, 'Mapbox returned 401 Unauthorized — token is invalid or expired. Get a new one at mapbox.com → Tokens → Create a token');
    assert(status < 400,   `Mapbox returned HTTP ${status} — token may be invalid`);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  console.log('\n🔐 Auth\n');

  await test('GET /api/events returns 401 without token', async () => {
    const r = await req('GET', '/api/events', null, { 'x-admin-token': 'wrong' });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('GET /api/events returns 200 with correct password', async () => {
    const r = await req('GET', '/api/events');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body), 'Expected array');
  });

  // ── Server info ─────────────────────────────────────────────────────────────
  await test('GET /api/server-info returns localIP and port', async () => {
    const r = await req('GET', '/api/server-info');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.localIP, 'Missing localIP');
    assert(r.body.port,    'Missing port');
  });

  // ── Events CRUD ─────────────────────────────────────────────────────────────
  console.log('\n📅 Events\n');

  await test('POST /api/events creates event', async () => {
    const r = await req('POST', '/api/events', {
      name: '_JORD_AUTO_TEST_',
      venue: 'Test Course',
      starts_at: '2099-01-01T00:00:00',
      ends_at:   '2099-01-02T00:00:00',
      has_longest_drive: 1,
    });
    assert(r.status === 200, `Expected 200, got ${r.status} — ${JSON.stringify(r.body)}`);
    assert(r.body.id, 'Missing event id');
    eventId = r.body.id;
  });

  await test('GET /api/events/:id returns the created event', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('GET', `/api/events/${eventId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.name === '_JORD_AUTO_TEST_', `Wrong name: ${r.body.name}`);
  });

  await test('PATCH /api/events/:id updates a field', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('PATCH', `/api/events/${eventId}`, { venue: 'Updated Venue' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.venue === 'Updated Venue', 'Venue not updated');
  });

  await test('GET /api/events/:eventId/info works without auth (public)', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('GET', `/api/events/${eventId}/info`, null, { 'x-admin-token': '' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ── Tee boxes ───────────────────────────────────────────────────────────────
  console.log('\n⛳ Tee Boxes\n');

  let teeId = null;

  await test('POST /api/events/:id/tee-boxes creates tee box', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('POST', `/api/events/${eventId}/tee-boxes`, {
      name: "Men's", lat: 33.5031, lon: -84.3953, color: 'white',
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.id, 'Missing tee id');
    teeId = r.body.id;
  });

  await test('PATCH /api/tee-boxes/:id updates tee box', async () => {
    if (!teeId) throw new Error('No tee box');
    const r = await req('PATCH', `/api/tee-boxes/${teeId}`, { color: 'blue' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.color === 'blue', 'Color not updated');
  });

  // ── Ball pool ───────────────────────────────────────────────────────────────
  console.log('\n🎱 Ball Pool\n');

  await test('POST /api/events/:id/balls adds 4 codes', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('POST', `/api/events/${eventId}/balls`, {
      codes: ['AUTOTEST1','AUTOTEST2','AUTOTEST3','AUTOTEST4'],
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.added === 4, `Expected 4 added, got ${r.body.added}`);
  });

  await test('Duplicate codes rejected (not double-counted)', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('POST', `/api/events/${eventId}/balls`, {
      codes: ['AUTOTEST1'],
    });
    assert(r.body.added === 0 && r.body.dupes === 1, `Expected 0 added, 1 dupe — got ${JSON.stringify(r.body)}`);
  });

  await test('GET /api/events/:id/balls returns pool info', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('GET', `/api/events/${eventId}/balls`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.total === 4, `Expected 4 total, got ${r.body.total}`);
  });

  // ── Registration ─────────────────────────────────────────────────────────────
  console.log('\n📋 Registration\n');

  await test('Player can register with valid drop code', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('POST', `/api/events/${eventId}/register-player`, {
      drop_code: 'AUTOTEST1', first_name: 'Tiger', last_name: 'Auto',
      tee_box_id: teeId, player_index: 1,
    }, { 'x-admin-token': '' }); // no auth — registration is public
    assert(r.status === 200, `Expected 200, got ${r.status} — ${JSON.stringify(r.body)}`);
    assert(r.body.success, 'Expected success:true');
  });

  await test('Same drop code cannot be registered twice', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('POST', `/api/events/${eventId}/register-player`, {
      drop_code: 'AUTOTEST1', first_name: 'Dup', last_name: 'Test', player_index: 1,
    }, { 'x-admin-token': '' });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('All 4 players can register and team finalizes', async () => {
    if (!eventId) throw new Error('No test event');
    for (let i = 2; i <= 4; i++) {
      const r = await req('POST', `/api/events/${eventId}/register-player`, {
        drop_code: `AUTOTEST${i}`, first_name: `Player${i}`, last_name: 'Auto',
        tee_box_id: teeId, player_index: i,
      }, { 'x-admin-token': '' });
      assert(r.status === 200, `Player ${i} failed: ${JSON.stringify(r.body)}`);
    }
    const r = await req('POST', `/api/events/${eventId}/finalize-team`, {
      team_name: '_Auto Test Team_',
      drop_codes: ['AUTOTEST1','AUTOTEST2','AUTOTEST3','AUTOTEST4'],
    }, { 'x-admin-token': '' });
    assert(r.status === 200, `Expected 200, got ${r.status} — ${JSON.stringify(r.body)}`);
    assert(r.body.team_id, 'Missing team_id');
  });

  // ── Scanning ─────────────────────────────────────────────────────────────────
  console.log('\n📍 Scanning\n');

  await test('POST /api/scan/ld/:code records a fairway shot and returns yards', async () => {
    const r = await req('POST', '/api/scan/ld/AUTOTEST1', {
      lat: 33.5041, lon: -84.3953, location_type: 'fairway',
    }, { 'x-admin-token': '' });
    assert(r.status === 200, `Expected 200, got ${r.status} — ${JSON.stringify(r.body)}`);
    assert(r.body.final_yards > 0, `Expected yards > 0, got ${r.body.final_yards}`);
    assert(r.body.location_type === 'fairway', 'Wrong location_type');
  });

  await test('Shot without lat/lon returns 400', async () => {
    const r = await req('POST', '/api/scan/ld/AUTOTEST2', {
      location_type: 'fairway',
    }, { 'x-admin-token': '' });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  console.log('\n🏆 Leaderboard\n');

  await test('GET /api/leaderboard/:eventId returns 1 team with a score', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('GET', `/api/leaderboard/${eventId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.ld && r.body.ld.length === 1, `Expected 1 LD team, got ${r.body.ld?.length}`);
    assert(r.body.ld[0].total_yards > 0, 'Team score should be > 0 after scan');
  });

  await test('GET /api/dashboard/:eventId/:code returns player data', async () => {
    if (!eventId) throw new Error('No test event');
    const r = await req('GET', `/api/dashboard/${eventId}/AUTOTEST1`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.ball?.first_name === 'Tiger', `Wrong player: ${r.body.ball?.first_name}`);
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  console.log('\n🧹 Cleanup\n');

  await test('DELETE /api/events/:id removes the test event', async () => {
    if (!eventId) throw new Error('No test event to delete');
    const r = await req('DELETE', `/api/events/${eventId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    eventId = null;
  });

  await test('Deleted event returns 404', async () => {
    const id = 'EVTDOESNOTEXIST';
    const r  = await req('GET', `/api/events/${id}`);
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(52));
  console.log(`\n📊  ${passed}/${total} live tests  |  ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch(e => {
  console.error('\n💥 Live tests crashed — is the server running?\n');
  console.error('   Run: npm run dev   (in a separate terminal)\n');
  console.error('   Error:', e.message, '\n');
  process.exit(1);
});
