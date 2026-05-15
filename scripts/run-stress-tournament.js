/**
 * Run "The Dancing Hockey Guys Classic" — fires 144 simulated LD shots
 * against the live API over ~2 minutes (fast playback).
 *
 * Stress-tests the real pipeline: HTTP → /api/scan/ld → DB write → SSE broadcast →
 * leaderboard recompute → Klaviyo enqueue (non-blocking).
 *
 * Reads tee box, pin, and zone polygons from the DB to generate realistic
 * shot coordinates relative to the actual hole layout you mapped in the admin UI.
 *
 * Run: node scripts/run-stress-tournament.js
 *      node scripts/run-stress-tournament.js --url http://localhost:3000
 *      node scripts/run-stress-tournament.js --duration 30  (seconds)
 */

const http     = require('http');
const https    = require('https');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { URL }  = require('url');

// ── Config ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : null; };

const BASE_URL = getArg('--url') || 'http://localhost:3000';
const DURATION_S = parseInt(getArg('--duration') || '120', 10);
const TOURNAMENT_NAME = 'The Dancing Hockey Guys Classic';

// Realistic shot mix (sums to 1)
const MIX = { fairway: 0.65, rough: 0.22, oob: 0.10, lost: 0.03 };
// Realistic LD distance: rec golfers, normal-ish around 240, std 35, clamp 150..320
const DIST = { mean: 240, stdev: 35, min: 150, max: 320 };

// ── DB lookup ───────────────────────────────────────────────────────────────
const env = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim();
  });
} catch {}
const DB_PATH = env.DB_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jord.db');
const db = new Database(DB_PATH, { readonly: true });

const event = db.prepare(`SELECT * FROM events WHERE name=? ORDER BY created_at DESC LIMIT 1`).get(TOURNAMENT_NAME);
if (!event) {
  console.error(`\n❌  Event "${TOURNAMENT_NAME}" not found. Run scripts/seed-stress-tournament.js first.\n`);
  process.exit(1);
}
if (event.status !== 'active') {
  console.error(`\n❌  Event status is "${event.status}". Open admin, click "Start tournament", then re-run.\n`);
  process.exit(1);
}

const teeBox = db.prepare(`SELECT * FROM tee_boxes WHERE event_id=? AND hole_type='longest_drive' LIMIT 1`).get(event.id);
if (!teeBox) {
  console.error(`\n❌  No tee box configured for event ${event.id}. Add one in admin → Course Map.\n`);
  process.exit(1);
}
if (event.pin_lat == null || event.pin_lon == null) {
  console.error(`\n❌  No pin placed for event ${event.id}. Place one in admin → Course Map.\n`);
  process.exit(1);
}

const balls = db.prepare(`
  SELECT drop_code, first_name, last_name, team_id
  FROM balls WHERE event_id=? AND team_id IS NOT NULL
  ORDER BY drop_code
`).all(event.id);
if (!balls.length) {
  console.error(`\n❌  No registered players found.\n`);
  process.exit(1);
}

console.log(`\n🏌️  Stress run: ${event.name}`);
console.log(`   Event ID    : ${event.id}`);
console.log(`   Tee box     : ${teeBox.lat.toFixed(6)}, ${teeBox.lon.toFixed(6)}`);
console.log(`   Pin         : ${event.pin_lat.toFixed(6)}, ${event.pin_lon.toFixed(6)}`);
console.log(`   Players     : ${balls.length}`);
console.log(`   Duration    : ${DURATION_S}s  (~${(balls.length / DURATION_S).toFixed(1)} shots/sec avg)`);
console.log(`   Mix         : ${(MIX.fairway*100)|0}% fwy / ${(MIX.rough*100)|0}% rough / ${(MIX.oob*100)|0}% oob / ${(MIX.lost*100)|0}% lost`);
console.log(`   Target      : ${BASE_URL}`);
console.log('═'.repeat(64) + '\n');

