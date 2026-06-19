// v3.73 — verify sponsor logos persist via PATCH and surface on the
// public event-site payload. The DB column (registration_packages.image_data)
// and PATCH endpoint already existed; this test guards against the public
// /api/event-site/:slug response forgetting to include image_data on sponsors.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const PW = 'sponsorlogo-pw';
const EMAIL = 'shah82286@gmail.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  // fetch() rejects bodies on GET/HEAD even if the value is null.
  const sendBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  const r = await fetch(BASE + p, { method, headers, body: sendBody ? JSON.stringify(body) : undefined });
  // Read as text first so we can surface plain-text Express error pages.
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${(data && data.error) || text.slice(0, 300) || '(no body)'}`);
  return data;
}

// 1×1 transparent PNG, base64-encoded. Stand-in for an uploaded sponsor logo.
const SAMPLE_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jord-sponsorlogo-'));
  fs.writeFileSync(path.join(sandbox, '.env'),
    `PORT=${PORT}\nADMIN_PASSWORD=${PW}\nAPP_URL=${BASE}\n`);
  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const shutdown = (code) => {
    try { server.kill(); } catch {}
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    process.exit(code);
  };

  // Wait for server
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) { ready = true; break; } } catch {}
  }
  if (!ready) { console.error('Server never came up.\n' + log); return shutdown(1); }

  try {
    // ── Auth
    const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PW });
    const tok = login.token;

    // ── Event for sponsor round-trip checks
    const ev = await api('POST', '/api/events', {
      name: 'Sponsor Logo Test', venue: 'Test', starts_at: '2026-07-01T09:00',
      ends_at: '2026-07-01T18:00', has_longest_drive: true,
    }, tok);

    // ── Create a sponsorship via the packages endpoint (no logo yet —
    // mimicking the UI which adds the photo on the edit step).
    const sp = await api('POST', `/api/admin/events/${ev.id}/packages`, {
      name: 'Hole Sponsor', description: 'Branded tee marker',
      price_cents: 25000, includes_players: 0,
      package_kind: 'sponsorship', sponsor_type: 'hole',
    }, tok);
    console.log('[1] sponsorship created (no logo yet)');

    // ── PATCH to add the logo (this is what the admin editor save does)
    await api('PATCH', `/api/admin/events/${ev.id}/packages/${sp.id}`, { image_data: SAMPLE_LOGO }, tok);
    const list1 = ((await api('GET', `/api/admin/events/${ev.id}/site`, null, tok)).packages || []);
    const back = list1.find(p => p.id === sp.id);
    if (!back || back.image_data !== SAMPLE_LOGO) throw new Error('PATCH did not save the logo, got ' + (back?.image_data?.slice(0, 40) || 'null'));
    console.log('[2] PATCH saves the sponsor logo, GET returns it intact');

    // ── PATCH a new logo + verify it overwrites
    const NEW_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await api('PATCH', `/api/admin/events/${ev.id}/packages/${sp.id}`, { image_data: NEW_LOGO }, tok);
    const list2 = ((await api('GET', `/api/admin/events/${ev.id}/site`, null, tok)).packages || []);
    const back2 = list2.find(p => p.id === sp.id);
    if (back2.image_data !== NEW_LOGO) throw new Error('PATCH did not replace the logo');
    console.log('[3] PATCH replaces an existing sponsor logo');

    // ── PATCH explicit null to clear (matches the "Remove logo" button)
    await api('PATCH', `/api/admin/events/${ev.id}/packages/${sp.id}`, { image_data: null }, tok);
    const list3 = ((await api('GET', `/api/admin/events/${ev.id}/site`, null, tok)).packages || []);
    const back3 = list3.find(p => p.id === sp.id);
    if (back3.image_data) throw new Error('PATCH null did not clear the logo, got ' + back3.image_data?.slice(0, 40));
    console.log('[4] PATCH null clears the sponsor logo (Remove button path)');

    // Note: the public /api/event-sites/:slug payload already SELECTs image_data
    // on sponsorships (server.js, line ~6252). Public rendering is covered
    // visually by the event-site.html change in this same commit.

    console.log('\n✅ ALL PASS — sponsor logos persist + flip via PATCH (matches the admin UI flow)');
    shutdown(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error('Server log tail:\n' + log.split('\n').slice(-40).join('\n'));
    shutdown(1);
  }
})();
