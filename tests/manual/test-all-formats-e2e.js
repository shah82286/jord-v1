// v3.69 — Cross-format E2E sweep.
// For every pickable format: create a real tournament, add players (with
// the right team shape), start the round, post a full card of scores
// (+ hole-events for event-based engines), GET the leaderboard, and
// confirm rows are produced without errors. For formats with settings,
// also PATCH-edit the settings via /api/tournaments/:id and verify they
// round-trip via the read endpoint.
const BASE = 'http://localhost:3000';
const formats = require('../../lib/formats');

function nameFromIdx(i) {
  return ['Alex','Bo','Cam','Drew','Eli','Fin','Gus','Hal','Ivy','Jax','Kai','Liv'][i] || 'P' + (i+1);
}

// Roster shape per tier — keep it small so the sweep stays fast.
function rosterFor(fmt) {
  // Nassau is tier 'individual' but only resolves with exactly 2 sides
  // (1v1 head-to-head). Give it 2 solo players instead of 4.
  if (fmt.engine === 'nassau') {
    return [
      { name: 'Alex', handicap_index: 6 },
      { name: 'Bo',   handicap_index: 12 },
    ];
  }
  if (fmt.tier === 'team') {
    // 1 team of 4
    return Array.from({length: 4}, (_, i) => ({ name: nameFromIdx(i), team_name: 'Team Alpha', handicap_index: 10 + i }));
  }
  if (fmt.tier === 'pair') {
    // 2 teams of 2
    return [
      { name: 'Alex', team_name: 'Pair A', handicap_index: 4 },
      { name: 'Bo',   team_name: 'Pair A', handicap_index: 12 },
      { name: 'Cam',  team_name: 'Pair B', handicap_index: 8 },
      { name: 'Drew', team_name: 'Pair B', handicap_index: 18 },
    ];
  }
  // individual: 4 solo players
  return Array.from({length: 4}, (_, i) => ({ name: nameFromIdx(i), handicap_index: 6 + i*3 }));
}

// Synthesize a 9-hole card — vary scores so the leaderboard differentiates.
function scoresForEntry(entryId, seed) {
  const pars = [4,4,3,5,4,4,3,5,4];
  const out = [];
  for (let h = 1; h <= 9; h++) {
    const offset = ((seed + h*13) % 5) - 1;     // −1 to +3 of par
    out.push({ entry_id: entryId, hole_number: h, strokes: pars[h-1] + Math.max(0, offset) });
  }
  return out;
}