// ── Polygon parsing + ray-cast point-in-polygon ────────────────────────────
function parsePolys(jsonStr) {
  if (!jsonStr) return [];
  try {
    const g = JSON.parse(jsonStr);
    if (g.type === 'Polygon')           return [g.coordinates];
    if (g.type === 'MultiPolygon')      return g.coordinates;
    if (g.type === 'Feature')           return parsePolys(JSON.stringify(g.geometry));
    if (g.type === 'FeatureCollection') return g.features.flatMap(f => parsePolys(JSON.stringify(f.geometry)));
  } catch {}
  return [];
}
// polygon = array of rings, ring = array of [lon,lat]
function pointInPoly(lon, lat, polygon) {
  let inside = false;
  for (const ring of polygon) {
    let rIn = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersects = ((yi > lat) !== (yj > lat)) &&
                         (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersects) rIn = !rIn;
    }
    if (rIn) inside = !inside; // first ring outer, rest holes — XOR handles holes
  }
  return inside;
}

const fwyPolys = parsePolys(event.fairway_polygon);
const rufPolys = parsePolys(event.rough_polygon);
const oobPolys = parsePolys(event.oob_polygon);

function classify(lon, lat) {
  if (oobPolys.some(p => pointInPoly(lon, lat, p))) return 'oob';
  if (fwyPolys.some(p => pointInPoly(lon, lat, p))) return 'fairway';
  if (rufPolys.some(p => pointInPoly(lon, lat, p))) return 'rough';
  return null; // outside all mapped zones
}

// ── Geo math ─────────────────────────────────────────────────────────────────
const R_EARTH_M = 6371000;
const YARDS_PER_M = 1.0936133;
const M_PER_YARD = 1 / YARDS_PER_M;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

// Bearing tee → pin in radians
function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return Math.atan2(y, x);
}
// Project from (lat,lon) along bearing+distance (meters) → new (lat,lon)
function project(lat, lon, bearingRad, distM) {
  const φ1 = toRad(lat), λ1 = toRad(lon);
  const δ  = distM / R_EARTH_M;
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(bearingRad));
  const λ2 = λ1 + Math.atan2(Math.sin(bearingRad)*Math.sin(δ)*Math.cos(φ1),
                              Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2)+540)%360)-180 };
}

const TEE_TO_PIN_BEARING = bearing(teeBox.lat, teeBox.lon, event.pin_lat, event.pin_lon);

// ── Random helpers ───────────────────────────────────────────────────────────
function randNormal(mean, stdev) {
  const u = 1 - Math.random(), v = Math.random();
  return mean + stdev * Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pickIntent() {
  const r = Math.random();
  let acc = 0;
  for (const [k, w] of Object.entries(MIX)) { acc += w; if (r <= acc) return k; }
  return 'fairway';
}

// Build a shot for a ball: yards + bearing offset → lat/lon → location_type
function buildShot() {
  const intent = pickIntent();          // what kind of shot we're TRYING to simulate
  const yards  = clamp(randNormal(DIST.mean, DIST.stdev), DIST.min, DIST.max);
  // Angular offset (degrees off the tee→pin line). Tighter for fairway-like.
  const offsetDeg = intent === 'fairway' ? randNormal(0, 4)
                  : intent === 'rough'   ? (Math.random() < 0.5 ? -1 : 1) * (6 + Math.abs(randNormal(0, 4)))
                  : intent === 'oob'     ? (Math.random() < 0.5 ? -1 : 1) * (12 + Math.abs(randNormal(0, 5)))
                  :                        (Math.random() < 0.5 ? -1 : 1) * (18 + Math.abs(randNormal(0, 6)));
  const distM = yards * M_PER_YARD;
  const b = TEE_TO_PIN_BEARING + toRad(offsetDeg);
  const { lat, lon } = project(teeBox.lat, teeBox.lon, b, distM);
  // Detect actual zone from polygons — if mapped, use that; else fall back to intent.
  const detected = classify(lon, lat);
  const location_type = detected || intent;
  return { lat, lon, location_type, target_yards: Math.round(yards) };
}

// ── HTTP client ──────────────────────────────────────────────────────────────
function postScan(code, body) {
  return new Promise(resolve => {
    const u = new URL(`/api/scan/ld/${code}`, BASE_URL);
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const r = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, ms: Date.now() - t0 });
      });
    });
    r.on('error', err => resolve({ status: 0, body: { error: err.message }, ms: Date.now() - t0 }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, body: { error: 'timeout' }, ms: 15000 }); });
    r.write(data);
    r.end();
  });
}

