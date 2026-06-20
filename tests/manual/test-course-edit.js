// v3.75 — verify PUT /api/courses/:id:
//   1. updates course-level fields (name, city, state)
//   2. PRESERVES tee IDs when tees stay in the body (matched by id) — this
//      is the critical contract because round_entries.tee_id points at
//      these IDs and orphaning them would silently break leaderboard
//      handicap math
//   3. INSERTs a new tee that has no id
//   4. DELETEs a tee that's omitted from the body
//   5. round_entries created BEFORE the edit still find their tee +
//      per-hole pars after the edit (because IDs are preserved)
//   6. PUT respects ownership — a different user can't edit someone
//      else's course (403)
const BASE = 'http://localhost:3000';
const headers = (tok) => ({ 'Content-Type': 'application/json', 'x-user-token': tok });

async function api(method, p, body, tok) {
  const opt = { method, headers: headers(tok) };
  if (body !== undefined && body !== null && method !== 'GET') opt.body = JSON.stringify(body);
  const r = await fetch(BASE + p, opt);
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${data?.error || text.slice(0, 200)}`);
  return data;
}

(async () => {
  // ─── User + base course (3 tees, 18 holes par-4 each)
  const signup = await (await fetch(BASE + '/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Course Editor', email: `ce-${Date.now()}@example.com`, password: 'TestPass1234' }),
  })).json();
  const tok = signup.token;
  const baseBody = {
    name: 'Original Name', city: 'Pebble Beach', state: 'CA',
    tees: ['Blue', 'White', 'Red'].map((nm, i) => ({
      name: nm, gender: 'male', course_rating: 70 + i, slope_rating: 120 + i,
      holes: Array.from({length: 18}, (_, h) => ({
        hole_number: h + 1, par: 4, stroke_index: h + 1, yardage: 350 - i * 25,
      })),
    })),
  };
  const cr = await api('POST', '/api/courses', baseBody, tok);
  console.log('[1] created course id=' + cr.id);

  const before = await api('GET', '/api/courses/' + cr.id, null, tok);
  const blueId = before.tees.find(t => t.name === 'Blue').id;
  const whiteId = before.tees.find(t => t.name === 'White').id;
  const redId = before.tees.find(t => t.name === 'Red').id;
  console.log('[2] initial tee ids — Blue=' + blueId + ' White=' + whiteId + ' Red=' + redId);

  // Create a tournament + round that uses the Blue tee → this is the round
  // whose tee_id ref MUST survive the course edit.
  const courses = await api('GET', '/api/courses', null, tok);
  const trn = await api('POST', '/api/tournaments', {
    name: 'Round on Blue', type: 'casual', course_id: cr.id, format: 'stroke_net',
  }, tok);
  await api('POST', `/api/tournaments/${trn.id}/field`, {
    name: 'Alex', handicap_index: 10, tee_id: blueId,
  }, tok);
  console.log('[3] created round + 1 player registered on Blue tee');

  // ─── EDIT 1: rename course + Blue → "Championship", drop Red, add Gold,
  // change hole 1 par from 4 → 5. Keep White untouched. Each kept tee
  // carries its id; the new Gold tee has no id.
  const edit1 = {
    name: 'Renamed Course', city: 'Pebble Beach', state: 'CA',
    tees: [
      { id: blueId, name: 'Championship', gender: 'male', course_rating: 73, slope_rating: 135,
        holes: Array.from({length: 18}, (_, h) => ({
          hole_number: h + 1, par: h === 0 ? 5 : 4, stroke_index: h + 1, yardage: 380,
        })) },
      { id: whiteId, name: 'White', gender: 'male', course_rating: 71, slope_rating: 122,
        holes: Array.from({length: 18}, (_, h) => ({
          hole_number: h + 1, par: h === 0 ? 5 : 4, stroke_index: h + 1, yardage: 325,
        })) },
      // No id → server INSERTs
      { name: 'Gold', gender: 'female', course_rating: 68, slope_rating: 115,
        holes: Array.from({length: 18}, (_, h) => ({
          hole_number: h + 1, par: h === 0 ? 5 : 4, stroke_index: h + 1, yardage: 280,
        })) },
      // Red omitted → server DELETEs
    ],
  };
  await api('PUT', '/api/courses/' + cr.id, edit1, tok);

  const after = await api('GET', '/api/courses/' + cr.id, null, tok);
  if (after.name !== 'Renamed Course') throw new Error('course name not updated');
  console.log('[4] course name updated');

  // Tee preservation: Blue's id must survive the rename → Championship
  const championship = after.tees.find(t => t.name === 'Championship');
  if (!championship) throw new Error('Championship tee missing');
  if (championship.id !== blueId) throw new Error(`Blue → Championship lost its id: was ${blueId}, now ${championship.id}`);
  console.log('[5] tee ID preserved when renamed (Blue → Championship)');

  // White unchanged name → id must also survive
  const white = after.tees.find(t => t.name === 'White');
  if (white.id !== whiteId) throw new Error('White tee lost its id');
  console.log('[6] tee ID preserved when unchanged (White)');

  // Gold is new → got a fresh id
  const gold = after.tees.find(t => t.name === 'Gold');
  if (!gold || !gold.id || gold.id === blueId || gold.id === whiteId || gold.id === redId) {
    throw new Error('Gold should have a new tee id, got ' + gold?.id);
  }
  console.log('[7] new tee (Gold) inserted with fresh id');

  // Red gone
  if (after.tees.find(t => t.id === redId)) throw new Error('Red tee should have been deleted');
  if (after.tees.find(t => t.name === 'Red')) throw new Error('Red tee should not be in response');
  console.log('[8] removed tee (Red) deleted');

  // Hole 1 par updated 4 → 5 on all tees
  for (const t of after.tees) {
    const h1 = t.holes.find(h => h.hole_number === 1);
    if (h1.par !== 5) throw new Error(`tee ${t.name} hole 1 par should be 5, got ${h1.par}`);
  }
  console.log('[9] hole 1 par 4→5 on all tees');

  // ─── CRITICAL: the round registered on the Blue tee must still resolve
  // its tee + per-hole pars after the edit. The /rounds endpoint returns
  // a `course` object — find the tee whose id matches the round_entry's
  // original blueId. If preservation worked, that tee exists in the course
  // payload with par=5 on hole 1 (the edited Championship). If
  // preservation FAILED, the id wouldn't be in course.tees and downstream
  // scoring would fall back to the wrong tee silently.
  const rd = await api('GET', `/api/rounds/${trn.round_id}`, null, tok);
  if (!rd.course || !Array.isArray(rd.course.tees)) throw new Error('course missing from round payload');
  const preservedTee = rd.course.tees.find(t => t.id === blueId);
  if (!preservedTee) throw new Error(`Blue's tee id (${blueId}) is gone from course.tees — round_entry refs are orphaned`);
  if (preservedTee.name !== 'Championship') throw new Error('preserved tee name should be Championship');
  const h1 = preservedTee.holes.find(h => h.hole_number === 1);
  if (h1.par !== 5) throw new Error('preserved tee hole 1 par should be 5, got ' + h1.par);
  console.log('[10] round_entry.tee_id still resolves on course payload (Championship, par 5 on hole 1)');

  // ─── EDIT 2: ownership — sign up a DIFFERENT user, confirm 403
  const other = await (await fetch(BASE + '/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other', email: `other-${Date.now()}@example.com`, password: 'TestPass1234' }),
  })).json();
  let denied = false;
  try {
    await api('PUT', '/api/courses/' + cr.id, edit1, other.token);
  } catch (e) {
    if (/Only the course creator/i.test(e.message)) denied = true;
    else throw e;
  }
  if (!denied) throw new Error('Other user should have been 403 from editing this course');
  console.log('[11] non-creator user blocked with 403');

  console.log('\n✅ ALL PASS — PUT /api/courses/:id preserves tee IDs, updates fields, respects ownership');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
