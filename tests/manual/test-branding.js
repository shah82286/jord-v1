// PHASE-2 — verify per-event branding persists and flows to the
// player-facing API surfaces, plus the brand_logo validation guard.
const BASE = 'http://localhost:3000';
const LOGO = 'data:image/png;base64,iVBORw0KGgo=';   // tiny valid image data URL

(async () => {
  // 1) Log in as super admin
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'shah82286@gmail.com', password: 'jord2026' }),
  })).json();
  if (!login.token) throw new Error('login failed: ' + JSON.stringify(login));
  const H = { 'Content-Type': 'application/json', 'x-admin-token': login.token };
  console.log('[1] logged in as super admin');

  // 2) Create an event
  const now = new Date().toISOString().slice(0, 16);
  const ev = await (await fetch(`${BASE}/api/events`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Branding Test ' + Date.now(), starts_at: now, ends_at: now, has_longest_drive: 1 }),
  })).json();
  if (!ev.id) throw new Error('create failed: ' + JSON.stringify(ev));
  console.log('[2] created event ' + ev.id);

  // 3) PATCH branding on
  const patch = await fetch(`${BASE}/api/events/${ev.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ brand_enabled: 1, brand_accent: '#1E7A46', brand_logo: LOGO }),
  });
  if (!patch.ok) throw new Error('PATCH failed: ' + patch.status + ' ' + await patch.text());
  const saved = await patch.json();
  if (saved.brand_enabled !== 1)         throw new Error('brand_enabled should be 1');
  if (saved.brand_accent !== '#1E7A46')  throw new Error('brand_accent should persist');
  if (saved.brand_logo !== LOGO)         throw new Error('brand_logo should persist');
  console.log('[3] branding saved: enabled=1, accent=#1E7A46, logo stored');

  // 4) Public event endpoint exposes branding when enabled
  const pub = await (await fetch(`${BASE}/api/events/${ev.id}/public`)).json();
  if (!pub.branding || pub.branding.accent !== '#1E7A46' || pub.branding.logo !== LOGO) {
    throw new Error('/public should expose branding: ' + JSON.stringify(pub.branding));
  }
  console.log('[4] /public exposes branding when enabled');

  // 5) Disabling branding hides it from the public endpoint
  await fetch(`${BASE}/api/events/${ev.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ brand_enabled: 0 }) });
  const pub2 = await (await fetch(`${BASE}/api/events/${ev.id}/public`)).json();
  if (pub2.branding !== null) throw new Error('branding should be null when disabled, got ' + JSON.stringify(pub2.branding));
  console.log('[5] branding hidden from /public when disabled');

  // 6) Invalid logo payload is rejected (guard)
  const bad = await fetch(`${BASE}/api/events/${ev.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ brand_logo: 'not-an-image' }),
  });
  if (bad.status !== 400) throw new Error('bad logo should 400, got ' + bad.status);
  console.log('[6] invalid brand_logo rejected with 400');

  // 7) Super admin can delete the event (ownership guard allows super)
  const del = await fetch(`${BASE}/api/events/${ev.id}`, { method: 'DELETE', headers: H });
  if (!del.ok) throw new Error('super delete failed: ' + del.status);
  console.log('[7] super admin delete OK');

  console.log('\nALL PASS — per-event branding persists, flows to /public, validates, and respects the delete guard');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
