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

/* ─────────────────────────────────────────────────────────────────────
 * Feature: Inbound tournament request management (super admin)
 * Where: server.js (helpers below mirror server-side implementations)
 * ─────────────────────────────────────────────────────────────────── */

console.log('\nInbound tournament requests');

// Status state machine — must match server.js
function canTransitionStatus(from, to) {
  const valid = {
    pending:  new Set(['accepted', 'rejected', 'replied']),
    replied:  new Set(['accepted', 'rejected', 'pending']),
    accepted: new Set(['rejected']),
    rejected: new Set(['pending']),
  };
  return valid[from]?.has(to) === true;
}

// Request → event-draft mapper
function requestToEventDraft(r) {
  if (!r || !r.tournament_name || !r.event_date) return null;
  const ct = (r.contest_type || '').toLowerCase();
  return {
    name: r.tournament_name,
    venue: r.venue || null,
    starts_at: r.event_date + 'T08:00:00',
    ends_at: r.event_date + 'T18:00:00',
    has_longest_drive: ct === 'ld' || ct === 'both' ? 1 : 0,
    has_closest_pin:   ct === 'ctp' || ct === 'both' ? 1 : 0,
    admin_phone: r.admin_phone || null,
    venue_lat: Number.isFinite(r.venue_lat) ? r.venue_lat : null,
    venue_lon: Number.isFinite(r.venue_lon) ? r.venue_lon : null,
  };
}

// Email template renderer
const REQUEST_EMAIL_TEMPLATES = {
  welcome: (r) => ({
    subject: `Re: ${r.tournament_name} — Welcome to JORD Golf`,
    body: `Hi ${r.admin_name},\n\nThanks for signing up ${r.tournament_name} at ${r.venue}. We are excited to set up live scoring for your event on ${r.event_date}.\n\nNext steps will follow shortly.\n\n— JORD Golf Team`,
  }),
  more_info: (r) => ({
    subject: `Re: ${r.tournament_name} — A few more details`,
    body: `Hi ${r.admin_name},\n\nThanks for the request. Could you share a bit more about ${r.tournament_name}?\n\n- Confirmed start time on ${r.event_date}?\n- Format details (4-player teams, scramble, etc.)?\n- Any sponsors who need branding on the leaderboard?\n\n— JORD Golf Team`,
  }),
  pricing: (r) => ({
    subject: `Re: ${r.tournament_name} — Pricing`,
    body: `Hi ${r.admin_name},\n\nFor ${r.expected_players} players at ${r.venue} on ${r.event_date}, here is our pricing:\n\n[pricing details here]\n\nLet us know if you would like to move forward.\n\n— JORD Golf Team`,
  }),
  reject: (r) => ({
    subject: `Re: ${r.tournament_name}`,
    body: `Hi ${r.admin_name},\n\nThank you for your interest in JORD Golf for ${r.tournament_name}. Unfortunately we are unable to support this event at this time.\n\n— JORD Golf Team`,
  }),
};

function renderEmailTemplate(key, request) {
  const fn = REQUEST_EMAIL_TEMPLATES[key];
  if (!fn) return null;
  return fn(request);
}

