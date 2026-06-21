// AI Help Agent (#PHASE-3, v3.77) — Claude-powered chat for the admin console.
//
// Design notes:
// - Sonnet 4.6 is the model. Good quality for a domain-aware assistant
//   at a reasonable price (~$3/Mtok in, $15/Mtok out). Haiku would be
//   half the cost but less coherent across multi-turn convos; not worth
//   it for a usage-capped product.
// - System prompt uses prompt caching (cache_control: ephemeral) so the
//   long domain block is billed once per ~5-min cache window per session
//   instead of every turn. Big savings for chatty admins.
// - Daily token cap is enforced server-side (~50k tokens/day/admin by
//   default). Configurable via AI_HELP_DAILY_TOKEN_CAP env var.
// - Escalation: the assistant can suggest "want me to flag this for a
//   super admin?" via a system instruction. Explicit user-click also
//   triggers escalation. Both insert into ai_help_escalations.
'use strict';

const MODEL = 'claude-sonnet-4-6';
// Read env lazily — server.js hydrates process.env from .env AFTER this
// module gets required, so capturing at module-load time would always
// see the default. Callers should use `dailyTokenCap()` not the const.
function dailyTokenCap() {
  return Number(process.env.AI_HELP_DAILY_TOKEN_CAP) || 50_000;
}
// Roughly bound any single response so a runaway can't drain the cap in
// one call. 1500 output tokens ≈ ~6 paragraphs — plenty for the help
// chat's typical answer length.
const MAX_OUTPUT_TOKENS = 1500;

