// v3.69 — verify the tournament PATCH endpoint lets a host change
// format_settings + side_bets on an already-created game.
const BASE = 'http://localhost:3000';

(async () => {
  const email = `es-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'EditSettings', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();

  // 1) Create a Skins tournament with defaults
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Edit-Settings Test', type: 'casual',
      course_id: courses[0].id, format: 'skins',
      format_settings: { value_per_skin: 5 } }),
  })).json();
  console.log('[1] created tournament id=' + trn.id);

  // Sanity check — read back, confirm defaults
  const r1 = await (await fetch(`${BASE}/api/tournaments/${trn.id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (r1.format_settings.value_per_skin !== 5) throw new Error('initial value_per_skin should be 5');
  if (r1.format_settings.allow_handicaps !== true) throw new Error('initial allow_handicaps should default true');
  if (r1.format_settings.allow_carryover !== true) throw new Error('initial allow_carryover should default true');
  console.log('[2] defaults verified: value=5, handicaps=on, carryover=on');

  // 2) PATCH — flip handicaps OFF, carryover OFF, bump value to 10
  const patch = await fetch(`${BASE}/api/tournaments/${trn.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ format_settings: { value_per_skin: 10, allow_handicaps: false, allow_carryover: false } }),
  });
  if (!patch.ok) throw new Error('PATCH failed: ' + patch.status + ' ' + await patch.text());

  // Confirm the changes persisted
  const r2 = await (await fetch(`${BASE}/api/tournaments/${trn.id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (r2.format_settings.value_per_skin !== 10) throw new Error(`value should be 10, got ${r2.format_settings.value_per_skin}`);
  if (r2.format_settings.allow_handicaps !== false) throw new Error('handicaps should be off');
  if (r2.format_settings.allow_carryover !== false) throw new Error('carryover should be off');
  console.log('[3] PATCH flipped: value=10, handicaps=off, carryover=off');

  // 3) PATCH — add a side-bet (Skins on a stroke_net primary)
  await fetch(`${BASE}/api/tournaments/${trn.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({
      default_format: 'stroke_net',
      side_bets: [{ format_id: 'skins', settings: { value_per_skin: 2, allow_handicaps: true, allow_carryover: false } }],
    }),
  });
  const r3 = await (await fetch(`${BASE}/api/tournaments/${trn.id}`, { headers: { 'x-user-token': sup.token } })).json();
  if (r3.default_format !== 'stroke_net') throw new Error('format should now be stroke_net');
  if (!Array.isArray(r3.side_bets) || r3.side_bets.length !== 1) throw new Error('expected 1 side-bet, got ' + (r3.side_bets || []).length);
  const sb = r3.side_bets[0];
  if (sb.format_id !== 'skins') throw new Error('side-bet should be skins');
  if (sb.settings.value_per_skin !== 2) throw new Error('side-bet value should be 2');
  if (sb.settings.allow_handicaps !== true) throw new Error('side-bet handicaps should be on');
  if (sb.settings.allow_carryover !== false) throw new Error('side-bet carryover should be off');
  console.log('[4] side-bet PATCH: Skins side-bet with value=2, handicaps=on, carryover=off');

  console.log('\nALL PASS — format_settings + side_bets are editable on an existing tournament');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
