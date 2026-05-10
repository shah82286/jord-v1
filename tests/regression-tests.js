/**
 * JORD Golf — Regression Test Suite
 *
 * Tests that pin known bugs from CHANGELOG so they don't come back.
 * Pure-logic tests only — no server, no DOM, no Mapbox.
 * Run: node tests/regression-tests.js
 */
'use strict';

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}\n      → ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'Mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  JORD Golf — Regression Tests');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

/* ─────────────────────────────────────────────────────────────────────
 * Bug: QR team code parameter parsing
 * Where: public/js/jord.js:281 (JORD.qs)
 * Symptom: team code from QR-scanned URL not picked up on /register/:eventId
 *
 * Mirrors the production implementation:
 *   APP.qs = function (key, fallback = '') {
 *     return new URL(window.location.href).searchParams.get(key) || fallback;
 *   };
 * ─────────────────────────────────────────────────────────────────── */

console.log('QR team code parameter (JORD.qs)');

function qsFromHref(href, key, fallback = '') {
  return new URL(href).searchParams.get(key) || fallback;
}

test('reads ?team=ABC123 from a register URL', () => {
  const url = 'http://localhost:3000/register/evt_xyz?team=ABC123';
  assertEqual(qsFromHref(url, 'team'), 'ABC123');
});

test('returns fallback when team param missing', () => {
  const url = 'http://localhost:3000/register/evt_xyz';
  assertEqual(qsFromHref(url, 'team', ''), '');
});

test('returns empty string when team= present but blank', () => {
  const url = 'http://localhost:3000/register/evt_xyz?team=';
  // URL decodes empty as '' which is falsy — fallback kicks in
  assertEqual(qsFromHref(url, 'team', 'FALLBACK'), 'FALLBACK');
});

test('handles team param alongside other params', () => {
  const url = 'http://localhost:3000/register/evt_xyz?source=qr&team=ZULU99&utm=x';
  assertEqual(qsFromHref(url, 'team'), 'ZULU99');
});

test('handles URL-encoded team code', () => {
  const url = 'http://localhost:3000/register/evt?team=A%2BB%3D';
  assertEqual(qsFromHref(url, 'team'), 'A+B=');
});

test('hash fragment does not interfere', () => {
  const url = 'http://localhost:3000/register/evt?team=HASH123#section';
  assertEqual(qsFromHref(url, 'team'), 'HASH123');
});

test('matches the QR-builder URL format from register.html', () => {
  // register.html line 232: window.location.origin + '/register/' + eid + '?team=' + teamCode;
  const eid = 'evt_2026_05_09';
  const teamCode = 'NEON77';
  const builtUrl = 'http://localhost:3000/register/' + eid + '?team=' + teamCode;
  assertEqual(qsFromHref(builtUrl, 'team'), teamCode);
});

/* ─────────────────────────────────────────────────────────────────────
 * Bug: undefined `tees` ReferenceError (defensive guard)
 * Where: public/admin.html:1275 (filter on currentEvent.tee_boxes)
 * Symptom: ReferenceError when tee_boxes shape was unexpected
 *
 * Note: I could not locate the exact original bug in CHANGELOG, so this
 * test guards the data-shape assumptions of the production filter rather
 * than reproducing a specific historical failure.
 * ─────────────────────────────────────────────────────────────────── */

console.log('\nTee box filter (admin.html distance display)');

// Mirrors admin.html:1275–1277 exactly
function filterTees(currentEvent, isLd) {
  return (currentEvent.tee_boxes || []).filter(t =>
    isLd ? t.hole_type !== 'closest_pin' : t.hole_type === 'closest_pin'
  );
}

test('handles undefined tee_boxes without throwing', () => {
  const result = filterTees({}, true);
  assertEqual(result.length, 0);
});

test('handles null tee_boxes without throwing', () => {
  const result = filterTees({ tee_boxes: null }, true);
  assertEqual(result.length, 0);
});

test('handles empty tee_boxes array', () => {
  const result = filterTees({ tee_boxes: [] }, true);
  assertEqual(result.length, 0);
});

test('LD tab filters out closest_pin tees', () => {
  const event = {
    tee_boxes: [
      { name: 'Blue', hole_type: 'longest_drive' },
      { name: 'Red', hole_type: 'closest_pin' },
      { name: 'White', hole_type: null },
    ],
  };
  const ld = filterTees(event, true);
  assertEqual(ld.length, 2);
  assert(ld.every(t => t.hole_type !== 'closest_pin'), 'no CTP tees in LD result');
});

test('CTP tab keeps only closest_pin tees', () => {
  const event = {
    tee_boxes: [
      { name: 'Blue', hole_type: 'longest_drive' },
      { name: 'Red', hole_type: 'closest_pin' },
      { name: 'Gold', hole_type: 'closest_pin' },
    ],
  };
  const ctp = filterTees(event, false);
  assertEqual(ctp.length, 2);
  assert(ctp.every(t => t.hole_type === 'closest_pin'), 'only CTP tees in CTP result');
});

test('LD tab includes tees with missing hole_type (legacy data)', () => {
  // Legacy events may have tee_boxes without hole_type set
  const event = {
    tee_boxes: [
      { name: 'Legacy1' },
      { name: 'Legacy2', hole_type: undefined },
    ],
  };
  const ld = filterTees(event, true);
  assertEqual(ld.length, 2, 'legacy tees default to LD');
});

