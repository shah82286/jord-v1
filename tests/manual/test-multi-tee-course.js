// E2E: a personal user can POST a new course with multiple tee boxes
// (the old form only sent one). Each tee should have its own per-hole
// yardages + rating/slope.
const BASE = 'http://localhost:3000';

(async () => {
  const email = `tee-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tee Tester', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  console.log('[1] signed up as personal user');

  // Build 4 tees with realistic numbers. Par + SI shared across tees;
  // yardages decline as we move to forward tees.
  const parSi = Array.from({length: 18}, (_, i) => ({
    par: [4,5,3,4,4,4,3,5,4, 4,5,3,4,4,4,3,5,4][i],
    stroke_index: [9,17,13,1,11,7,15,3,5, 10,18,14,2,12,8,16,4,6][i],
  }));
  const baseYards = [430,560,180,420,415,395,170,540,400, 430,560,180,420,415,395,170,540,400];
  const tees = [
    { name: 'Black', gender: 'male',   cr: 73.0, slope: 138, mult: 1.00 },
    { name: 'Blue',  gender: 'male',   cr: 71.5, slope: 132, mult: 0.93 },
    { name: 'White', gender: 'male',   cr: 70.0, slope: 128, mult: 0.86 },
    { name: 'Red',   gender: 'female', cr: 69.5, slope: 124, mult: 0.75 },
  ].map(t => ({
    name: t.name, gender: t.gender,
    course_rating: t.cr, slope_rating: t.slope,
    holes: parSi.map((ps, i) => ({
      hole_number: i+1, par: ps.par, stroke_index: ps.stroke_index,
      yardage: Math.round(baseYards[i] * t.mult),
    })),
  }));

  const res = await fetch(`${BASE}/api/courses`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Test Multi-Tee Course', city: 'Pebble Beach', state: 'CA',
      tees,
    }),
  });
  if (!res.ok) throw new Error('POST courses failed: ' + res.status + ' ' + await res.text());
  const { id } = await res.json();
  console.log('[2] course created with 4 tees, id=' + id);

  // Read it back via /api/courses (list) — pull this course and confirm.
  // Personal users can't hit /api/courses/:id (admin-only) but they can list
  // via /api/courses, and the round-detail flow loads the full course
  // (with tees + holes) when a round is created with this course.
  // Easiest verification: create a casual round on this course and pull
  // the round payload.
  const trnRes = await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Verify Tees', type: 'casual', course_id: id, format: 'stroke_net' }),
  });
  const trn = await trnRes.json();
  const rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (!rd.course || !Array.isArray(rd.course.tees)) {
    throw new Error('round payload missing course.tees: ' + JSON.stringify(rd.course));
  }
  console.log('[3] round payload returned ' + rd.course.tees.length + ' tees:');
  for (const t of rd.course.tees) {
    const first = t.holes && t.holes[0];
    const ydTot = (t.holes || []).reduce((a, h) => a + (h.yardage || 0), 0);
    console.log(`    • ${t.name.padEnd(8)} (${t.gender})  CR ${t.course_rating} / Slope ${t.slope_rating}  total ${ydTot} yds  H1=${first?.yardage}`);
  }
  if (rd.course.tees.length !== 4) {
    throw new Error('expected 4 tees, got ' + rd.course.tees.length);
  }
  // Spot-check: Red tee H1 should be ~75% of 430 = 322 yds
  const red = rd.course.tees.find(t => t.name === 'Red');
  if (!red) throw new Error('Red tee missing');
  if (!red.holes || red.holes[0].yardage < 300 || red.holes[0].yardage > 350) {
    throw new Error('Red H1 yardage off: ' + red.holes[0].yardage);
  }
  console.log('[4] per-tee yardages persisted correctly (Red H1 = ' + red.holes[0].yardage + ')');

  console.log('\nALL PASS — multi-tee course creation works');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
