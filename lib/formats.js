/**
 * formats.js — catalog of game formats (Gamebook-style).
 *
 * Each format is a scoring base applied at a grouping tier. The catalog drives
 * the wizard's format picker and tells the scoring engine how to rank a round.
 *
 * Fields:
 *   id        stable key, stored on rounds.format
 *   name      display name      sub   subtitle (the scoring base)
 *   tier      individual | pair | team
 *   engine    scoring-engine key: stroke | stableford | scramble | bestball |
 *             matchplay | skins | erado | duplicate | vegas | nassau |
 *             bbb | dots | snake | chapman | sixes | foursomes_stroke
 *   net       true  → uses handicaps;  false → gross
 *   allowance WHS handicap allowance — a number (×course handicap) or a key
 *             ('scramble2' | 'scramble4' | 'foursomes' | 'greensome')
 *   teamSize  [min,max] players per competitor (1 = individual)
 *   scored    true → fully playable now;
 *             false → in the picker but not yet live (auto-leaderboard pending)
 *   manualScoring true → playable, but the leaderboard tally is entered by the
 *             organizer rather than computed from strokes (Snake, BBB, Dots).
 *   desc      one-paragraph explanation (shown on the format detail bubble)
 *   emoji     per-format icon — picked for fun, not engine grouping
 *   settings  optional schema of wagering / point inputs the wizard renders
 *             when this format is picked. Each item:
 *               { key, label, type, default, min, max, step, hint }
 *             type: 'money' (USD) | 'cents' | 'number'
 */

// ── Default point-config templates used by Bingo Bango Bongo, Dots, Snake ──
// These are starting points the player can override in the wizard.
const DOTS_DEFAULTS = [
  { key: 'greenie',   label: 'Greenie (on green in regulation closest to pin)', points: 1 },
  { key: 'sandy',     label: 'Sandy (par or better after a bunker shot)',       points: 1 },
  { key: 'birdie',    label: 'Birdie',                                          points: 2 },
  { key: 'eagle',     label: 'Eagle',                                           points: 4 },
  { key: 'polly',     label: 'Polly (par after hitting a tree / cart path)',    points: 1 },
  { key: 'arnie',     label: 'Arnie (par without hitting the fairway)',         points: 1 },
  { key: 'fish',      label: 'Fish (a water-ball penalty)',                     points: -1 },
];

