/**
 * simulator.js — runs realistic-but-deterministic sample rounds through every
 * format in the catalog so the user can sanity-check the scoring engines.
 *
 * For each format the simulator:
 *   1. Decides who plays (1, 2, or 4 players, with team labels for pair/team
 *      formats).
 *   2. Fabricates a course layout — 18 holes, par 72, a mix of par-3/4/5.
 *   3. Generates per-hole scores using a seeded deterministic distribution so
 *      the same format always returns the same result on every run.
 *   4. Feeds the entries into scoring.buildLeaderboard() with the format's
 *      default settings.
 *   5. Returns:
 *        - the format catalog entry
 *        - the player roster with course handicaps
 *        - the scorecard (per-player per-hole gross + net)
 *        - the computed leaderboard
 *        - for manual-scoring formats, a structured "what gets scored manually"
 *          note so the UI can render a placeholder
 *
 * Pure-function — no DB writes, no HTTP. Safe to call from anywhere.
 */
'use strict';

const scoring = require('../../lib/scoring');
const formats = require('../../lib/formats');

// 18-hole par-72 layout — modeled after a typical American course.
const STANDARD_HOLES = [
  { hole_number: 1,  par: 4, stroke_index: 9  },
  { hole_number: 2,  par: 5, stroke_index: 17 },
  { hole_number: 3,  par: 3, stroke_index: 13 },
  { hole_number: 4,  par: 4, stroke_index: 1  },
  { hole_number: 5,  par: 4, stroke_index: 11 },
  { hole_number: 6,  par: 4, stroke_index: 7  },
  { hole_number: 7,  par: 3, stroke_index: 15 },
  { hole_number: 8,  par: 5, stroke_index: 3  },
  { hole_number: 9,  par: 4, stroke_index: 5  },
  { hole_number: 10, par: 4, stroke_index: 10 },
  { hole_number: 11, par: 5, stroke_index: 18 },
  { hole_number: 12, par: 3, stroke_index: 14 },
  { hole_number: 13, par: 4, stroke_index: 2  },
  { hole_number: 14, par: 4, stroke_index: 12 },
  { hole_number: 15, par: 4, stroke_index: 8  },
  { hole_number: 16, par: 3, stroke_index: 16 },
  { hole_number: 17, par: 5, stroke_index: 4  },
  { hole_number: 18, par: 4, stroke_index: 6  },
];

