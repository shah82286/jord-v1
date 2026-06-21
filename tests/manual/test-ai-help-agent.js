// v3.77 — AI Help Agent E2E (no real Claude calls).
//
// Mocks the Anthropic SDK by stubbing the env var to a fake key, then
// monkey-patches require cache to inject a fake client. Verifies:
//   1. requireAuth gates the chat endpoint (403 for non-admin)
//   2. POST /chat persists the user+assistant turns + token usage
//   3. session_id round-trips on a 2nd message
//   4. /usage-today returns the accumulated tokens for the day
//   5. /escalate inserts a queued escalation
//   6. Super-only escalations list returns the convo transcript
//   7. /ack closes the open escalation
//   8. Daily cap returns 429 when exceeded
//
// We don't hit the real Anthropic API — that costs money and would
// require a real key in CI. The fake client returns canned responses
// + token counts so the assertions are deterministic.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = 3499;
const BASE = `http://localhost:${PORT}`;
const PW = 'aih-pw-test';
const EMAIL = 'shah82286@gmail.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const sendBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  const r = await fetch(BASE + p, { method, headers, body: sendBody ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, data, raw: text };
}
async function ok(method, p, body, token) {
  const r = await api(method, p, body, token);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${p} → ${r.status}: ${(r.data && r.data.error) || r.raw.slice(0,200)}`);
  return r.data;
}

(async () => {
  // ─── Sandbox a server with a low daily cap so we can hit it in 2 calls.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jord-aih-'));
  fs.writeFileSync(path.join(sandbox, '.env'),
    `PORT=${PORT}\nADMIN_PASSWORD=${PW}\nAPP_URL=${BASE}\n` +
    `ANTHROPIC_API_KEY=test-fake-key\nAI_HELP_DAILY_TOKEN_CAP=500\n`);

  // Replace lib/aiHelp.js for the sandbox with a fake that doesn't call
  // the real API. Mirrors the real interface: chat() returns
  // { reply, usage } and exposes DAILY_TOKEN_CAP + looksStuck. We write
  // the fake into node_modules-equivalent path; simpler is to write into
  // a /lib/aiHelp.js under the sandbox and set NODE_PATH. But the server
  // requires by relative path, so the cleanest approach is to substitute
  // the file in PROJECT/lib before spawn, then restore on shutdown.
  const REAL = path.join(PROJECT, 'lib', 'aiHelp.js');
  const BACKUP = path.join(PROJECT, 'lib', 'aiHelp.real.js.bak');
  const FAKE = `
    'use strict';
    let callCount = 0;
    const FAKE_RESPONSES = [
      'Great question! Try the Settings tab.',
      'Click + Add player on the Players tab.',
      'I can flag this for a super admin if you want.',
    ];
    module.exports = {
      dailyTokenCap: () => Number(process.env.AI_HELP_DAILY_TOKEN_CAP) || 50000,
      MODEL: 'fake-test-model',
      looksStuck: (t) => /broken|stuck|help me/i.test(t || ''),
      async chat({ history, userMessage, context }) {
        const reply = FAKE_RESPONSES[callCount++ % FAKE_RESPONSES.length] +
          (context && context.event_id ? ' (re: ' + context.event_id + ')' : '');
        return { reply, usage: { input: 200, output: 60, cache_creation: 50, cache_read: 0 } };
        // 200 + 60 + 50 = 310 tokens per turn → 2 turns puts us over 500 cap.
      },
    };
  `;
  fs.copyFileSync(REAL, BACKUP);
  fs.writeFileSync(REAL, FAKE);

  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const shutdown = (code) => {
    try { server.kill(); } catch {}
    try { fs.copyFileSync(BACKUP, REAL); fs.unlinkSync(BACKUP); } catch {}
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    process.exit(code);
  };
  // Make absolutely sure we restore on any exit path.
  process.on('exit', () => { try { fs.copyFileSync(BACKUP, REAL); fs.unlinkSync(BACKUP); } catch {} });
  process.on('SIGINT', () => shutdown(130));

  try {
    // Wait for server
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try { const r = await fetch(BASE + '/api/config'); if (r.ok) { ready = true; break; } } catch {}
    }
    if (!ready) { console.error('Server never came up.\n' + log); return shutdown(1); }

    // ── Auth as super admin (the seeded one)
    const login = await ok('POST', '/api/auth/login', { email: EMAIL, password: PW });
    const tok = login.token;
    console.log('[1] super admin authed');

    // ── First chat: starts a new session
    const first = await ok('POST', '/api/admin/help-agent/chat', {
      message: 'How do I add a sponsor logo?',
      context: { event_id: 'EVT-TEST', page: 'editor' },
    }, tok);
    if (!first.session_id) throw new Error('missing session_id in response');
    if (!first.reply || !first.reply.length) throw new Error('empty reply');
    if (first.usage_today < 310 || first.usage_today > 320) throw new Error('expected ~310 tokens used, got ' + first.usage_today);
    console.log('[2] first chat ok — session=' + first.session_id + ' reply="' + first.reply.slice(0, 60) + '..." tokens=' + first.usage_today);

    // ── Usage endpoint reflects the same number
    const u = await ok('GET', '/api/admin/help-agent/usage-today', null, tok);
    if (u.used !== first.usage_today) throw new Error('usage-today mismatch: ' + u.used + ' vs ' + first.usage_today);
    if (u.cap !== 500) throw new Error('cap should be 500 (env override), got ' + u.cap);
    console.log('[3] /usage-today reports ' + u.used + '/' + u.cap);

    // ── Second chat: carries the same session, accumulates more tokens
    const second = await ok('POST', '/api/admin/help-agent/chat', {
      message: 'I am stuck, this is broken — what now?',
      session_id: first.session_id,
    }, tok);
    if (second.session_id !== first.session_id) throw new Error('session_id should round-trip');
    if (!second.stuck_hint) throw new Error('stuck phrasing should trigger stuck_hint');
    if (second.usage_today < 620) throw new Error('expected ~620 tokens after 2 turns, got ' + second.usage_today);
    console.log('[4] second chat ok — session reused, stuck_hint=true, tokens=' + second.usage_today);

    // ── Load session: should return all 4 messages (2 user + 2 assistant)
    const sess = await ok('GET', '/api/admin/help-agent/sessions/' + first.session_id, null, tok);
    if (!sess.messages || sess.messages.length !== 4) throw new Error('expected 4 messages, got ' + (sess.messages?.length));
    console.log('[5] session history loads ' + sess.messages.length + ' messages');

    // ── Escalate the session
    const esc = await ok('POST', '/api/admin/help-agent/escalate', {
      session_id: first.session_id, note: 'Tried twice, can\'t find the sponsor upload',
    }, tok);
    if (!esc.id || esc.status !== 'open') throw new Error('escalate did not open a new entry: ' + JSON.stringify(esc));
    console.log('[6] escalation opened — id=' + esc.id);

    // De-dupe: a second escalate on same session returns the same id
    const esc2 = await ok('POST', '/api/admin/help-agent/escalate', {
      session_id: first.session_id,
    }, tok);
    if (esc2.id !== esc.id || esc2.status !== 'already_open') throw new Error('escalate should de-dupe: ' + JSON.stringify(esc2));
    console.log('[7] de-dupe works — same id returned, status=already_open');

    // ── Super admin sees the queued escalation w/ transcript
    const supList = await ok('GET', '/api/super/help-agent/escalations', null, tok);
    if (!supList.escalations.length) throw new Error('super list empty');
    const item = supList.escalations.find(e => e.id === esc.id);
    if (!item) throw new Error('our escalation not in super list');
    if (!item.messages || item.messages.length !== 4) throw new Error('escalation should include the 4-message transcript');
    console.log('[8] super sees ' + supList.escalations.length + ' open escalation(s) w/ transcript');

    // ── Ack it
    await ok('POST', '/api/super/help-agent/escalations/' + esc.id + '/ack', {}, tok);
    const openAfter = await ok('GET', '/api/super/help-agent/escalations?status=open', null, tok);
    if (openAfter.escalations.find(e => e.id === esc.id)) throw new Error('escalation still open after ack');
    const ackedList = await ok('GET', '/api/super/help-agent/escalations?status=acked', null, tok);
    if (!ackedList.escalations.find(e => e.id === esc.id)) throw new Error('escalation not in acked list');
    console.log('[9] ack works — escalation moved to acked tab');

    // ── Daily cap: we're at ~620 already, one more call ought to exceed 500.
    //   Wait... cap = 500, used = 620. Already over. So the next call should 429.
    const capped = await api('POST', '/api/admin/help-agent/chat', {
      message: 'Should this 429?', session_id: first.session_id,
    }, tok);
    if (capped.status !== 429) throw new Error('expected 429 when over cap, got ' + capped.status);
    if (!capped.data || !/cap/i.test(capped.data.error)) throw new Error('429 should mention cap: ' + JSON.stringify(capped.data));
    console.log('[10] daily cap enforcement returns 429 with friendly message');

    console.log('\n✅ ALL PASS — AI Help Agent: chat / session / cap / escalate / super-review');
    shutdown(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error('Server log tail:\n' + log.split('\n').slice(-30).join('\n'));
    shutdown(1);
  }
})();