const FORMATS = [
  // ─── Individual ────────────────────────────────────────────────────────────
  { id: 'stroke_gross', name: 'Stroke Play', sub: 'Gross', tier: 'individual',
    engine: 'stroke', net: false, allowance: 1.0, teamSize: [1, 1], scored: true,
    emoji: '⛳',
    desc: 'Every stroke counts toward a cumulative total. Lowest total wins. ' +
          'Played as scratch — no handicap.' },

  { id: 'stroke_net', name: 'Stroke Play', sub: 'Net', tier: 'individual',
    engine: 'stroke', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '🎯',
    desc: 'Stroke play using each player\'s WHS course handicap. Lowest net ' +
          'total wins. 95% handicap allowance.' },

  { id: 'stableford', name: 'Stableford', sub: 'Individual', tier: 'individual',
    engine: 'stableford', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '🏅',
    desc: 'Points are earned per hole vs net par — eagle 4, birdie 3, par 2, ' +
          'bogey 1, double bogey or worse 0. Highest total wins.' },

  { id: 'skins', name: 'Skins', sub: 'Stroke Play', tier: 'individual',
    engine: 'skins', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '💰',
    desc: 'Each hole carries a value (a skin) won outright by the low score. ' +
          'A tied hole carries to the next hole.',
    settings: [
      { key: 'value_per_skin', label: 'Value per skin', type: 'money', default: 5, min: 0.25, step: 0.25,
        hint: 'What each skin is worth ($). The leaderboard shows skins won × this rate.' },
      { key: 'allow_handicaps', label: 'Use handicaps (low net wins)', type: 'toggle', default: true,
        hint: 'ON: low NET score wins each skin. OFF: low GROSS (raw) score wins — handicaps are ignored.' },
    ] },

  { id: 'erado', name: 'Erado', sub: 'Stroke Play', tier: 'individual',
    engine: 'erado', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '✂️',
    desc: 'Stroke play where a set number of worst holes (typically 4 of 18) ' +
          'are erased from the total. The final hole cannot be erased.' },

  { id: 'duplicate', name: 'Duplicate', sub: 'Individual Stableford', tier: 'individual',
    engine: 'duplicate', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '🎲',
    desc: 'Individual Stableford with a random 1×/2×/3× multiplier applied to ' +
          'each hole\'s points. The final hole is always worth double.' },

  { id: 'match_individual', name: 'Match Play', sub: 'Individual', tier: 'individual',
    engine: 'matchplay', net: true, allowance: 1.0, teamSize: [1, 1], scored: true,
    emoji: '⚔️',
    desc: 'Win more individual holes than your opponent. Scored hole-by-hole ' +
          'as holes up; a match can close out early (e.g. 3&2).' },

  // ─── Side games (individual, mostly money / points) ──────────────────────
  { id: 'nassau', name: 'Nassau', sub: 'Front / Back / Total', tier: 'individual',
    engine: 'nassau', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    emoji: '🏆',
    desc: 'The classic three-way bet: a separate match for the front 9, the ' +
          'back 9, and the overall 18. Famous for "press" bets too.',
    settings: [
      { key: 'front_bet', label: 'Front 9 bet',  type: 'money', default: 5, min: 0, step: 1,
        hint: 'What the front-9 match is worth ($).' },
      { key: 'back_bet',  label: 'Back 9 bet',   type: 'money', default: 5, min: 0, step: 1,
        hint: 'What the back-9 match is worth ($).' },
      { key: 'total_bet', label: 'Total 18 bet', type: 'money', default: 5, min: 0, step: 1,
        hint: 'What the overall 18-hole match is worth ($).' },
    ] },

  { id: 'bingo_bango_bongo', name: 'Bingo Bango Bongo', sub: 'Points per hole', tier: 'individual',
    engine: 'bbb', net: false, allowance: 1.0, teamSize: [1, 1], scored: true,
    emoji: '🔔',
    desc: 'Three points up for grabs every hole: 🟢 Bingo (first on green), ' +
          '🎯 Bango (closest to pin once everyone\'s on), 🥁 Bongo (first to hole out).',
    settings: [
      { key: 'pts_bingo', label: 'Points — Bingo (first on green)',          type: 'number', default: 1, min: 0, step: 1 },
      { key: 'pts_bango', label: 'Points — Bango (closest to pin)',          type: 'number', default: 1, min: 0, step: 1 },
      { key: 'pts_bongo', label: 'Points — Bongo (first to hole out)',       type: 'number', default: 1, min: 0, step: 1 },
      { key: 'value_per_point', label: 'Value per point (optional)',         type: 'money',  default: 0, min: 0, step: 0.25,
        hint: 'Set to $0 for fun-only. Otherwise the leaderboard converts points to dollars.' },
    ] },

  { id: 'dots', name: 'Dots', sub: 'Garbage', tier: 'individual',
    engine: 'dots', net: false, allowance: 1.0, teamSize: [1, 1], scored: true,
    emoji: '🎰',
    desc: 'Earn (or lose) points for specific events on each hole — greenies, ' +
          'sandies, polly, arnie, birdies, eagles, fish, you name it. Group ' +
          'sets the menu and value.',
    settings: [
      { key: 'events',          label: 'Event point values', type: 'dots_events', default: DOTS_DEFAULTS,
        hint: 'Tap a row to edit the point value, or rename / add / remove events. Players can mark events themselves on the scorecard.' },
      { key: 'value_per_point', label: 'Value per point', type: 'money', default: 0, min: 0, step: 0.25,
        hint: 'Set $0 for points-only. Otherwise the final tally is point-total × this rate.' },
    ] },

  { id: 'snake', name: 'Snake', sub: 'Three-putt penalty', tier: 'individual',
    engine: 'snake', net: false, allowance: 1.0, teamSize: [1, 1], scored: true,
    emoji: '🐍',
    desc: 'The first player to three-putt holds the snake. Anyone else who ' +
          'three-putts after that takes it from them. Whoever holds the ' +
          'snake at the end of the round pays the penalty.',
    settings: [
      { key: 'snake_penalty', label: 'Snake penalty', type: 'money', default: 20, min: 0, step: 5,
        hint: 'What the player holding the snake at the end of the round pays.' },
    ] },

  // ─── Pair (2 players) ──────────────────────────────────────────────────────
  { id: 'better_ball_stroke', name: 'Better Ball', sub: 'Stroke Play', tier: 'pair',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [2, 2], scored: true,
    emoji: '🔥',
    desc: '2-person best ball. Each player plays their own ball; the better ' +
          'score on each hole counts as the team score.' },

  { id: 'better_ball_stableford', name: 'Better Ball', sub: 'Stableford', tier: 'pair',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [2, 2], scored: true,
    emoji: '🥇',
    desc: '2-person best ball scored with Stableford points — the higher ' +
          'points on each hole count as the team score.' },

  { id: 'scramble_2man', name: '2-Man Scramble', sub: 'Stroke Play', tier: 'pair',
    engine: 'scramble', net: true, allowance: 'scramble2', teamSize: [2, 2], scored: true,
    emoji: '🤝',
    desc: 'Both players tee off; the better shot is chosen and both play on ' +
          'from there until holed. One team score per hole.' },

  { id: 'foursomes_stroke', name: 'Alternate Shot', sub: 'Foursomes (Stroke)', tier: 'pair',
    engine: 'scramble', net: true, allowance: 'foursomes', teamSize: [2, 2], scored: true,
    emoji: '🔁',
    desc: 'Partners play one ball; one tees off on odd holes, the other on ' +
          'even, then they alternate every shot until holed. Stroke play.' },

  { id: 'chapman', name: 'Chapman', sub: 'Pinehurst', tier: 'pair',
    engine: 'scramble', net: true, allowance: 'foursomes', teamSize: [2, 2], scored: true,
    emoji: '🌲',
    desc: 'Both players tee off, then switch balls for the second shots. ' +
          'After both second shots, pick the better ball and finish the hole ' +
          'with alternate shots.' },

  { id: 'vegas', name: 'Vegas', sub: 'Two-pair gambling', tier: 'pair',
    engine: 'vegas', net: true, allowance: 0.85, teamSize: [2, 2], scored: true,
    emoji: '🎲',
    desc: 'Pairs combine their two scores into a 2-digit number (lower score ' +
          'first — a 4 and a 5 = 45). Lowest combined per hole wins the ' +
          'difference at the configured rate.',
    settings: [
      { key: 'value_per_point', label: 'Value per point', type: 'money', default: 1, min: 0, step: 0.25,
        hint: '$ per point of margin per hole. $1/point is classic; cents-only is a friendlier game.' },
      { key: 'flip_birdie',    label: 'Birdie flips the loser\'s number', type: 'toggle', default: true,
        hint: 'House rule: when a player birdies, the opposing pair has to put their HIGHER score first. Multiplies the margin fast.' },
    ] },

  { id: 'sixes', name: 'Sixes', sub: 'Round Robin pairs', tier: 'individual',
    engine: 'sixes', net: true, allowance: 0.85, teamSize: [1, 1], scored: true,
    emoji: '🔄',
    desc: 'Four players, pairings change every six holes — so every player ' +
          'partners with each other player for six holes. Best ball within ' +
          'each six-hole segment.' },

  { id: 'match_better_ball', name: 'Match Play', sub: 'Better Ball', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 0.9, teamSize: [2, 2], scored: true,
    emoji: '⚔️',
    desc: 'Match play between two pairs; each player plays their own ball and ' +
          'the better score counts as the team score on each hole.' },

  { id: 'match_foursome', name: 'Match Play', sub: 'Foursome', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'foursomes', teamSize: [2, 2], scored: true,
    emoji: '🔁',
    desc: 'Match play foursomes — partners play one ball with alternating ' +
          'shots.' },

  { id: 'match_greensome', name: 'Match Play', sub: 'Greensome', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'greensome', teamSize: [2, 2], scored: true,
    emoji: '🌿',
    desc: 'Match play greensome — both tee off, the better drive is chosen, ' +
          'then the ball is played alternately until holed.' },

  { id: 'match_scramble', name: 'Match Play', sub: 'Scramble', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'scramble2', teamSize: [2, 2], scored: true,
    emoji: '⚡',
    desc: 'Match play scramble — two pairs play scramble rules head to head.' },

  // ─── Team (3–5 players) ────────────────────────────────────────────────────
  { id: 'best_ball_stroke', name: 'Best Ball', sub: 'Stroke Play', tier: 'team',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    emoji: '🏌️',
    desc: '3–5 person team best ball. Each player plays their own ball; the ' +
          'best 1–5 scores per hole (by group size) count as the team score.' },

  { id: 'best_ball_stableford', name: 'Best Ball', sub: 'Stableford', tier: 'team',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    emoji: '🎖️',
    desc: '3–5 person best ball scored with Stableford points — the best ' +
          'points per hole count as the team score.' },

  { id: 'scramble_team', name: 'Scramble', sub: 'Stroke Play', tier: 'team',
    engine: 'scramble', net: true, allowance: 'scramble4', teamSize: [3, 5], scored: true,
    emoji: '🤝',
    desc: '3–5 person scramble. Each player tees off, the best shot is chosen ' +
          'and all play on from there until holed. One team score per hole.' },

  { id: 'low_scratch_net', name: 'Low Scratch/Net', sub: 'Stroke Play', tier: 'team',
    engine: 'lownet', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    emoji: '📊',
    desc: 'Team best ball where the best gross and best net scores on each ' +
          'hole are combined as the team score.' },

  { id: 'duplicate_scramble', name: 'Duplicate Scramble', sub: 'Stableford', tier: 'team',
    engine: 'duplicate', net: true, allowance: 'scramble4', teamSize: [3, 5], scored: true,
    emoji: '🎲',
    desc: 'Classic scramble fused with the Duplicate format — a random 1×/2×/3× ' +
          'multiplier is applied to the team\'s Stableford points each hole.' },

  { id: 'irish_rumble', name: 'Irish Rumble', sub: 'Best Ball', tier: 'team',
    engine: 'rumble', net: true, allowance: 0.85, teamSize: [4, 5], scored: true,
    emoji: '☘️',
    desc: '4–5 person best ball with Stableford points and an escalating count: ' +
          'holes 1–6 best 1 score, 7–12 best 2, 13–17 best 3, hole 18 all.' },
];