/* ─────────────────────────────────────────────────────────────────────
 * Feature: Accuracy-aware zone detection
 * Where: public/scan.html (replaces detectZone for the auto-lock decision)
 * Spec:
 *   - Take GPS accuracy (meters) as input.
 *   - Return { zone, nearBoundary, distToEdgeM }.
 *   - nearBoundary = distance from point to its containing zone's edge < accuracyM.
 *   - For 'oob_outside', nearBoundary = distance to nearest mapped zone < accuracyM
 *     (ball might actually be in rough/fairway, GPS just drifted).
 *   - UI uses nearBoundary to skip the hard auto-lock when reading is unreliable.
 * ─────────────────────────────────────────────────────────────────── */

console.log('\nAccuracy-aware zone detection');

// Fixture: ~280m × 311m fairway. Edges run N-S and E-W in lat/lon.
const FAIRWAY_GEOM = {
  type: 'Polygon',
  coordinates: [[
    [-84.3968, 33.5030],
    [-84.3938, 33.5030],
    [-84.3938, 33.5058],
    [-84.3968, 33.5058],
    [-84.3968, 33.5030],
  ]],
};
// Rough wraps fairway with ~50m buffer
const ROUGH_GEOM = {
  type: 'Polygon',
  coordinates: [[
    [-84.3973, 33.5025],
    [-84.3933, 33.5025],
    [-84.3933, 33.5063],
    [-84.3973, 33.5063],
    [-84.3973, 33.5025],
  ]],
};

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointInRing(lat, lon, geom) {
  if (!geom || geom.type !== 'Polygon') return false;
  const ring = geom.coordinates[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function distToEdgeMeters(lat, lon, geom) {
  if (!geom || geom.type !== 'Polygon') return Infinity;
  const ring = geom.coordinates[0];
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i], [lon2, lat2] = ring[i + 1];
    const dx = lon2 - lon1, dy = lat2 - lat1, lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((lon - lon1) * dx + (lat - lat1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const d = haversineMeters(lat, lon, lat1 + t * dy, lon1 + t * dx);
    if (d < min) min = d;
  }
  return min;
}

// Pure function — copy of what will land in scan.html
function detectZoneWithConfidence(lat, lon, accuracyM, polygons) {
  if (!polygons) return { zone: null, nearBoundary: false, distToEdgeM: Infinity };
  const { fairway, rough, oob } = polygons;
  const hasAny = fairway || rough || oob;
  if (!hasAny) return { zone: null, nearBoundary: false, distToEdgeM: Infinity };

  const checks = [
    { key: 'fairway', geom: fairway },
    { key: 'rough', geom: rough },
    { key: 'oob', geom: oob },
  ];

  for (const c of checks) {
    if (c.geom && pointInRing(lat, lon, c.geom)) {
      const d = distToEdgeMeters(lat, lon, c.geom);
      return { zone: c.key, nearBoundary: d < accuracyM, distToEdgeM: d };
    }
  }

  let nearest = Infinity;
  for (const c of checks) {
    if (!c.geom) continue;
    const d = distToEdgeMeters(lat, lon, c.geom);
    if (d < nearest) nearest = d;
  }
  return { zone: 'oob_outside', nearBoundary: nearest < accuracyM, distToEdgeM: nearest };
}

const POLYS = { fairway: FAIRWAY_GEOM, rough: ROUGH_GEOM, oob: null };

test('center of fairway, ±3m: high confidence', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3953, 3, POLYS);
  assertEqual(r.zone, 'fairway');
  assertEqual(r.nearBoundary, false);
});

test('5m inside east fairway edge, ±10m: nearBoundary true', () => {
  const lonNearEdge = -84.3938 - 0.00005;
  const r = detectZoneWithConfidence(33.5044, lonNearEdge, 10, POLYS);
  assertEqual(r.zone, 'fairway');
  assertEqual(r.nearBoundary, true);
});

test('5m inside east fairway edge, ±2m: nearBoundary false', () => {
  const lonNearEdge = -84.3938 - 0.00005;
  const r = detectZoneWithConfidence(33.5044, lonNearEdge, 2, POLYS);
  assertEqual(r.zone, 'fairway');
  assertEqual(r.nearBoundary, false);
});

test('100m past rough: oob_outside, high confidence', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3920, 5, POLYS);
  assertEqual(r.zone, 'oob_outside');
  assertEqual(r.nearBoundary, false);
});

test('3m past rough east edge, ±15m: oob_outside but uncertain', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3933 + 0.00003, 15, POLYS);
  assertEqual(r.zone, 'oob_outside');
  assertEqual(r.nearBoundary, true);
});

test('no polygons: returns null', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3953, 3, { fairway: null, rough: null, oob: null });
  assertEqual(r.zone, null);
});

test('null polygons arg: returns null', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3953, 3, null);
  assertEqual(r.zone, null);
});

test('extreme accuracy (±200m) flags fairway-center as nearBoundary', () => {
  // Fairway center sits ~116m from east/west edges; ±200m accuracy swallows that
  const r = detectZoneWithConfidence(33.5044, -84.3953, 200, POLYS);
  assertEqual(r.zone, 'fairway');
  assertEqual(r.nearBoundary, true);
});

test('point in rough ring (between fairway and outer rough edge): rough', () => {
  const r = detectZoneWithConfidence(33.5044, -84.3935, 3, POLYS);
  assertEqual(r.zone, 'rough');
});

/* ─── Summary ─────────────────────────────────────────────────────── */

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed ? 1 : 0);