// Edit validator — only allow listed fields, sanitize types
function validateRequestPatch(input) {
  const allowed = ['tournament_name', 'event_date', 'venue', 'location', 'contest_type', 'expected_players', 'admin_name', 'admin_email', 'admin_phone', 'notes', 'status', 'event_url', 'venue_lat', 'venue_lon'];
  const out = {};
  for (const k of allowed) {
    if (input[k] === undefined) continue;
    if (k === 'expected_players') {
      const n = parseInt(input[k], 10);
      if (Number.isNaN(n) || n < 1) throw new Error('expected_players must be a positive integer');
      out[k] = n;
    } else if (k === 'admin_email') {
      const v = String(input[k]).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('admin_email must be a valid email');
      out[k] = v;
    } else if (k === 'contest_type') {
      const v = String(input[k]).toLowerCase();
      if (!['ld', 'ctp', 'both'].includes(v)) throw new Error('contest_type must be ld | ctp | both');
      out[k] = v;
    } else if (k === 'status') {
      const v = String(input[k]).toLowerCase();
      if (!['pending', 'accepted', 'rejected', 'replied'].includes(v)) throw new Error('invalid status');
      out[k] = v;
    } else if (k === 'event_url') {
      const v = String(input[k]).trim();
      if (v && !/^https?:\/\//i.test(v)) throw new Error('event_url must start with http:// or https://');
      out[k] = v || null;
    } else if (k === 'venue_lat' || k === 'venue_lon') {
      if (input[k] === null || input[k] === '') { out[k] = null; continue; }
      const n = parseFloat(input[k]);
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      out[k] = n;
    } else {
      out[k] = String(input[k]).trim();
    }
  }
  return out;
}

/* Status transitions */
test('pending → accepted is allowed', () => assert(canTransitionStatus('pending', 'accepted')));
test('pending → rejected is allowed', () => assert(canTransitionStatus('pending', 'rejected')));
test('pending → replied is allowed', () => assert(canTransitionStatus('pending', 'replied')));
test('accepted → rejected is allowed (revoke)', () => assert(canTransitionStatus('accepted', 'rejected')));
test('accepted → pending is NOT allowed', () => assert(!canTransitionStatus('accepted', 'pending')));
test('rejected → accepted is NOT allowed (must reset to pending first)', () => assert(!canTransitionStatus('rejected', 'accepted')));
test('rejected → pending is allowed (re-open)', () => assert(canTransitionStatus('rejected', 'pending')));
test('unknown status returns false', () => assert(!canTransitionStatus('weird', 'pending')));

/* Request → event mapper */
const SAMPLE_REQ = {
  tournament_name: 'Spring Open 2026',
  event_date: '2026-06-15',
  venue: 'Pebble Hills GC',
  location: 'Austin, TX',
  contest_type: 'both',
  expected_players: 48,
  admin_name: 'Jane Smith',
  admin_email: 'jane@example.com',
  admin_phone: '512-555-0100',
  notes: 'Sponsor banners requested',
};

test('mapper: contest_type=both sets both flags', () => {
  const e = requestToEventDraft(SAMPLE_REQ);
  assertEqual(e.has_longest_drive, 1);
  assertEqual(e.has_closest_pin, 1);
});
test('mapper: contest_type=ld sets only LD', () => {
  const e = requestToEventDraft({ ...SAMPLE_REQ, contest_type: 'ld' });
  assertEqual(e.has_longest_drive, 1);
  assertEqual(e.has_closest_pin, 0);
});
test('mapper: contest_type=ctp sets only CTP', () => {
  const e = requestToEventDraft({ ...SAMPLE_REQ, contest_type: 'ctp' });
  assertEqual(e.has_longest_drive, 0);
  assertEqual(e.has_closest_pin, 1);
});
test('mapper: derives starts_at + ends_at from event_date', () => {
  const e = requestToEventDraft(SAMPLE_REQ);
  assertEqual(e.starts_at, '2026-06-15T08:00:00');
  assertEqual(e.ends_at,   '2026-06-15T18:00:00');
});
test('mapper: passes through name + venue + admin_phone', () => {
  const e = requestToEventDraft(SAMPLE_REQ);
  assertEqual(e.name, 'Spring Open 2026');
  assertEqual(e.venue, 'Pebble Hills GC');
  assertEqual(e.admin_phone, '512-555-0100');
});
test('mapper: returns null when required fields missing', () => {
  assertEqual(requestToEventDraft({}), null);
  assertEqual(requestToEventDraft(null), null);
});

/* Email templates */
test('welcome template merges name + venue + date', () => {
  const t = renderEmailTemplate('welcome', SAMPLE_REQ);
  assert(t.subject.includes('Spring Open 2026'));
  assert(t.body.includes('Jane Smith'));
  assert(t.body.includes('Pebble Hills GC'));
  assert(t.body.includes('2026-06-15'));
});
test('pricing template includes player count', () => {
  const t = renderEmailTemplate('pricing', SAMPLE_REQ);
  assert(t.body.includes('48 players'));
});
test('reject template uses tournament name in subject', () => {
  const t = renderEmailTemplate('reject', SAMPLE_REQ);
  assert(t.subject.includes('Spring Open 2026'));
});
test('unknown template returns null', () => {
  assertEqual(renderEmailTemplate('does_not_exist', SAMPLE_REQ), null);
});

/* Edit validator */
test('validator strips disallowed fields', () => {
  const out = validateRequestPatch({ tournament_name: 'X', id: 99, hacker_field: 'y' });
  assertEqual(out.id, undefined);
  assertEqual(out.hacker_field, undefined);
  assertEqual(out.tournament_name, 'X');
});
test('validator rejects bad email', () => {
  let threw = false;
  try { validateRequestPatch({ admin_email: 'not-an-email' }); } catch { threw = true; }
  assert(threw, 'should have thrown on bad email');
});
test('validator coerces expected_players to int', () => {
  const out = validateRequestPatch({ expected_players: '42' });
  assertEqual(out.expected_players, 42);
});
test('validator rejects expected_players < 1', () => {
  let threw = false;
  try { validateRequestPatch({ expected_players: 0 }); } catch { threw = true; }
  assert(threw);
});
test('validator rejects unknown contest_type', () => {
  let threw = false;
  try { validateRequestPatch({ contest_type: 'soccer' }); } catch { threw = true; }
  assert(threw);
});
test('validator accepts contest_type ld/ctp/both case-insensitive', () => {
  assertEqual(validateRequestPatch({ contest_type: 'BOTH' }).contest_type, 'both');
  assertEqual(validateRequestPatch({ contest_type: 'Ld' }).contest_type, 'ld');
});
test('validator rejects unknown status', () => {
  let threw = false;
  try { validateRequestPatch({ status: 'maybe' }); } catch { threw = true; }
  assert(threw);
});

/* event_url + venue coords */
test('validator accepts https event_url', () => {
  const out = validateRequestPatch({ event_url: 'https://example.com/tournament' });
  assertEqual(out.event_url, 'https://example.com/tournament');
});
test('validator accepts http event_url', () => {
  const out = validateRequestPatch({ event_url: 'http://example.com' });
  assertEqual(out.event_url, 'http://example.com');
});
test('validator rejects event_url without protocol', () => {
  let threw = false;
  try { validateRequestPatch({ event_url: 'example.com' }); } catch { threw = true; }
  assert(threw, 'should reject bare domain');
});
test('validator nulls empty event_url', () => {
  const out = validateRequestPatch({ event_url: '' });
  assertEqual(out.event_url, null);
});
test('validator coerces venue_lat/lon to number', () => {
  const out = validateRequestPatch({ venue_lat: '33.5044', venue_lon: '-84.3953' });
  assertEqual(out.venue_lat, 33.5044);
  assertEqual(out.venue_lon, -84.3953);
});
test('validator rejects non-numeric venue_lat', () => {
  let threw = false;
  try { validateRequestPatch({ venue_lat: 'abc' }); } catch { threw = true; }
  assert(threw);
});
test('mapper passes venue coords through when present', () => {
  const e = requestToEventDraft({ ...SAMPLE_REQ, venue_lat: 33.5, venue_lon: -84.4 });
  assertEqual(e.venue_lat, 33.5);
  assertEqual(e.venue_lon, -84.4);
});
test('mapper sets venue coords to null when absent', () => {
  const e = requestToEventDraft(SAMPLE_REQ);
  assertEqual(e.venue_lat, null);
  assertEqual(e.venue_lon, null);
});

/* ─── Summary ─────────────────────────────────────────────────────── */

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed ? 1 : 0);
