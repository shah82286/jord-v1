// E2E for v3.66:
//   1. Create a stroke_net round, add 3 players (Alice, Bob, Cam)
//   2. Confirm GET /api/rounds/:id returns them in insertion order
//   3. PATCH /api/rounds/:id/entries/order with reversed ids
//   4. Confirm GET now returns them reversed (Cam, Bob, Alice)
//   5. Create a better_ball_stroke pair with two players
//   6. Post scores: Alex 4 on hole 1, Brooke 5 on hole 1
//   7. Render /card/:id and check that Alex's hole-1 cell gets `used` class
//      (since 4 < 5 net → Alex's score counts for the team)
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:3000';

(async () => {
  const email = `rc-${Date.now()}@example.com`;
  const password = 'TestPass1234';
  const sup = await (await fetch(`${BASE}/api/users/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Reorder + Counts', email, password }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'x-user-token': sup.token };
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { 'x-user-token': sup.token } })).json();
  console.log('[1] signed up');

  // ── Drag-reorder
  const trn = await (await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Reorder', type:'casual', course_id: courses[0].id, format:'stroke_net' }),
  })).json();
  for (const name of ['Alice', 'Bob', 'Cam']) {
    await fetch(`${BASE}/api/tournaments/${trn.id}/field`, { method:'POST', headers:H,
      body: JSON.stringify({ name, handicap_index: 10 }) });
  }
  let rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const order1 = rd.entries.map(e => e.player_name);
  console.log('[2] initial order:', order1);
  if (order1.join('|') !== 'Alice|Bob|Cam') throw new Error('expected insertion order Alice|Bob|Cam');

  // Reverse via PATCH
  const reversed = rd.entries.map(e => e.id).reverse();
  const pRes = await fetch(`${BASE}/api/rounds/${trn.round_id}/entries/order`, {
    method:'PATCH', headers:H, body: JSON.stringify({ entryIds: reversed }),
  });
  if (!pRes.ok) throw new Error('PATCH order failed: ' + pRes.status);
  rd = await (await fetch(`${BASE}/api/rounds/${trn.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const order2 = rd.entries.map(e => e.player_name);
  console.log('[3] after reorder:', order2);
  if (order2.join('|') !== 'Cam|Bob|Alice') throw new Error('expected Cam|Bob|Alice, got ' + order2.join('|'));

  // ── Best-ball "score counts" highlight
  const bb = await (await fetch(`${BASE}/api/tournaments`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Best Ball Highlight', type:'casual', course_id: courses[0].id, format:'better_ball_stroke' }),
  })).json();
  await fetch(`${BASE}/api/rounds/${bb.round_id}/teams`, {
    method:'POST', headers:H,
    body: JSON.stringify({ name:'Pair', players: [
      { name:'Alex',   handicap_index: 0 },
      { name:'Brooke', handicap_index: 0 },
    ]}),
  });
  await fetch(`${BASE}/api/rounds/${bb.round_id}/status`, { method:'POST', headers:H,
    body: JSON.stringify({ status:'active' }) });
  const rdBB = await (await fetch(`${BASE}/api/rounds/${bb.round_id}`, { headers:{'x-user-token':sup.token} })).json();
  const alex   = rdBB.entries.find(e => e.player_name === 'Alex');
  const brooke = rdBB.entries.find(e => e.player_name === 'Brooke');
  // Post scores: Alex 4 vs Brooke 5 on hole 1 — Alex's 4 should be the "used" score.
  // Hole 2: Brooke 3 vs Alex 5 — Brooke's 3 should be highlighted.
  await fetch(`${BASE}/api/rounds/${bb.round_id}/scores`, {
    method:'POST', headers:H,
    body: JSON.stringify({ scores: [
      { entry_id: alex.id,   hole_number: 1, strokes: 4 },
      { entry_id: brooke.id, hole_number: 1, strokes: 5 },
      { entry_id: alex.id,   hole_number: 2, strokes: 5 },
      { entry_id: brooke.id, hole_number: 2, strokes: 3 },
    ], entered_by:'test' }),
  });
  console.log('[4] best-ball pair + scores posted');

  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('jord_user_token', tok); }, sup.token);
  await page.goto(`${BASE}/card/${bb.round_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.gridcard tr.player', { timeout: 10000 });

  // Inspect: which player's row has the `used` class on hole 1's cell?
  const highlight = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('table.gridcard tr.player').forEach(tr => {
      const nm = tr.querySelector('.col-label .nm')?.textContent.trim();
      const cells = tr.querySelectorAll('td.score');
      // First .score cell is hole 1 (column 1, since 0 is the row label).
      const used = [];
      cells.forEach((cell, i) => { if (cell.classList.contains('used')) used.push(i + 1); });
      if (nm) out[nm] = used;
    });
    return out;
  });
  console.log('[5] used-score holes per player:', highlight);
  if (!highlight.Alex || !highlight.Alex.includes(1)) {
    throw new Error('Alex should have used class on hole 1, got ' + JSON.stringify(highlight.Alex));
  }
  if (!highlight.Brooke || !highlight.Brooke.includes(2)) {
    throw new Error('Brooke should have used class on hole 2, got ' + JSON.stringify(highlight.Brooke));
  }
  console.log('[6] highlight correct — Alex won hole 1, Brooke won hole 2');

  // Also confirm the synthetic "team net" row exists
  const teamRowExists = await page.$('tr.team-total');
  if (!teamRowExists) throw new Error('team-total row missing');
  console.log('[7] team-net row rendered');

  await page.screenshot({ path: 'tests/screenshots/70-card-best-ball-highlight.png' });
  console.log('[8] screenshot saved');

  await browser.close();
  console.log('\nALL PASS — drag-reorder persists + best-ball score highlight works');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });
