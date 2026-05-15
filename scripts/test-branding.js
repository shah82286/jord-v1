/**
 * Smoke test for charity-event branding.
 * Run against a server started on :3000 (real or test DB):
 *   node scripts/test-branding.js
 *
 * Spins up a fake "charity website" locally so fetch-branding is deterministic.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// Admin creds: env first, then .env (never hardcode the password).
function envVal(key) {
  try {
    const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
const BASE = process.env.TEST_URL || 'http://localhost:3000';
const SUPER_EMAIL = process.env.SUPER_ADMIN_EMAIL || envVal('SUPER_ADMIN_EMAIL') || 'shah82286@gmail.com';
const SUPER_PASS  = process.env.ADMIN_PASSWORD || envVal('ADMIN_PASSWORD') || '';
const FAKE_PORT = 3998;

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LOGO_DATA_URL = 'data:image/png;base64,' + PNG.toString('base64');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(path, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}),
                 ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let raw = ''; res.on('data', c => raw += c);
        res.on('end', () => { let b; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode, body: b }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  — ' + extra : '')); }
};

// Fake charity website
const fakeSite = http.createServer((rq, rs) => {
  if (rq.url === '/' || rq.url === '/index.html') {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.end(`<!doctype html><html><head>
      <meta name="theme-color" content="#2E7D32">
      <link rel="apple-touch-icon" href="/logo.png">
      <style>.brand{color:#2E7D32;background:#C8102E}</style>
      </head><body><img src="/logo.png" class="logo" alt="Our Charity logo"></body></html>`);
  } else if (rq.url === '/logo.png' || rq.url === '/favicon.ico') {
    rs.writeHead(200, { 'Content-Type': 'image/png' });
    rs.end(PNG);
  } else { rs.writeHead(404); rs.end(); }
});

(async () => {
  console.log('\n🧪 Charity-event branding\n');
  await new Promise(res => fakeSite.listen(FAKE_PORT, res));
  const fakeUrl = `http://localhost:${FAKE_PORT}/`;

  const login = await req('POST', '/api/auth/login', { email: SUPER_EMAIL, password: SUPER_PASS });
  check('super login', login.status === 200 && login.body.token, JSON.stringify(login.body));
  const token = login.body.token;
  if (!token) { fakeSite.close(); process.exit(1); }

  // 1 — signup with charity fields + uploaded logo
  const su = await req('POST', '/api/tournament-signup', {
    tournament_name: 'Branding Test Classic', event_date: '2099-09-09',
    venue: 'Test GC', location: 'Eureka, MO', contest_type: 'ld', expected_players: 40,
    admin_name: 'Casey Charity', admin_email: 'casey.charity.' + Date.now() + '@example.test',
    admin_phone: '555-0142', is_charity: '1', charity_url: fakeUrl, logo_data: LOGO_DATA_URL,
  });
  check('signup with charity fields', su.status === 200, JSON.stringify(su.body));

  // 2 — request persisted the charity fields
  const reqs = await req('GET', '/api/admin/tournament-requests?status=pending', null, token);
  const myReq = reqs.body.find(x => x.tournament_name === 'Branding Test Classic');
  check('request stored is_charity', myReq && myReq.is_charity === 1);
  check('request stored charity_url', myReq && myReq.charity_url === fakeUrl);
  check('request stored uploaded logo', myReq && myReq.logo_data === LOGO_DATA_URL);

  // 3 — fetch-branding against the fake site
  const fb = await req('POST', '/api/admin/tournament-requests/' + myReq.id + '/fetch-branding',
    { url: fakeUrl }, token);
  check('fetch-branding 200', fb.status === 200, JSON.stringify(fb.body).slice(0, 200));
  check('fetch-branding found logo(s)', fb.body.logos && fb.body.logos.length >= 1,
        'logos=' + (fb.body.logos || []).length);
  check('fetch-branding uploaded logo is first', fb.body.logos && fb.body.logos[0] === LOGO_DATA_URL);
  check('fetch-branding theme color', fb.body.theme_color === '#2e7d32', 'got ' + fb.body.theme_color);
  check('fetch-branding color candidates', Array.isArray(fb.body.colors) && fb.body.colors.length >= 1);

  // 4 — accept with branding
  const acc = await req('POST', '/api/admin/tournament-requests/' + myReq.id + '/accept',
    { branding: { enabled: true, logo: LOGO_DATA_URL, accent: '#2e7d32' } }, token);
  check('accept 200', acc.status === 200, JSON.stringify(acc.body).slice(0, 200));
  const eventId = acc.body.event_id;

  // 5 — event carries branding (authed endpoint returns full row)
  const ev = await req('GET', '/api/events/' + eventId, null, token);
  check('event brand_enabled', ev.body.brand_enabled === 1);
  check('event brand_logo stored', ev.body.brand_logo === LOGO_DATA_URL);
  check('event brand_accent stored', ev.body.brand_accent === '#2e7d32');
  check('event is_charity carried', ev.body.is_charity === 1);

  // 6 — public endpoint exposes branding (no logo in SSE, but /public has it)
  const pub = await req('GET', '/api/events/' + eventId + '/public', null);
  check('public endpoint has branding', pub.body.branding && pub.body.branding.accent === '#2e7d32');
  check('public branding includes logo', pub.body.branding && pub.body.branding.logo === LOGO_DATA_URL);

  // cleanup
  await req('DELETE', '/api/events/' + eventId, null, token);
  await req('DELETE', '/api/admin/tournament-requests/' + myReq.id, null, token);
  fakeSite.close();

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILURES') + ` — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); fakeSite.close(); process.exit(1); });