// ── Schedule + run ───────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  // Random firing time within window for each ball
  const schedule = balls.map(b => ({
    ball: b,
    fireAt: Math.random() * DURATION_S * 1000,
    shot: buildShot(),
  })).sort((a, b) => a.fireAt - b.fireAt);

  const results = [];
  let inflight = 0, peak = 0, done = 0;

  process.stdout.write('   Firing shots... ');

  await Promise.all(schedule.map(({ ball, fireAt, shot }) => new Promise(resolve => {
    setTimeout(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      const r = await postScan(ball.drop_code, {
        lat: shot.lat, lon: shot.lon, location_type: shot.location_type,
      });
      inflight--;
      done++;
      results.push({
        code: ball.drop_code,
        player: `${ball.first_name} ${ball.last_name}`,
        target_yards: shot.target_yards,
        intent_loc: shot.location_type,
        status: r.status,
        ms: r.ms,
        body: r.body,
      });
      if (done % 12 === 0) process.stdout.write(`${done} `);
      resolve();
    }, fireAt);
  })));

  const totalMs = Date.now() - startedAt;
  console.log(`\n\n   All ${done} shots completed in ${(totalMs/1000).toFixed(1)}s  (peak inflight: ${peak})`);

  // ── Summary ────────────────────────────────────────────────────────────────
  const ok      = results.filter(r => r.status === 200);
  const fails   = results.filter(r => r.status !== 200);
  const times   = results.map(r => r.ms).sort((a,b) => a-b);
  const avg     = (times.reduce((a,b)=>a+b,0) / times.length) | 0;
  const p50     = times[Math.floor(times.length*0.50)];
  const p95     = times[Math.floor(times.length*0.95)];
  const p99     = times[Math.floor(times.length*0.99)];
  const max     = times[times.length-1];

  const byZone  = {};
  ok.forEach(r => { byZone[r.body.location_type] = (byZone[r.body.location_type] || 0) + 1; });
  const yardages = ok.map(r => r.body.final_yards).sort((a,b) => b-a);
  const top5    = yardages.slice(0, 5);

  console.log('\n' + '═'.repeat(64));
  console.log('   RESULTS');
  console.log('═'.repeat(64));
  console.log(`   Success           : ${ok.length}/${results.length}  (${((ok.length/results.length)*100).toFixed(1)}%)`);
  if (fails.length) {
    console.log(`   Failures          : ${fails.length}`);
    const grouped = {};
    fails.forEach(f => {
      const key = `${f.status} ${typeof f.body === 'object' ? f.body.error || JSON.stringify(f.body) : f.body}`;
      grouped[key] = (grouped[key] || 0) + 1;
    });
    Object.entries(grouped).forEach(([k, n]) => console.log(`     ${n}× ${k}`));
  }
  console.log();
  console.log(`   Latency avg       : ${avg}ms`);
  console.log(`   Latency p50       : ${p50}ms`);
  console.log(`   Latency p95       : ${p95}ms`);
  console.log(`   Latency p99       : ${p99}ms`);
  console.log(`   Latency max       : ${max}ms`);
  console.log();
  console.log(`   Shot distribution :`);
  Object.entries(byZone).forEach(([k, n]) => console.log(`     ${k.padEnd(8)} ${n}  (${((n/ok.length)*100).toFixed(0)}%)`));
  console.log();
  console.log(`   Top 5 drives      : ${top5.join(', ')} yd`);
  console.log();
  console.log(`   Leaderboard: ${BASE_URL}/leaderboard/${event.id}`);
  console.log(`   Monitor    : ${BASE_URL}/monitor/${event.id}\n`);

  // Write detailed results
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'tests', 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `stress-tournament-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    event_id: event.id, base_url: BASE_URL, started_at: new Date(startedAt).toISOString(),
    duration_ms: totalMs, peak_inflight: peak,
    summary: { ok: ok.length, fail: fails.length, avg, p50, p95, p99, max, byZone },
    results,
  }, null, 2));
  console.log(`   Detailed results saved → tests/results/stress-tournament-${stamp}.json\n`);
}

main().catch(e => { console.error('💥', e); process.exit(1); });