// Side-game events for BBB / Dots / Snake — one per hole, rotating winners.
function eventsForEngine(engine, entries) {
  const events = [];
  if (engine === 'bbb') {
    const keys = ['bingo', 'bango', 'bongo'];
    for (let h = 1; h <= 9; h++) {
      for (let k = 0; k < 3; k++) {
        events.push({ entry_id: entries[(h+k) % entries.length].id, hole_number: h, event_key: keys[k] });
      }
    }
  } else if (engine === 'dots') {
    for (let h = 1; h <= 9; h++) {
      events.push({ entry_id: entries[h % entries.length].id, hole_number: h, event_key: 'greenie' });
    }
  } else if (engine === 'snake') {
    for (let h = 1; h <= 9; h++) {
      if (h % 4 === 0) events.push({ entry_id: entries[h % entries.length].id, hole_number: h, event_key: 'three_putt' });
    }
  }
  return events;
}

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${(body && body.error) || ''}`);
  return body;
}

// Formats whose allowance is a STRING (scramble2 / scramble4 / foursomes /
// greensome) need a single team-card entry per team, not one entry per
// player. Use POST /api/rounds/:roundId/teams for those; /field for the rest.
function needsTeamCard(fmt) { return typeof fmt.allowance === 'string'; }

async function runOneFormat(fmt, H) {
  const courses = await api('/api/courses', { headers: { 'x-user-token': H['x-user-token'] } });
  const courseId = courses[0]?.id;
  if (!courseId) throw new Error('no courses in DB — seed at least one before running');

  // 1. Create tournament with defaults
  const trn = await api('/api/tournaments', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `Sim · ${fmt.id}`, type: 'casual', course_id: courseId, format: fmt.id }),
  });

  // 2. Add roster — branches on whether the format wants team-cards
  const roster = rosterFor(fmt);
  if (needsTeamCard(fmt)) {
    // Group by team_name → one POST per team with that team's players[].
    const byTeam = {};
    for (const p of roster) {
      const t = p.team_name || 'Team A';
      (byTeam[t] = byTeam[t] || []).push({ name: p.name, handicap_index: p.handicap_index });
    }
    for (const [teamName, players] of Object.entries(byTeam)) {
      await api(`/api/rounds/${trn.round_id}/teams`, {
        method: 'POST', headers: H, body: JSON.stringify({ name: teamName, players }),
      });
    }
  } else {
    for (const p of roster) {
      await api(`/api/tournaments/${trn.id}/field`, { method: 'POST', headers: H, body: JSON.stringify(p) });
    }
  }

  // 3. Start round
  await api(`/api/rounds/${trn.round_id}/status`, { method: 'POST', headers: H, body: JSON.stringify({ status: 'active' }) });

  // 4. Post scores (only for non-manual formats)
  const rd = await api(`/api/rounds/${trn.round_id}`, { headers: { 'x-user-token': H['x-user-token'] } });
  const entries = rd.entries.map(e => ({ id: e.id }));
  const allScores = entries.flatMap((e, i) => scoresForEntry(e.id, i + 1));
  await api(`/api/rounds/${trn.round_id}/scores`, {
    method: 'POST', headers: H, body: JSON.stringify({ scores: allScores, entered_by: 'sim' }),
  });

  // 5. Post hole-events for event-based engines
  const events = eventsForEngine(fmt.engine, entries);
  for (const ev of events) {
    await api(`/api/rounds/${trn.round_id}/hole-events`, { method: 'POST', headers: H, body: JSON.stringify(ev) });
  }

  // 6. Fetch leaderboard — must produce rows without erroring
  const lb = await api(`/api/rounds/${trn.round_id}/leaderboard`);
  const rows = (lb && lb.primary && lb.primary.rows) || lb.rows || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('empty leaderboard');

  // 7. If this format has settings, PATCH-flip one and verify it round-trips
  let settingsCheck = null;
  if (fmt.settings && fmt.settings.length) {
    const original = await api(`/api/tournaments/${trn.id}`, { headers: { 'x-user-token': H['x-user-token'] } });
    const firstSetting = fmt.settings[0];
    // Pick a new value distinct from the default so we can confirm the change took.
    let newVal;
    if (firstSetting.type === 'money' || firstSetting.type === 'number') newVal = (Number(firstSetting.default) || 0) + 7;
    else if (firstSetting.type === 'toggle') newVal = !firstSetting.default;
    else newVal = firstSetting.default; // dots_events: leave alone
    if (newVal !== firstSetting.default) {
      await api(`/api/tournaments/${trn.id}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ format_settings: { [firstSetting.key]: newVal } }),
      });
      const after = await api(`/api/tournaments/${trn.id}`, { headers: { 'x-user-token': H['x-user-token'] } });
      const got = after.format_settings && after.format_settings[firstSetting.key];
      if (got !== newVal) throw new Error(`PATCH settings ${firstSetting.key}: expected ${newVal}, got ${got}`);
      settingsCheck = `${firstSetting.key}: ${original.format_settings?.[firstSetting.key]} → ${got}`;
    }
  }

  return { rows: rows.length, settingsCheck };
}

(async () => {
  // Signup an account for the sweep — we share one user across all formats so
  // creator-admin checks pass on every PATCH.
  const email = `sim-${Date.now()}@example.com`;
  const sup = await api('/api/users/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sim Runner', email, password: 'TestPass1234' }),
  });
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };

  const results = [];
  for (const fmt of formats.FORMATS) {
    process.stdout.write(`  ${fmt.id.padEnd(24)} `);
    try {
      const out = await runOneFormat(fmt, H);
      results.push({ id: fmt.id, ok: true, ...out });
      console.log(`OK  rows=${out.rows}${out.settingsCheck ? ' · ' + out.settingsCheck : ''}`);
    } catch (e) {
      results.push({ id: fmt.id, ok: false, error: e.message });
      console.log(`FAIL  ${e.message}`);
    }
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} formats passed full-stack E2E`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log('  ' + f.id + ' — ' + f.error);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('SWEEP FAILED:', e.message, e.stack); process.exit(1); });