// Mulberry32 PRNG — deterministic seeded random so the simulator always
// returns the same sample for a given format.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Roll a per-hole score for a player given their skill level (lower is better).
// skillBias is the player's expected score over par (e.g. 0.5 = bogey golfer).
function rollScore(rand, par, skillBias) {
  // Base bias: skillBias strokes over par on average. Volatility scales with
  // par (par-3s are tighter; par-5s have more spread).
  const volatility = par === 3 ? 0.6 : par === 5 ? 1.1 : 0.8;
  const r = rand();
  // Roughly normal-ish using two uniforms. Center on (par + skillBias).
  const noise = (r - rand()) * volatility * 2;
  const raw = par + skillBias + noise;
  // Clamp realistically: a 7 on a par 3, a 12 on a par 5 etc. is the worst.
  const min = par - 2, max = par + 6;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

// Per-player skill profile. Mix of low / mid / high handicap on purpose so the
// scoring engines (especially net-allowance formats) have something to chew on.
function profile(name, handicapIndex, teamName) {
  return { name, handicapIndex, teamName: teamName || null };
}

// Course-handicap mapping for the simulator's stock 72/113-slope layout. We
// just use the index as the course handicap (slope-rating ~ 113 / par 72).
// Format allowance is applied by the engine via the entry's courseHandicap.
function courseHcp(handicapIndex, allowance) {
  if (handicapIndex == null) return 0;
  const raw = Math.round(handicapIndex);
  if (typeof allowance === 'number') return Math.round(raw * allowance);
  return raw; // string-allowance formats compute team handicap upstream
}

// Pick a roster sized to the format. Tournament-style fields — bigger than
// one foursome so we exercise the engines at realistic scale (a Vegas
// tournament might have 8 pairs round-robin, a Best Ball team event might
// have 4 teams of 4, etc.).
/** Fabricate sample hole_events so BBB / Dots / Snake leaderboards show
 *  meaningful output in the verification harness. Deterministic from `seed`.
 *  Returns [] for any format that doesn't need events. */
function fabricateEventsFor(fmt, entries, settings, seed) {
  if (!['bbb', 'dots', 'snake'].includes(fmt.engine)) return [];
  const rand = rng(seed + 7331);
  const events = [];
  if (fmt.engine === 'bbb') {
    // Rotate winners through bingo/bango/bongo. Lower-handicap players win
    // bingo/bango more often (first on green / closest to pin); higher-
    // handicap players occasionally luck into a bongo (first to hole out).
    for (const h of STANDARD_HOLES) {
      const bingoIdx = Math.floor(rand() * entries.length);
      const bangoIdx = Math.floor(rand() * entries.length);
      const bongoIdx = Math.floor(rand() * entries.length);
      events.push({ hole_number: h.hole_number, entry_id: entries[bingoIdx].entryId, event_key: 'bingo' });
      events.push({ hole_number: h.hole_number, entry_id: entries[bangoIdx].entryId, event_key: 'bango' });
      events.push({ hole_number: h.hole_number, entry_id: entries[bongoIdx].entryId, event_key: 'bongo' });
    }
  } else if (fmt.engine === 'dots') {
    const eventList = Array.isArray(settings?.events) ? settings.events : [];
    // Drop a handful of random dots across the round so the leaderboard has signal.
    for (let i = 0; i < entries.length * 4; i++) {
      const player = entries[Math.floor(rand() * entries.length)];
      const ev     = eventList[Math.floor(rand() * eventList.length)];
      const hole   = STANDARD_HOLES[Math.floor(rand() * STANDARD_HOLES.length)];
      if (ev) events.push({ hole_number: hole.hole_number, entry_id: player.entryId, event_key: ev.key });
    }
  } else if (fmt.engine === 'snake') {
    // 2-3 three-putts during the round; whoever 3-putts last holds the snake.
    const n = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const player = entries[Math.floor(rand() * entries.length)];
      const hole   = STANDARD_HOLES[Math.floor(rand() * STANDARD_HOLES.length)];
      events.push({ hole_number: hole.hole_number, entry_id: player.entryId, event_key: 'three_putt',
                    created_at: 'h' + String(hole.hole_number).padStart(2, '0') + '_' + i });
    }
  }
  return events;
}