let _client = null;
function getClient() {
  if (_client) return _client;
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Long static block describing JORD's products so the assistant can give
// useful, JORD-specific answers instead of generic golf advice. Kept in
// one place so it can be cache_control'd as a single block.
function buildSystemBase() {
  return `You are the JORD Golf Help Agent — a friendly assistant embedded in the JORD Golf admin console. Your job is to help tournament organizers (most of them non-technical) run their events smoothly.

# About JORD Golf
JORD Golf is a SaaS platform with three products:

1. **Original LD/CTP contests** — Players scan a QR code on their golf ball after a shot to submit their distance via GPS. The platform measures longest drive and closest to pin per team. Admins set up a course map with tee boxes, fairway / rough / OOB / green polygons on a Mapbox satellite view.

2. **Clubhouse** (/clubhouse) — A 28-format scoring engine for casual rounds and tournaments. Formats include stroke play (gross / net), stableford, skins (with handicap-on/off and carryover-on/off toggles), erado, duplicate, match play (individual + team variants), nassau, bingo-bango-bongo, dots, snake, best ball (pair + team), 2-man / 4-man scramble, foursomes, chapman, vegas, sixes, low net team, irish rumble. Full WHS handicap math.

3. **Enterprise charity-tournament platform** — Brandable public event sites at /e/:slug. Online registration with Stripe Connect (3% platform fee). Day-of organizer tools: check-in, walk-up registration (with Stripe QR for cash-free desk sales), pairings + hole assignments, printed pairings poster. Silent auction (item intake, bidding, winner Stripe Checkout). Sponsorships with logos. Donations + fundraising goal bar. Event store (raffle / mulligans / merch).

# Admin navigation map
- **/admin** — Event list. Click an event to enter the editor.
- **/admin/events/:id** — Event editor with tabs:
  - Settings — name, venue, contests on/off (LD / CTP / combined), penalty rules, branding (logo + accent color)
  - Course map — Mapbox satellite with polygon drawing for fairway / rough / OOB / green, tee box + pin markers
  - Players / Ball pool — add ball codes; players scan to register
  - Registrations — sales dashboard, refunds, add-ons
  - Check-in — mobile-first check-in with walk-up support
  - Pairings — drag-and-drop groups + auto-assign + printed poster
  - Auction — silent auction items, bids, winner checkout
  - Site editor — public event site (slug, hero, sponsorships, donations)
- **/admin/shop** — JORD Shop (supplies marketplace, JORD as seller)
- **/admin/reps** — Tournament reps with per-event permission toggles

# Key facts you should know
- Stripe is currently in **sandbox mode** (sk_test_…). Real money requires #STRIPE-LIVE flip.
- All transactional email routes through Klaviyo. 4 Flows are Live; 5 are pending in the Klaviyo dashboard (most critically jord_password_reset).
- Each event admin has a "creator" status. Only the creator OR a super admin can delete an event.
- Sponsorships and registration packages share the same registration_packages table — they're distinguished by package_kind.
- The pairings page has a "↻ Sync to leaderboard" button that mirrors pairing_groups into score_groups.
- The printed pairings poster lives at /admin/events/:id/pairings/print and includes a "Thank you to our sponsors" strip with logos when sponsorships have image_data.

# How to be helpful
- Be **concise**. Short paragraphs, bullets when listing steps. Most admins are on mobile during an event.
- When pointing to a button or page, **name it exactly** — "click ✎ Edit on the course tile in your Clubhouse" rather than "edit the course".
- If you don't know the answer, **say so plainly**. Don't invent endpoints or features.
- If the admin seems stuck (multiple back-and-forths without progress, frustration words like "this is broken" or "doesn't work"), **proactively offer to flag the conversation for a super admin** — just suggest it, the admin will click the Escalate button.
- Don't speculate about Stripe payouts, tax forms, or legal questions. Refer the admin to a human / their accountant.
- You don't have access to live event data unless it's in the message context below. Don't pretend to look up status; ask the admin to share what they see on screen.`;
}

// Per-call dynamic context — kept SHORT so it changes per turn without
// busting the system-prompt cache. Composed from whatever the frontend
// passed in (current event id/name/status).
function buildContextLine(ctx) {
  if (!ctx) return null;
  const bits = [];
  if (ctx.event_id)     bits.push(`event id ${ctx.event_id}`);
  if (ctx.event_name)   bits.push(`name "${ctx.event_name}"`);
  if (ctx.event_status) bits.push(`status: ${ctx.event_status}`);
  if (ctx.page)         bits.push(`admin is on ${ctx.page}`);
  if (!bits.length) return null;
  return `[Current admin context: ${bits.join(' · ')}]`;
}

// Phrases that suggest the admin is stuck — used to flag an
// "escalation_suggested" hint in the response. The MODEL decides
// whether to actually mention escalation; this is just metadata.
const STUCK_PATTERNS = [
  /\b(broken|doesn'?t (work|load)|can'?t figure|stuck|not working|i give up|help me|need help|frustrat)/i,
  /\b(crash|error|fail|bug)/i,
];
function looksStuck(text) {
  if (!text) return false;
  return STUCK_PATTERNS.some(re => re.test(text));
}

// The chat call itself. `history` is an array of {role, content}
// alternating user/assistant. `userMessage` is the new user turn.
// `context` is { event_id, event_name, event_status, page } (any optional).
//
// Returns { reply, usage: {input, output, cache_creation, cache_read} }.
async function chat({ history = [], userMessage, context = null }) {
  const client = getClient();
  const systemBase = buildSystemBase();
  const ctxLine = buildContextLine(context);

  // System prompt as 2 blocks so the long static base can be cached
  // and the short dynamic context line stays variable.
  const systemBlocks = [
    { type: 'text', text: systemBase, cache_control: { type: 'ephemeral' } },
  ];
  if (ctxLine) systemBlocks.push({ type: 'text', text: ctxLine });

  // Build the messages array — history first, then this turn.
  const messages = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: userMessage });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemBlocks,
    messages,
  });
  const reply = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    reply,
    usage: {
      input:           res.usage.input_tokens || 0,
      output:          res.usage.output_tokens || 0,
      cache_creation:  res.usage.cache_creation_input_tokens || 0,
      cache_read:      res.usage.cache_read_input_tokens || 0,
    },
  };
}

module.exports = { chat, looksStuck, dailyTokenCap, MODEL };
