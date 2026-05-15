/**
 * End-to-end registration flow test.
 *
 * Spins up a FRESH server in a temp sandbox (its own .env + empty DB so the
 * real dev database is never touched), then drives the full registration
 * flow over HTTP exactly as the /register page does:
 *
 *   - player 1 registers + finalizes a team (team created immediately)
 *   - players 2-4 join via the share code (add-player)
 *   - 5 teams × 4 players = 20 players
 *   - GET /teams dropdown endpoint
 *   - edge cases: duplicate code, unknown code, full team
 *   - status gates: registration works in `setup`, blocked when `ended`
 *
 * Run: node scripts/test-registration-flow.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const PROJECT   = path.resolve(__dirname, '..');
const SERVER_JS = path.join(PROJECT, 'server.js');
const PORT      = 3199;
const BASE      = `http://localhost:${PORT}`;
const ADMIN_PW  = 'regtest-pw-9animal';
const ADMIN_EMAIL = 'shah82286@gmail.com'; // server's default seeded super admin

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✅  ${name}`); pass++; }
  else      { console.log(`  ❌  ${name}${detail ? '\n      → ' + detail : ''}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(BASE + pathname, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  // ─── Sandbox ───────────────────────────────────────────────────────
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jord-regtest-'));
  fs.writeFileSync(path.join(sandbox, '.env'),
    `PORT=${PORT}\nADMIN_PASSWORD=${ADMIN_PW}\nAPP_URL=${BASE}\n`);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  JORD Golf — Registration Flow Integration Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  sandbox:', sandbox, '\n');

  // server.js resolves require() from its own dir (PROJECT/node_modules) but
  // reads ./.env and ./data relative to CWD — so cwd=sandbox = isolated.
  const server = spawn(process.execPath, [SERVER_JS], {
    cwd: sandbox,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  function shutdown(code) {
    try { server.kill(); } catch {}
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }

  try {
    // ─── Wait for server ready ───────────────────────────────────────
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try { const r = await fetch(BASE + '/api/config'); if (r.ok) { ready = true; break; } } catch {}
    }
    if (!ready) { console.error('Server never came up. Log:\n' + serverLog); return shutdown(1); }
    console.log('Server up on ' + BASE + '\n');

    // ─── Auth ────────────────────────────────────────────────────────
    console.log('Setup');
    const login = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW });
    check('super admin can log in', login.status === 200 && !!login.data.token,
      `status ${login.status} ${JSON.stringify(login.data)}`);
    const token = login.data.token;
    if (!token) return shutdown(1);

    // ─── Create event (defaults to status='setup') ───────────────────
    const ev = await api('POST', '/api/events', {
      name: 'Reg Test Classic', venue: 'Test Links',
      starts_at: '2026-06-01T09:00', ends_at: '2026-06-01T18:00',
      has_longest_drive: true, has_closest_pin: false,
    }, token);
    check('event created', ev.status === 200 && !!ev.data.id, JSON.stringify(ev.data));
    const eid = ev.data.id;
    if (!eid) return shutdown(1);
    check('new event starts in "setup" status', ev.data.status === 'setup', `got "${ev.data.status}"`);

    // ─── Ball pool: 30 codes ─────────────────────────────────────────
    const codes = [];
    for (let i = 0; i < 30; i++) codes.push('RT' + String(1000 + i)); // RT1000..RT1029
    const pool = await api('POST', `/api/events/${eid}/balls`, { codes }, token);
    check('30-code ball pool added', pool.status === 200 && pool.data.added === 30,
      JSON.stringify(pool.data));

    let codeIdx = 0;
    const nextCode = () => codes[codeIdx++];

    // ─── PHASE 1: register 5 teams × 4 players, during SETUP status ──
    console.log('\nPhase 1 — register 5 teams (20 players) while tournament is in SETUP');
    const teams = [];
    for (let t = 1; t <= 5; t++) {
      const teamName = 'Team ' + ['Alpha','Bravo','Charlie','Delta','Echo'][t - 1];
      const p1Code = nextCode();

      // player 1 registers their ball
      const r1 = await api('POST', `/api/events/${eid}/register-player`, {
        drop_code: p1Code, first_name: 'P1', last_name: teamName, player_index: 1,
        email: `p1.${t}@example.com`,
      });
      // player 1 finalizes the team immediately (new flow)
      const fin = await api('POST', `/api/events/${eid}/finalize-team`, {
        team_name: teamName, drop_codes: [p1Code], share_code: 'TM' + (1000 + t),
      });
      const ok1 = r1.status === 200 && fin.status === 200 && !!fin.data.share_code;
      check(`${teamName}: player 1 creates team (setup status)`, ok1,
        `register ${r1.status} ${JSON.stringify(r1.data)} | finalize ${fin.status} ${JSON.stringify(fin.data)}`);
      if (!ok1) continue;
      const share = fin.data.share_code;
      teams.push({ teamName, share, codes: [p1Code] });

      // players 2-4 join via add-player
      for (let p = 2; p <= 4; p++) {
        const c = nextCode();
        const join = await api('POST', `/api/events/${eid}/teams/by-share-code/${share}/add-player`, {
          drop_code: c, first_name: 'P' + p, last_name: teamName,
        });
        check(`${teamName}: player ${p} joins via share code`, join.status === 200,
          `status ${join.status} ${JSON.stringify(join.data)}`);
        if (join.status === 200) teams[teams.length - 1].codes.push(c);
      }

      // verify the team now has 4 members
      const look = await api('GET', `/api/events/${eid}/teams/by-share-code/${share}`);
      check(`${teamName}: team shows 4 members`, look.data && look.data.member_count === 4,
        `member_count ${look.data && look.data.member_count}`);
    }
    check('5 teams fully registered = 20 players', teams.length === 5 &&
      teams.every(t => t.codes.length === 4),
      teams.map(t => t.teamName + ':' + t.codes.length).join(', '));

    // ─── Dropdown endpoint ───────────────────────────────────────────
    console.log('\nDropdown — GET /api/events/:id/teams');
    const list = await api('GET', `/api/events/${eid}/teams`);
    check('teams endpoint returns all 5 teams', Array.isArray(list.data) && list.data.length === 5,
      JSON.stringify(list.data));
    check('every team in dropdown shows member_count 4',
      Array.isArray(list.data) && list.data.every(t => t.member_count === 4),
      JSON.stringify(list.data));
    check('dropdown teams are alphabetically sorted',
      Array.isArray(list.data) &&
      list.data.map(t => t.team_name).join('|') === [...list.data.map(t => t.team_name)].sort((a,b)=>a.localeCompare(b)).join('|'),
      list.data && list.data.map(t => t.team_name).join(', '));

    // ─── Edge cases ──────────────────────────────────────────────────
    console.log('\nEdge cases');
    const t0 = teams[0];

    // duplicate / already-used code
    const dup = await api('POST', `/api/events/${eid}/register-player`, {
      drop_code: t0.codes[0], first_name: 'Dup', last_name: 'Player', player_index: 1,
    });
    check('duplicate code rejected (400, "already registered")',
      dup.status === 400 && /already registered/i.test(dup.data.error || ''),
      `status ${dup.status} ${JSON.stringify(dup.data)}`);

    // unknown code not in the pool
    const unknown = await api('POST', `/api/events/${eid}/register-player`, {
      drop_code: 'NOTAREALCODE', first_name: 'Ghost', last_name: 'Player', player_index: 1,
    });
    check('unknown code rejected (404, "not found")',
      unknown.status === 404 && /not found/i.test(unknown.data.error || ''),
      `status ${unknown.status} ${JSON.stringify(unknown.data)}`);

    // 5th player onto a full team
    const overfull = await api('POST', `/api/events/${eid}/teams/by-share-code/${t0.share}/add-player`, {
      drop_code: nextCode(), first_name: 'Fifth', last_name: 'Wheel',
    });
    check('5th player to a full team rejected (400, "4 players")',
      overfull.status === 400 && /4 players|max/i.test(overfull.data.error || ''),
      `status ${overfull.status} ${JSON.stringify(overfull.data)}`);

    // join via a bad share code
    const badShare = await api('POST', `/api/events/${eid}/teams/by-share-code/ZZZZZZ/add-player`, {
      drop_code: nextCode(), first_name: 'No', last_name: 'Team',
    });
    check('join with unknown share code rejected (404)',
      badShare.status === 404, `status ${badShare.status} ${JSON.stringify(badShare.data)}`);

    // ─── PHASE 2: status gates ───────────────────────────────────────
    console.log('\nPhase 2 — status gates');
    // flip to active — registration must still work
    await api('PATCH', `/api/events/${eid}`, { status: 'active' }, token);
    const activeReg = await api('POST', `/api/events/${eid}/register-player`, {
      drop_code: nextCode(), first_name: 'Active', last_name: 'Player', player_index: 1,
    });
    check('registration works when status = active', activeReg.status === 200,
      `status ${activeReg.status} ${JSON.stringify(activeReg.data)}`);

    // flip to ended — registration must be blocked
    await api('PATCH', `/api/events/${eid}`, { status: 'ended' }, token);
    const endedReg = await api('POST', `/api/events/${eid}/register-player`, {
      drop_code: nextCode(), first_name: 'Late', last_name: 'Player', player_index: 1,
    });
    check('registration blocked when status = ended (403)',
      endedReg.status === 403 && /ended/i.test(endedReg.data.error || ''),
      `status ${endedReg.status} ${JSON.stringify(endedReg.data)}`);

    const endedJoin = await api('POST', `/api/events/${eid}/teams/by-share-code/${t0.share}/add-player`, {
      drop_code: nextCode(), first_name: 'Late', last_name: 'Joiner',
    });
    check('joining blocked when status = ended (403)',
      endedJoin.status === 403, `status ${endedJoin.status} ${JSON.stringify(endedJoin.data)}`);

    // ─── Summary ─────────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : '  — registration flow clean'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    shutdown(fail ? 1 : 0);
  } catch (e) {
    console.error('\nTest crashed:', e);
    console.error('Server log:\n' + serverLog);
    shutdown(1);
  }
})();