function rosterForFormat(fmt) {
  // Sixes is fundamentally a 4-player rotation — engine requires exactly 4.
  if (fmt.id === 'sixes') {
    return [
      profile('Alex (4.0)',     4.0),  profile('Brooke (12.5)', 12.5),
      profile('Cam (18.0)',    18.0),  profile('Drew (24.0)',   24.0),
    ];
  }
  // Nassau is classically head-to-head; the engine accepts 2 individuals
  // or 2 pair-teams. We use 2 for the simulator so the leaderboard reads
  // cleanly.
  if (fmt.id === 'nassau') {
    return [
      profile('Alex (4.0)',     4.0),  profile('Brooke (12.5)', 12.5),
    ];
  }
  if (fmt.tier === 'individual') {
    // 8 individual players — covers a typical 2-foursome casual round.
    return [
      profile('Alex (4.0)',     4.0),  profile('Brooke (12.5)', 12.5),
      profile('Cam (18.0)',    18.0),  profile('Drew (24.0)',   24.0),
      profile('Erin (8.0)',     8.0),  profile('Finn (16.5)',   16.5),
      profile('Grace (22.0)',  22.0),  profile('Hank (10.0)',   10.0),
    ];
  }
  if (fmt.tier === 'pair') {
    // 16 players in 8 pairs — exercises round-robin pair scoring (Vegas) and
    // multi-pair leaderboards (Match Play / Better Ball).
    return [
      profile('Alex (4.0)',     4.0,  'Pair A1'), profile('Brooke (12.5)', 12.5, 'Pair A1'),
      profile('Cam (18.0)',    18.0,  'Pair A2'), profile('Drew (24.0)',   24.0, 'Pair A2'),
      profile('Erin (8.0)',     8.0,  'Pair B1'), profile('Finn (16.5)',   16.5, 'Pair B1'),
      profile('Grace (22.0)',  22.0,  'Pair B2'), profile('Hank (10.0)',   10.0, 'Pair B2'),
      profile('Ivy (14.0)',    14.0,  'Pair C1'), profile('Jordan (6.0)',   6.0, 'Pair C1'),
      profile('Kai (20.0)',    20.0,  'Pair C2'), profile('Liam (11.0)',   11.0, 'Pair C2'),
      profile('Mia (5.5)',      5.5,  'Pair D1'), profile('Noah (15.0)',   15.0, 'Pair D1'),
      profile('Olive (19.0)',  19.0,  'Pair D2'), profile('Pete (13.0)',   13.0, 'Pair D2'),
    ];
  }
  // 4 teams of 4 — typical team-event field. The bestball engine groups by
  // teamName so the leaderboard shows 4 ranked teams.
  return [
    profile('Alex (4.0)',     4.0,  'The Birdies'),  profile('Brooke (12.5)', 12.5, 'The Birdies'),
    profile('Cam (18.0)',    18.0,  'The Birdies'),  profile('Drew (24.0)',   24.0, 'The Birdies'),
    profile('Erin (8.0)',     8.0,  'The Eagles'),   profile('Finn (16.5)',   16.5, 'The Eagles'),
    profile('Grace (22.0)',  22.0,  'The Eagles'),   profile('Hank (10.0)',   10.0, 'The Eagles'),
    profile('Ivy (14.0)',    14.0,  'The Bogeys'),   profile('Jordan (6.0)',   6.0, 'The Bogeys'),
    profile('Kai (20.0)',    20.0,  'The Bogeys'),   profile('Liam (11.0)',   11.0, 'The Bogeys'),
    profile('Mia (5.5)',      5.5,  'The Albatross'),profile('Noah (15.0)',   15.0, 'The Albatross'),
    profile('Olive (19.0)',  19.0,  'The Albatross'),profile('Pete (13.0)',   13.0, 'The Albatross'),
  ];
}

// Convert a profile to a scoring engine `entry` (with per-hole scores filled in).
function buildEntry(p, fmt, holes, seed) {
  const rand = rng(seed);
  // Skill bias: roughly handicap / 18 strokes over par per hole, dampened.
  const skillBias = (p.handicapIndex || 0) * 0.55 / 18;
  const scores = {};
  for (const h of holes) scores[h.hole_number] = rollScore(rand, h.par, skillBias);
  const cHcp = courseHcp(p.handicapIndex, fmt.allowance);
  return {
    entryId: 'ENT_' + p.name.replace(/\s+/g, '_'),
    playerName: p.name,
    teamId: p.teamName ? 'TEAM_' + p.teamName.replace(/\s+/g, '_') : undefined,
    teamName: p.teamName || undefined,
    courseHandicap: cHcp,
    holes,
    scores,
  };
}

// Compute one scoreType-labeled column the UI can render alongside the leaderboard.
function describeScoring(fmt) {
  switch (fmt.engine) {
    case 'stroke':     return fmt.net ? 'Net strokes' : 'Gross strokes';
    case 'stableford': return 'Stableford points';
    case 'scramble':   return 'Team strokes (one ball)';
    case 'bestball':   return 'Best of N net scores per hole';
    case 'matchplay':  return 'Holes up (e.g. "3 UP")';
    case 'skins':      return 'Skins won (low net per hole)';
    case 'erado':      return 'Net total minus worst-N holes';
    case 'duplicate':  return 'Stableford × random 1×/2×/3× per hole';
    case 'vegas':      return 'Combined-pair 2-digit margin';
    case 'lownet':     return 'Best gross + best net per hole';
    case 'rumble':     return 'Best 1 / 2 / 3 / all per six-hole stretch';
    case 'nassau':     return 'Three matches: front 9 / back 9 / total 18';
    case 'sixes':      return 'Rotating-pair best ball every 6 holes';
    // Chapman + Foursomes Stroke route through the scramble engine now (single
    // team ball per hole, scored as stroke play). They never hit describeScoring
    // via the legacy engine names but we keep these strings for safety.
    case 'chapman':    return 'Pinehurst alternate-shot pair (one ball)';
    case 'foursomes_stroke': return 'Alt-shot one ball stroke play';
    case 'bbb':        return 'Points: 🟢 bingo + 🎯 bango + 🥁 bongo (tap each hole on the scorecard)';
    case 'dots':       return 'Points per event (greenie / sandy / fish — tap each player on the scorecard)';
    case 'snake':      return '3-putt holder pays penalty (tap 3-putters on the scorecard)';
  }
  return fmt.engine;
}

