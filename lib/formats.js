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
 *             matchplay | skins | erado | duplicate
 *   net       true  → uses handicaps;  false → gross
 *   allowance WHS handicap allowance — a number (×course handicap) or a key
 *             ('scramble2' | 'scramble4' | 'foursomes' | 'greensome')
 *   teamSize  [min,max] players per competitor (1 = individual)
 *   scored    true → fully playable now; false → in the picker but not yet live
 *   desc      one-paragraph explanation (shown on the format detail screen)
 */

const FORMATS = [
  // ─── Individual ────────────────────────────────────────────────────────────
  { id: 'stroke_gross', name: 'Stroke Play', sub: 'Gross', tier: 'individual',
    engine: 'stroke', net: false, allowance: 1.0, teamSize: [1, 1], scored: true,
    desc: 'Every stroke counts toward a cumulative total. Lowest total wins. ' +
          'Played as scratch — no handicap.' },

  { id: 'stroke_net', name: 'Stroke Play', sub: 'Net', tier: 'individual',
    engine: 'stroke', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    desc: 'Stroke play using each player\'s WHS course handicap. Lowest net ' +
          'total wins. 95% handicap allowance.' },

  { id: 'stableford', name: 'Stableford', sub: 'Individual', tier: 'individual',
    engine: 'stableford', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    desc: 'Points are earned per hole vs net par — eagle 4, birdie 3, par 2, ' +
          'bogey 1, double bogey or worse 0. Highest total wins.' },

  { id: 'skins', name: 'Skins', sub: 'Stroke Play', tier: 'individual',
    engine: 'skins', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    desc: 'Each hole carries a value (a skin) won outright by the low score. ' +
          'A tied hole carries its skin to the next hole.' },

  { id: 'erado', name: 'Erado', sub: 'Stroke Play', tier: 'individual',
    engine: 'erado', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    desc: 'Stroke play where a set number of worst holes (typically 4 of 18) ' +
          'are erased from the total. The final hole cannot be erased.' },

  { id: 'duplicate', name: 'Duplicate', sub: 'Individual Stableford', tier: 'individual',
    engine: 'duplicate', net: true, allowance: 0.95, teamSize: [1, 1], scored: true,
    desc: 'Individual Stableford with a random 1×/2×/3× multiplier applied to ' +
          'each hole\'s points. The final hole is always worth double.' },

  { id: 'match_individual', name: 'Match Play', sub: 'Individual', tier: 'individual',
    engine: 'matchplay', net: true, allowance: 1.0, teamSize: [1, 1], scored: true,
    desc: 'Win more individual holes than your opponent. Scored hole-by-hole ' +
          'as holes up; a match can close out early (e.g. 3&2).' },

  // ─── Pair (2 players) ──────────────────────────────────────────────────────
  { id: 'better_ball_stroke', name: 'Better Ball', sub: 'Stroke Play', tier: 'pair',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [2, 2], scored: true,
    desc: '2-person best ball. Each player plays their own ball; the better ' +
          'score on each hole counts as the team score.' },

  { id: 'better_ball_stableford', name: 'Better Ball', sub: 'Stableford', tier: 'pair',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [2, 2], scored: true,
    desc: '2-person best ball scored with Stableford points — the higher ' +
          'points on each hole count as the team score.' },

  { id: 'scramble_2man', name: '2-Man Scramble', sub: 'Stroke Play', tier: 'pair',
    engine: 'scramble', net: true, allowance: 'scramble2', teamSize: [2, 2], scored: true,
    desc: 'Both players tee off; the better shot is chosen and both play on ' +
          'from there until holed. One team score per hole.' },

  { id: 'match_better_ball', name: 'Match Play', sub: 'Better Ball', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 0.9, teamSize: [2, 2], scored: true,
    desc: 'Match play between two pairs; each player plays their own ball and ' +
          'the better score counts as the team score on each hole.' },

  { id: 'match_foursome', name: 'Match Play', sub: 'Foursome', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'foursomes', teamSize: [2, 2], scored: true,
    desc: 'Match play foursomes — partners play one ball with alternating ' +
          'shots.' },

  { id: 'match_greensome', name: 'Match Play', sub: 'Greensome', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'greensome', teamSize: [2, 2], scored: true,
    desc: 'Match play greensome — both tee off, the better drive is chosen, ' +
          'then the ball is played alternately until holed.' },

  { id: 'match_scramble', name: 'Match Play', sub: 'Scramble', tier: 'pair',
    engine: 'matchplay', net: true, allowance: 'scramble2', teamSize: [2, 2], scored: true,
    desc: 'Match play scramble — two pairs play scramble rules head to head.' },

  // ─── Team (3–5 players) ────────────────────────────────────────────────────
  { id: 'best_ball_stroke', name: 'Best Ball', sub: 'Stroke Play', tier: 'team',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    desc: '3–5 person team best ball. Each player plays their own ball; the ' +
          'best 1–5 scores per hole (by group size) count as the team score.' },

  { id: 'best_ball_stableford', name: 'Best Ball', sub: 'Stableford', tier: 'team',
    engine: 'bestball', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    desc: '3–5 person best ball scored with Stableford points — the best ' +
          'points per hole count as the team score.' },

  { id: 'scramble_team', name: 'Scramble', sub: 'Stroke Play', tier: 'team',
    engine: 'scramble', net: true, allowance: 'scramble4', teamSize: [3, 5], scored: true,
    desc: '3–5 person scramble. Each player tees off, the best shot is chosen ' +
          'and all play on from there until holed. One team score per hole.' },

  { id: 'low_scratch_net', name: 'Low Scratch/Net', sub: 'Stroke Play', tier: 'team',
    engine: 'lownet', net: true, allowance: 0.85, teamSize: [3, 5], scored: true,
    desc: 'Team best ball where the best gross and best net scores on each ' +
          'hole are combined as the team score.' },

  { id: 'duplicate_scramble', name: 'Duplicate Scramble', sub: 'Stableford', tier: 'team',
    engine: 'duplicate', net: true, allowance: 'scramble4', teamSize: [3, 5], scored: true,
    desc: 'Classic scramble fused with the Duplicate format — a random 1×/2×/3× ' +
          'multiplier is applied to the team\'s Stableford points each hole.' },

  { id: 'irish_rumble', name: 'Irish Rumble', sub: 'Best Ball', tier: 'team',
    engine: 'rumble', net: true, allowance: 0.85, teamSize: [4, 5], scored: true,
    desc: '4–5 person best ball with Stableford points and an escalating count: ' +
          'holes 1–6 best 1 score, 7–12 best 2, 13–17 best 3, hole 18 all.' },
];

const BY_ID = Object.fromEntries(FORMATS.map(f => [f.id, f]));

function getFormat(id) { return BY_ID[id] || null; }
function isScored(id)  { return !!BY_ID[id]?.scored; }
function formatsByTier() {
  return {
    individual: FORMATS.filter(f => f.tier === 'individual'),
    pair:       FORMATS.filter(f => f.tier === 'pair'),
    team:       FORMATS.filter(f => f.tier === 'team'),
  };
}

module.exports = { FORMATS, getFormat, isScored, formatsByTier };