const BY_ID = Object.fromEntries(FORMATS.map(f => [f.id, f]));

// Side-bet compatibility (v3.60). A side-bet is a second format that runs on
// the SAME scorecard as the primary format and produces its own leaderboard
// (e.g. Stroke Play Net + Skins side-bet). The primary's engine still tallies
// the standings; the side-bet's engine tallies the wager.
//
// Conservative pass: only Skins is offered as a side-bet for now. Skins works
// off net-strokes-per-hole, which any of these per-hole engines already
// compute — so the math composes cleanly without a new engine.
const SKINS_COMPATIBLE_PRIMARY_ENGINES = new Set([
  'stroke', 'stableford', 'scramble', 'bestball',
  'duplicate', 'rumble', 'lownet',
]);

/** List the formats that can be added as a side-bet on top of the given
 *  primary format. Always returns a (possibly empty) array of format catalog
 *  entries; never returns the primary itself.
 */
function compatibleSideBets(primaryId) {
  const primary = BY_ID[primaryId];
  if (!primary) return [];
  const out = [];
  if (SKINS_COMPATIBLE_PRIMARY_ENGINES.has(primary.engine) && primary.id !== 'skins') {
    out.push(BY_ID.skins);
  }
  return out.filter(Boolean);
}

function getFormat(id) { return BY_ID[id] || null; }
function isScored(id)  { return !!BY_ID[id]?.scored; }
function isManualScoring(id) { return !!BY_ID[id]?.manualScoring; }
function getSettingsSchema(id) { return BY_ID[id]?.settings || []; }
/** Whether the picker should let the user select this format. Manual-scoring
 *  formats are pickable even though they aren't auto-tallied yet. */
function isPickable(id) {
  const f = BY_ID[id];
  return !!(f && (f.scored || f.manualScoring));
}
/** Compute the default settings object for a format — keys → default values. */
function defaultSettings(id) {
  const schema = getSettingsSchema(id);
  const out = {};
  for (const s of schema) out[s.key] = s.default;
  return out;
}
function formatsByTier() {
  return {
    individual: FORMATS.filter(f => f.tier === 'individual'),
    pair:       FORMATS.filter(f => f.tier === 'pair'),
    team:       FORMATS.filter(f => f.tier === 'team'),
  };
}

module.exports = { FORMATS, getFormat, isScored, isManualScoring, isPickable,
                   getSettingsSchema, defaultSettings, formatsByTier, DOTS_DEFAULTS,
                   compatibleSideBets };