// Run one format and return everything the UI needs to display it.
function simulateFormat(fmt, seed = 42) {
  const holes = STANDARD_HOLES;
  const roster = rosterForFormat(fmt);
  // Per-player seed = base seed + name hash, so each player gets a different
  // score sequence but the OVERALL sample is reproducible.
  let nameSeed = 0;
  const entries = roster.map(p => {
    nameSeed = (nameSeed * 33 + p.name.charCodeAt(0)) >>> 0;
    return buildEntry(p, fmt, holes, seed + nameSeed);
  });

  // For event-based engines (BBB / Dots / Snake), fabricate some sample
  // hole_events so the simulator's leaderboard isn't an empty all-zeros
  // sheet. Deterministic from the seed; rotates winners hole-by-hole.
  const settings = formats.defaultSettings(fmt.id);
  const fakeEvents = fabricateEventsFor(fmt, entries, settings, seed);

  // Build the leaderboard via the real scoring engine (or null for non-scored).
  let leaderboard = null;
  if (fmt.scored) {
    const opts = {
      format: fmt.id,
      format_settings: settings,
      multipliers: fmt.engine === 'duplicate'
        ? holes.map((_, i) => [1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 1, 3, 1, 1, 2, 1, 1, 2][i] || 1) : null,
      holeEvents: fakeEvents,
    };
    leaderboard = scoring.buildLeaderboard(entries, opts);
  }

  // Surface a hole-by-hole scorecard the UI can render as a table.
  const scorecard = entries.map(e => {
    const strokes = strokesPerHole(e.courseHandicap || 0, holes);
    const rows = holes.map(h => ({
      hole: h.hole_number,
      par: h.par,
      gross: e.scores[h.hole_number],
      strokesGiven: strokes[h.hole_number] || 0,
      net: e.scores[h.hole_number] - (strokes[h.hole_number] || 0),
    }));
    const totalGross = rows.reduce((a, r) => a + r.gross, 0);
    const totalPar   = holes.reduce((a, h) => a + h.par, 0);
    const totalNet   = rows.reduce((a, r) => a + r.net, 0);
    return {
      entryId: e.entryId,
      playerName: e.playerName,
      teamName: e.teamName,
      courseHandicap: e.courseHandicap,
      rows,
      totalGross, totalPar, totalNet,
    };
  });

  return {
    formatId: fmt.id,
    name: fmt.name,
    sub: fmt.sub,
    tier: fmt.tier,
    emoji: fmt.emoji,
    engine: fmt.engine,
    scored: !!fmt.scored,
    manualScoring: !!fmt.manualScoring,
    description: fmt.desc,
    scoringExplained: describeScoring(fmt),
    settings: fmt.settings || [],
    settingsApplied: formats.defaultSettings(fmt.id),
    courseLayout: holes,
    scorecard,
    leaderboard,
  };
}

// Re-export the WHS strokes-per-hole helper from scoring so we can also
// expose it on the scorecard (which scoring.entryNet already uses).
function strokesPerHole(courseHcp, holes) {
  const cap = Math.max(0, Math.round(courseHcp || 0));
  const out = {};
  for (let i = 1; i <= cap; i++) {
    const target = ((i - 1) % 18) + 1;
    const hole = holes.find(h => h.stroke_index === target);
    if (hole) out[hole.hole_number] = (out[hole.hole_number] || 0) + 1;
  }
  return out;
}

// Run every format in the catalog. Returns an array of simulateFormat() outputs.
function simulateAll(seed = 42) {
  return formats.FORMATS.map(f => simulateFormat(f, seed));
}

module.exports = { simulateFormat, simulateAll, STANDARD_HOLES, rosterForFormat };
