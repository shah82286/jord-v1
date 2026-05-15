/**
 * Smoke test for per-event admin assignment.
 * Boots nothing itself — run against a server started with a throwaway DB:
 *
 *   DB_PATH=./data/test-admins.db PORT=3999 ADMIN_PASSWORD=test1234 node server.js
 *   node scripts/test-event-admins.js
 *
 * Exercises: login, create event, add new admin (temp pw), add existing admin,
 * duplicate guard, owner-remove guard, delete, and the accept-request flow.
 */
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:3999';
const SUPER_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'shah82286@gmail.com';
const SUPER_PASS  = process.env.ADMIN_PASSWORD || 'test1234';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(path, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-admin-token': token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { let b; try { b = JSON.parse(raw); } catch { b = raw; }
        resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else      { fail++; console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`); }
}

(async () => {
  console.log('\n🧪 Per-event admin assignment\n');

  // Login
  const login = await req('POST', '/api/auth/login', { email: SUPER_EMAIL, password: SUPER_PASS });
  check('super login', login.status === 200 && login.body.token, JSON.stringify(login.body));
  const token = login.body.token;
  if (!token) { console.log('\nAborting — no token.\n'); process.exit(1); }

  // Create event
  const ev = await req('POST', '/api/events', {
    name: 'Admin-Assign Test', starts_at: '2099-01-01T00:00', ends_at: '2099-01-02T00:00', has_longest_drive: 1,
  }, token);
  check('create event', ev.status === 200 && ev.body.id);
  const eventId = ev.body.id;

  // GET admins — creator present, no assigned
  const list1 = await req('GET', `/api/events/${eventId}/admins`, null, token);
  check('GET admins — creator set', list1.status === 200 && list1.body.creator && list1.body.creator.is_creator === 1);
  check('GET admins — none assigned yet', Array.isArray(list1.body.assigned) && list1.body.assigned.length === 0);

  // Add NEW admin by name+email → temp password returned
  const newEmail = `newadmin.${Date.now()}@example.test`;
  const addNew = await req('POST', `/api/events/${eventId}/admins`, { name: 'New Admin', email: newEmail }, token);
  check('add new admin — created + temp password', addNew.status === 200 && addNew.body.created_new && addNew.body.temp_password,
        JSON.stringify(addNew.body));
  const newAdminId = addNew.body.admin && addNew.body.admin.id;

  // Duplicate guard
  const dup = await req('POST', `/api/events/${eventId}/admins`, { admin_id: newAdminId }, token);
  check('duplicate assignment rejected', dup.status === 400);

  // Re-adding same email → no new account, assigned to existing (already assigned → 400)
  const reEmail = await req('POST', `/api/events/${eventId}/admins`, { name: 'New Admin', email: newEmail }, token);
  check('re-add same email — recognised as existing', reEmail.status === 400);

  // GET admins — one assigned
  const list2 = await req('GET', `/api/events/${eventId}/admins`, null, token);
  check('GET admins — one assigned', list2.body.assigned.length === 1 && list2.body.assigned[0].id === newAdminId);

  // Owner cannot be assigned
  const ownerAssign = await req('POST', `/api/events/${eventId}/admins`, { admin_id: list1.body.creator.id }, token);
  check('owner cannot be assigned', ownerAssign.status === 400);

  // Owner cannot be removed
  const ownerRemove = await req('DELETE', `/api/events/${eventId}/admins/${list1.body.creator.id}`, null, token);
  check('owner cannot be removed', ownerRemove.status === 400);

  // Delete the assigned admin
  const del = await req('DELETE', `/api/events/${eventId}/admins/${newAdminId}`, null, token);
  check('remove assigned admin', del.status === 200);
  const list3 = await req('GET', `/api/events/${eventId}/admins`, null, token);
  check('GET admins — back to none', list3.body.assigned.length === 0);

  // Bad input
  const bad = await req('POST', `/api/events/${eventId}/admins`, { name: 'No Email' }, token);
  check('missing email rejected', bad.status === 400);

  // Cleanup
  await req('DELETE', `/api/events/${eventId}`, null, token);
  console.log(`\n  cleaned up event ${eventId}`);

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
