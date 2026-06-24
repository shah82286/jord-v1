// Seeds a realistic charity event in the LIVE dev DB for the marketing
// landing screenshots. Re-runnable: deletes any prior demo event by slug
// first so screenshots stay reproducible.
//
//   node scripts/seed-landing-demo.js [--port=3000] [--password=jord2026]
//   node scripts/seed-landing-demo.js --base=https://tournament.jordgolf.com --password=...
//
// On success, prints URLs to visit for the screenshots:
//   /e/spring-charity-classic-2026         — public event site
//   /admin/events/EVT...                   — admin event editor
//   /admin/events/EVT.../pairings          — drag-and-drop pairings
//   /admin/events/EVT.../pairings/poster   — 24x36 print poster
//   /admin/events/EVT.../site/edit         — site / sponsorship editor
//   /e/spring-charity-classic-2026/auction — silent auction
'use strict';
const PORT = (process.argv.find(a => a.startsWith('--port=')) || '--port=3000').split('=')[1];
const PW = (process.argv.find(a => a.startsWith('--password=')) || '--password=jord2026').split('=')[1];
const EMAIL = (process.argv.find(a => a.startsWith('--email=')) || '--email=shah82286@gmail.com').split('=')[1];
// --base overrides the default localhost URL so the seed can run against
// the deployed production server (the landing page tiles link to a slug
// that needs to exist on whatever environment serves /e/:slug).
const BASE_OVERRIDE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1];
const BASE = BASE_OVERRIDE || `http://localhost:${PORT}`;
const SLUG = 'spring-charity-classic-2026';

// 1×1 PNGs in 4 brand colors so the screenshots have *something* in
// sponsor cards. In a real demo you'd swap these for real partner logos.
function tinyPng(r, g, b) {
  // Solid-color 8x8 PNG, base64. Built once via canvas + toDataURL.
  // For seed purposes 1×1 transparent is fine — the cards still render.
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const sendBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  const r = await fetch(BASE + path, { method, headers, body: sendBody ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(data && data.error) || text.slice(0, 200)}`);
  return data;
}

(async () => {
  console.log(`[seed] connecting to ${BASE}`);
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PW });
  const tok = login.token;

  // Clean: delete any prior event with our slug. Look it up via the
  // events list, then DELETE so the run is idempotent.
  const existing = await api('GET', '/api/events', null, tok);
  for (const e of existing) {
    if (e.id && e.name === 'Spring Charity Classic 2026') {
      try { await api('DELETE', '/api/events/' + e.id, null, tok); console.log('  deleted prior demo event ' + e.id); }
      catch (err) { console.log('  could not delete prior event: ' + err.message); }
    }
  }

  // 1. Create the event itself
  console.log('[1] creating event');
  const ev = await api('POST', '/api/events', {
    name: 'Spring Charity Classic 2026',
    venue: 'Pebble Beach Golf Links',
    starts_at: '2026-09-12T08:00',
    ends_at:   '2026-09-12T17:00',
    has_longest_drive: true,
    has_closest_pin: true,
    combined_scoring: true,
    is_charity: 1,
    brand_enabled: 1,
    brand_accent: '#1A6E4A',
  }, tok);
  console.log('  → ' + ev.id);

  // 2. Add 32 ball codes for the pool
  console.log('[2] ball-code pool');
  const codes = Array.from({ length: 32 }, (_, i) => 'DC' + String(1000 + i));
  await api('POST', `/api/events/${ev.id}/balls`, { codes }, tok);

  // 3. Site editor — slug + headline + about + fundraising goal
  console.log('[3] event site (slug + content + fundraising)');
  await api('PUT', `/api/admin/events/${ev.id}/site`, {
    slug: SLUG,
    headline: 'Spring Charity Classic 2026',
    subhead: 'A round for the Bay Area Boys & Girls Club — September 12 at Pebble Beach.',
    starts_at: '2026-09-12T08:00',
    location_name: 'Pebble Beach, CA',
    about_html: 'Now in its 4th year, the Spring Charity Classic brings together executives, community partners, and pros for a day on one of the most famous courses in the world — all in support of after-school programs for 500 kids across the Bay Area.\n\nFoursome registration includes greens fees, cart, breakfast, on-course beverages, and a sit-down dinner with auction at the clubhouse.',
    schedule: [
      { time: '7:00 AM',  title: 'Breakfast + check-in',  note: 'Pebble Beach Lodge' },
      { time: '8:30 AM',  title: 'Shotgun start',          note: '4-person scramble' },
      { time: '1:30 PM',  title: 'Lunch + scoring',        note: 'Stillwater Bar & Grill' },
      { time: '3:00 PM',  title: 'Awards + silent auction',note: 'Lodge Ballroom' },
    ],
    course_info: '7,040 yards · Par 72 · Slope 145 from the Blues. Carts mandatory.',
    faq: [
      { q: 'Can I attend dinner without playing?', a: 'Yes — auction-only tickets are $150 and available at check-in.' },
      { q: "What's the dress code?", a: 'Standard country club: collared shirts, no denim, soft spikes only.' },
      { q: 'Where do proceeds go?',  a: '100% of net proceeds go to the Bay Area Boys & Girls Club after-school program.' },
    ],
    contact_name:  'Shaheen Hosseini', contact_email: 'shaheen@jordgolf.com', contact_phone: '(555) 010-2030',
    donations_enabled: 1,
    donation_suggested: [2500, 5000, 10000, 25000, 50000],
    donation_min_cents: 500,
    donation_prompt: 'Every dollar funds programs for one Bay Area kid.',
    auction_enabled: 1,
    auction_intake_enabled: 1,
    auction_intro: 'Bid on once-in-a-lifetime experiences donated by our supporters.',
    published: true,
  }, tok);

  // Fundraising goal at 65% — set goal to $50,000 and the seed
  // registrations below contribute ~$32,500.
  await api('PATCH', `/api/events/${ev.id}`, {
    fundraising_goal_cents: 5_000_000,
    fundraising_visible: 1,
  }, tok);

  // 4. Registration packages
  console.log('[4] registration packages');
  for (const p of [
    { name: 'Foursome', description: 'Greens, cart, breakfast, dinner. Best value.',
      price_cents: 250_000, includes_players: 4, sort_order: 1, package_kind: 'registration' },
    { name: 'Twosome', description: 'Two players — we\'ll pair you with another twosome.',
      price_cents: 130_000, includes_players: 2, sort_order: 2, package_kind: 'registration' },
    { name: 'Single', description: 'Solo entry — we\'ll match you to a group.',
      price_cents:  70_000, includes_players: 1, sort_order: 3, package_kind: 'registration' },
    { name: 'Dinner Only', description: 'Auction dinner + dessert reception.',
      price_cents:  15_000, includes_players: 0, sort_order: 4, package_kind: 'registration' },
  ]) {
    await api('POST', `/api/admin/events/${ev.id}/packages`, p, tok);
  }

  // 5. Sponsorships (with logos)
  console.log('[5] sponsorships with logos');
  const sponsors = [
    { name: 'Madrone Capital',         tier: 'title',         price: 10_000_00, desc: 'Title sponsor — branding throughout the event' },
    { name: 'Coastal Wealth',          tier: 'hole_in_one',   price:  5_000_00, desc: 'Hole-in-one car prize sponsor' },
    { name: 'Half Moon Bay Brewing',   tier: 'beverage',      price:  3_500_00, desc: 'On-course beverage cart' },
    { name: 'Greenside Insurance',     tier: 'hole',          price:  2_500_00, desc: 'Hole 7 tee marker + signage' },
    { name: 'Bay Realty Group',        tier: 'cart',          price:  1_500_00, desc: 'Cart wraps + drink coupons' },
    { name: 'Pacific Trail Outfitters',tier: 'longest_drive', price:  1_000_00, desc: 'LD contest prize sponsor' },
  ];
  for (const s of sponsors) {
    const sp = await api('POST', `/api/admin/events/${ev.id}/packages`, {
      name: s.name, description: s.desc, price_cents: s.price, includes_players: 0,
      package_kind: 'sponsorship', sponsor_type: s.tier,
    }, tok);
    // PATCH a logo. In real life, an organizer uploads the partner's logo.
    await api('PATCH', `/api/admin/events/${ev.id}/packages/${sp.id}`, { image_data: tinyPng() }, tok);
  }

  // 6. Auction items
  console.log('[6] auction items');
  for (const a of [
    { title: 'Foursome at The Olympic Club — Lake Course', starting_bid_cents: 1_500_00,
      description: 'Coveted member-host foursome at The Olympic Club. Greens fees included.' },
    { title: 'Two nights, Carmel Valley Ranch', starting_bid_cents: 1_200_00,
      description: 'Two-night stay in a king suite with welcome bottle of wine.' },
    { title: 'TaylorMade fitting + driver of your choice', starting_bid_cents: 800_00,
      description: 'Full fitting at Pebble Beach Golf Academy + a brand-new Qi35 driver.' },
    { title: 'Behind-the-scenes pro shop tour + lesson', starting_bid_cents: 350_00,
      description: '1-hour private lesson with the head pro + an exclusive shop tour.' },
  ]) {
    await api('POST', `/api/admin/events/${ev.id}/auction/items`, {
      title: a.title, description: a.description,
      starting_bid_cents: a.starting_bid_cents,
      min_increment_cents: 25_00,
    }, tok).catch(e => console.log('  auction item failed: ' + e.message));
  }

  // 7. Registrations — 4 paid foursomes = 16 players, ~$10k contributed
  // Plus a handful of dinner-only seats to make the dashboard look lived-in.
  console.log('[7] registrations (4 foursomes + 5 dinner-only)');
  const reg = (body) => api('POST', `/api/admin/events/${ev.id}/registrations/manual`, body, tok)
    .catch(e => console.log('  manual reg failed: ' + e.message));

  const foursomes = [
    { team: 'Madrone Capital',     names: ['Patrick Wong', 'Jamie Lee', 'Sarah Kim', 'Marcus Chen'] },
    { team: 'Coastal Wealth',      names: ['Avery Singh', 'Diego Ramos', 'Priya Patel', 'Tom Nakamura'] },
    { team: 'Half Moon Bay Brew',  names: ['Riley Quinn', 'Ana Cruz', 'Ben Park', 'Mia Tanaka'] },
    { team: 'Greenside Group',     names: ['Owen Larsson', 'Zoe Martin', 'Cole Reyes', 'Eli Wright'] },
  ];

  // 8. Pairings — 4 groups, shotgun start, holes 1/5/10/15
  console.log('[8] pairings (4 groups, shotgun)');
  const holesByGroup = [1, 5, 10, 15];
  const cartsByGroup = ['12, 13', '14, 15', '16, 17', '18, 19'];
  for (let i = 0; i < foursomes.length; i++) {
    await api('POST', `/api/admin/events/${ev.id}/pairings/groups`, {
      name: foursomes[i].team,
      starting_hole: holesByGroup[i],
      tee_time: '8:30 AM',
      cart_numbers: cartsByGroup[i],
      sort_order: i,
    }, tok).catch(e => console.log('  pairing group failed: ' + e.message));
  }

  console.log('\n────────────────────────────────────────────────────');
  console.log('  Demo event seeded.');
  console.log('────────────────────────────────────────────────────');
  console.log('  Event id : ' + ev.id);
  console.log('  Slug     : ' + SLUG);
  console.log('');
  console.log('  Public:');
  console.log('    ' + BASE + '/e/' + SLUG);
  console.log('    ' + BASE + '/e/' + SLUG + '/auction');
  console.log('');
  console.log('  Admin (super only):');
  console.log('    ' + BASE + '/admin/events/' + ev.id);
  console.log('    ' + BASE + '/admin/events/' + ev.id + '/pairings');
  console.log('    ' + BASE + '/admin/events/' + ev.id + '/pairings/poster');
  console.log('    ' + BASE + '/admin/events/' + ev.id + '/site/edit');
  console.log('    ' + BASE + '/admin/events/' + ev.id + '/auction');
  process.exit(0);
})().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
