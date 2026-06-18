/**
 * scoring.js — scoring engine.
 *
 * Pure functions, no I/O — unit-testable. The server gathers a round's entries
 * into the shape below and `buildLeaderboard` returns a ranked leaderboard for
 * the round's format.
 *
 * Live now: stroke play (gross/net), Stableford, scramble. Scramble reuses the
 * stroke engine — a scramble "entry" is simply a team card with one set of
 * hole scores and a team handicap. Best ball / match play / skins / exotic
 * formats arrive in later phases.
 *
 * entry = {
 *   entryId, playerName, teamName, courseHandicap,
 *   holes:  [{ hole_number, par, stroke_index }],   // from the assigned tee
 *   scores: { <hole_number>: strokes }               // missing = not played
 * }
 */

const { strokesPerHole } = require('./handicap');
const { getFormat } = require('./formats');

/** Regular Stableford points for a net score on one hole. */
function stablefordPoints(netStrokes, par) {
  return Math.max(0, 2 - (netStrokes - par));
}

/** Score one entry: stroke totals (gross/net, to-par) and Stableford points. */
function scoreEntry(entry) {
  const holesByNum = {};
  for (const h of entry.holes || []) holesByNum[h.hole_number] = h;
  // Manual override (v3.64) wins over the auto WHS allocation when present.
  const auto = strokesPerHole(entry.courseHandicap, entry.holes || []);
  const strokeMap = (entry.strokeOverrides && typeof entry.strokeOverrides === 'object')
    ? entry.strokeOverrides : auto;

  let gross = 0, parPlayed = 0, netStrokes = 0, thru = 0, points = 0;
  for (const [hole, strokes] of Object.entries(entry.scores || {})) {
    if (strokes == null) continue;
    const par = holesByNum[hole] ? Number(holesByNum[hole].par) || 0 : 0;
    const received = strokeMap[hole] || 0;
    gross += Number(strokes);
    parPlayed += par;
    netStrokes += received;
    points += stablefordPoints(Number(strokes) - received, par);
    thru += 1;
  }
  const net = gross - netStrokes;
  return {
    entryId:        entry.entryId,
    playerName:     entry.playerName,
    teamId:         entry.teamId || null,
    teamName:       entry.teamName || null,
    courseHandicap: entry.courseHandicap ?? null,
    thru,
    gross:      thru ? gross : null,
    net:        thru ? net : null,
    toParGross: thru ? gross - parPlayed : null,
    toParNet:   thru ? net - parPlayed : null,
    points:     thru ? points : null,
    parPlayed:  thru ? parPlayed : 0,
    // Per-hole strokes the public leaderboard renders inside its
    // click-to-expand drawer. Kept on the row so a single SSE payload
    // carries everything the live page needs.
    scores:     entry.scores || {},
    strokeMap:  strokeMap,
    strokeOverrides: entry.strokeOverrides || null,
  };
}

/** Assign golf-style positions (T1, T1, T3) over an already-sorted list. */
function assignPositions(rows, keyFn) {
  let lastKey = null, lastPos = 0;
  rows.forEach((row, i) => {
    const k = keyFn(row);
    if (k !== null && k === lastKey) { row.position = lastPos; }
    else { row.position = i + 1; lastPos = i + 1; lastKey = k; }
  });
  const counts = {};
  rows.forEach(r => { if (r.position) counts[r.position] = (counts[r.position] || 0) + 1; });
  rows.forEach(r => { if (counts[r.position] > 1) r.tied = true; });
  return rows;
}

/** Sort rows by ranking key, assign positions, attach headline total + score. */
function finishBoard(rows, { stableford, net, fmtId }) {
  const keyOf = stableford ? r => r.points : r => (net ? r.toParNet : r.toParGross);
  rows.sort((a, b) => {
    const ak = keyOf(a), bk = keyOf(b);
    if (ak == null && bk == null) return 0;
    if (ak == null) return 1;                       // not started → bottom
    if (bk == null) return -1;
    if (ak !== bk) return stableford ? bk - ak : ak - bk;
    return b.thru - a.thru;                          // tiebreak: further along
  });
  assignPositions(rows, keyOf);
  return {
    format:    fmtId,
    scoreType: stableford ? 'points' : 'topar',
    rows: rows.map(r => ({
      ...r,
      total: stableford ? r.points : (net ? r.toParNet : r.toParGross),
      score: stableford ? r.points : (net ? r.net : r.gross),
    })),
  };
}

/**
 * Aggregate one team's best-ball result. Each member plays their own ball;
 * the best score on each hole counts (lowest net for stroke, highest points
 * for Stableford). Members = entry objects (see file header).
 */
function scoreTeamBestball(members, stableford) {
  const M = (members || []).map(m => {
    const byNum = {};
    for (const h of m.holes || []) byNum[h.hole_number] = h;
    return { byNum, strokeMap: strokesPerHole(m.courseHandicap, m.holes || []), scores: m.scores || {} };
  });
  const holeNums = new Set();
  for (const m of M) for (const [h, s] of Object.entries(m.scores)) if (s != null) holeNums.add(+h);

  let net = 0, parPlayed = 0, points = 0, thru = 0;
  for (const hole of [...holeNums].sort((a, b) => a - b)) {
    const nets = [], pts = [];
    let par = 0;
    for (const m of M) {
      const s = m.scores[hole];
      if (s == null) continue;
      par = m.byNum[hole] ? Number(m.byNum[hole].par) || 0 : par;
      const memNet = Number(s) - (m.strokeMap[hole] || 0);
      nets.push(memNet);
      pts.push(stablefordPoints(memNet, par));
    }
    if (!nets.length) continue;
    thru += 1;
    parPlayed += par;
    net += Math.min(...nets);          // best ball = lowest net on the hole
    points += Math.max(...pts);        // ...or highest Stableford points
  }
  return {
    thru,
    gross: null, toParGross: null,
    net:      thru ? net : null,
    toParNet: thru ? net - parPlayed : null,
    points:   thru ? points : null,
  };
}

/** Rank pre-built rows by their `total` field and attach positions. */
function rankBoard(rows, { highWins, scoreType, fmtId }) {
  rows.sort((a, b) => {
    const ak = a.total, bk = b.total;
    if (ak == null && bk == null) return 0;
    if (ak == null) return 1;
    if (bk == null) return -1;
    if (ak !== bk) return highWins ? bk - ak : ak - bk;
    return b.thru - a.thru;
  });
  assignPositions(rows, r => r.total);
  return { format: fmtId, scoreType, rows };
}

/** Per-entry net score map + holes-by-number, used by the exotic engines. */
function entryNet(entry) {
  const byNum = {};
  for (const h of entry.holes || []) byNum[h.hole_number] = h;
  // Manual stroke allocation (v3.64) takes priority over the auto-WHS
  // allocation when an organizer has hand-picked specific holes. Map is
  // keyed by hole_number, value = strokes received that hole.
  const auto = strokesPerHole(entry.courseHandicap, entry.holes || []);
  const strokeMap = (entry.strokeOverrides && typeof entry.strokeOverrides === 'object')
    ? entry.strokeOverrides : auto;
  const net = {};
  for (const [h, s] of Object.entries(entry.scores || {})) {
    if (s != null) net[h] = { net: Number(s) - (strokeMap[h] || 0), par: byNum[h] ? Number(byNum[h].par) || 0 : 0 };
  }
  return net;
}

/**
 * Vegas: pairs of two combine their NET scores into a 2-digit number (lower
 * score first → 4 + 6 = 46). Lowest combined per hole wins by the difference
 * between the numbers. Optional "birdie flip": when the opposing pair makes a
 * net birdie or better on the hole, you must put your HIGHER score first
 * (a 4 + 6 becomes 64 instead of 46).
 *
 * Supports any even number of pairs (4 players, 8 players, 16 players, …).
 * With > 2 pairs the engine runs a round-robin: every pair plays every other
 * pair on every hole, and each pair's `total` is the sum of net margins across
 * all opponents.
 *
 * Settings (from format_settings):
 *   value_per_point  number   $ per Vegas point (display only — engine returns raw points)
 *   flip_birdie      boolean  whether the birdie-flip rule is on (default true)
 *
 * Returns one row per pair, with `total` = net point margin (positive when
 * the pair is ahead of the field) and `score` = gross points scored.
 */
function buildVegas(entries, fmt, settings) {
  const flipBirdie = !!(settings && settings.flip_birdie);

  // Group by team. Every team needs exactly 2 members for Vegas.
  const teams = {};
  for (const e of entries) {
    const key = e.teamName || e.teamId;
    if (!key) continue;
    (teams[key] = teams[key] || { name: key, members: [] }).members.push({ e, net: entryNet(e) });
  }
  const T = Object.values(teams).filter(t => t.members.length === 2);
  if (T.length < 2) {
    return { format: fmt.id, scoreType: 'vegas', rows: [],
      note: 'Vegas needs at least 2 pairs of 2 players (label each foursome\'s two pairs in the field — e.g. "Pair A1", "Pair A2", "Pair B1", "Pair B2", …).' };
  }

  // 2-digit combined number for one pair on one hole.
  const combine = (nets, forceHigh) => {
    const sorted = [...nets].sort((x, y) => x - y);
    const lo = sorted[0], hi = sorted[1];
    return (forceHigh ? hi : lo) * 10 + (forceHigh ? lo : hi);
  };

  // For each pair: own points (margin wins) + opp points (margin losses).
  const totals = T.map(() => ({ own: 0, opp: 0, thru: 0 }));

  // Union of holes anyone played; we only count holes where ALL pairs have
  // both members' nets (clean comparison).
  const allHoles = new Set();
  for (const t of T) for (const m of t.members) for (const h of Object.keys(m.net)) allHoles.add(+h);
  const sortedHoles = [...allHoles].sort((a, b) => a - b);

  for (const h of sortedHoles) {
    const nets = T.map(t => t.members.map(m => m.net[h]?.net));
    if (nets.some(p => p.some(s => s == null))) continue;
    const par = T[0].members[0].net[h]?.par || 0;
    const birdied = nets.map(ns => ns.some(n => n <= par - 1));
    // Pre-compute each pair's combined number against each opponent (the
    // flip rule depends on the opponent's birdie status, so it's per-pair-pair).
    for (let i = 0; i < T.length; i++) totals[i].thru += 1;
    for (let i = 0; i < T.length; i++) {
      for (let j = i + 1; j < T.length; j++) {
        const numA = combine(nets[i], flipBirdie && birdied[j]);
        const numB = combine(nets[j], flipBirdie && birdied[i]);
        const diff = Math.abs(numA - numB);
        if (numA < numB) { totals[i].own += diff; totals[j].opp += diff; }
        else if (numB < numA) { totals[j].own += diff; totals[i].opp += diff; }
      }
    }
  }

  const rows = T.map((t, i) => ({
    entryId: 'vegas:' + t.name,
    playerName: t.name,
    teamName: t.name,
    courseHandicap: null,
    thru: totals[i].thru,
    total: totals[i].thru ? totals[i].own - totals[i].opp : null,
    score: totals[i].thru ? totals[i].own : null,
  }));
  return rankBoard(rows, { highWins: true, scoreType: 'vegas', fmtId: fmt.id });
}

/**
 * Sixes (Round Robin): four players rotate partners every six holes so each
 * player partners with each of the others for exactly six holes. Best ball
 * within each segment determines the segment winner. Final standings count
 * segments won.
 *
 * Required input: exactly 4 entries (one per player). Rotation:
 *   Holes 1–6:   {A,B} vs {C,D}
 *   Holes 7–12:  {A,C} vs {B,D}
 *   Holes 13–18: {A,D} vs {B,C}
 *
 * Each segment ends in a result for each player ('W' / 'L' / 'T'). The
 * leaderboard ranks players by segments won, breaking ties on segments lost.
 */
function buildSixes(entries, fmt) {
  if (!entries || entries.length !== 4) {
    return { format: fmt.id, scoreType: 'sixes', rows: [],
      note: 'Sixes needs exactly 4 players (Round Robin pairings rotate every six holes).' };
  }
  // Sort entries by entryId for stable A/B/C/D assignment.
  const E = [...entries].sort((a, b) => String(a.entryId).localeCompare(String(b.entryId)));
  const nets = E.map(entryNet);
  const PAIRINGS = [
    { holes: [1,2,3,4,5,6],    teamA: [0,1], teamB: [2,3] },
    { holes: [7,8,9,10,11,12], teamA: [0,2], teamB: [1,3] },
    { holes: [13,14,15,16,17,18], teamA: [0,3], teamB: [1,2] },
  ];
  // results[i] = { won: n, lost: n, tied: n, segs: [{label, status, diff}] }
  const results = E.map(() => ({ won: 0, lost: 0, tied: 0, segs: [] }));
  for (const p of PAIRINGS) {
    // Best ball NET per hole for each team.
    let aSum = 0, bSum = 0, played = 0;
    for (const h of p.holes) {
      const a1 = nets[p.teamA[0]][h]?.net;
      const a2 = nets[p.teamA[1]][h]?.net;
      const b1 = nets[p.teamB[0]][h]?.net;
      const b2 = nets[p.teamB[1]][h]?.net;
      if ([a1,a2,b1,b2].some(v => v == null)) continue;
      aSum += Math.min(a1, a2);
      bSum += Math.min(b1, b2);
      played += 1;
    }
    if (!played) continue;
    const segLabel = `Holes ${p.holes[0]}–${p.holes[p.holes.length-1]}`;
    const margin = bSum - aSum; // positive = team A wins by that many net strokes
    const status = aSum < bSum ? 'A' : bSum < aSum ? 'B' : 'T';
    const apply = (idx, won, lost, tied) => {
      results[idx].won  += won;
      results[idx].lost += lost;
      results[idx].tied += tied;
      results[idx].segs.push({ label: segLabel, status: won ? 'W' : lost ? 'L' : 'T', margin: Math.abs(margin) });
    };
    p.teamA.forEach(i => apply(i, status === 'A' ? 1 : 0, status === 'B' ? 1 : 0, status === 'T' ? 1 : 0));
    p.teamB.forEach(i => apply(i, status === 'B' ? 1 : 0, status === 'A' ? 1 : 0, status === 'T' ? 1 : 0));
  }
  const rows = E.map((e, i) => ({
    entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
    courseHandicap: e.courseHandicap,
    thru: results[i].segs.length * 6,
    // total is integer segments won. Sort primary on won DESC, then lost ASC
    // (fewer losses wins the tiebreak). The display reads as a clean integer.
    total: results[i].segs.length ? results[i].won : null,
    score: results[i].segs.length ? results[i].won : null,
    won: results[i].won, lost: results[i].lost, tied: results[i].tied,
    segments: results[i].segs,
  }));
  // Custom sort + position assignment (won DESC, lost ASC tie-break) so the
  // tie-break logic doesn't bleed into the displayed `total` integer.
  rows.sort((a, b) => {
    if (a.total == null && b.total == null) return 0;
    if (a.total == null) return 1;
    if (b.total == null) return -1;
    if (a.total !== b.total) return b.total - a.total;
    return a.lost - b.lost;
  });
  assignPositions(rows, r => `${r.total}/${r.lost}`);
  return { format: fmt.id, scoreType: 'sixes', rows };
}

/**
 * Nassau: classic 3-way head-to-head bet — front 9 / back 9 / total 18.
 * Each slice is its own match-play sub-tournament. Players (or teams) tied
 * after a slice push that slice (no winner). The leaderboard reports the
 * player's total bet won, derived from the front_bet / back_bet / total_bet
 * settings.
 *
 * Supported configurations:
 *   - 2 entries → head-to-head individuals
 *   - 4 entries with matching team labels → 2v2 better-ball Nassau
 *   - any other count → returns an empty board with a hint
 */
function buildNassau(entries, fmt, settings) {
  const front = (settings && Number(settings.front_bet)) || 0;
  const back  = (settings && Number(settings.back_bet))  || 0;
  const total = (settings && Number(settings.total_bet)) || 0;

  // Group entries: 2 indivs OR 2 pair-teams.
  const teams = {};
  for (const e of entries) {
    const key = e.teamName || e.entryId;
    (teams[key] = teams[key] || { name: key, members: [] }).members.push({ e, net: entryNet(e) });
  }
  const T = Object.values(teams);
  // If a "team" only has one member and no real team label, show the player
  // name instead of the synthetic entryId key.
  for (const t of T) {
    if (t.members.length === 1 && !t.members[0].e.teamName) {
      t.name = t.members[0].e.playerName || t.name;
    }
  }
  if (T.length !== 2) {
    return { format: fmt.id, scoreType: 'nassau', rows: [],
      note: 'Nassau needs exactly 2 sides (either 2 players head-to-head, or two 2-player teams for a 2v2 better-ball Nassau).' };
  }

  // Per-team NET strokes per hole. For multi-member teams use best-ball.
  const teamNetByHole = (team) => {
    const out = {};
    for (const m of team.members) for (const [h, info] of Object.entries(m.net)) {
      const hN = +h;
      const v = info.net;
      out[hN] = out[hN] == null ? v : Math.min(out[hN], v);
    }
    return out;
  };
  const nets = T.map(teamNetByHole);

  // Match a slice of holes: returns 'A'|'B'|'T' if the slice is complete, else null.
  const playSlice = (holes) => {
    let a = 0, b = 0, n = 0;
    for (const h of holes) {
      if (nets[0][h] == null || nets[1][h] == null) return null;
      a += nets[0][h]; b += nets[1][h]; n += 1;
    }
    if (!n) return null;
    return a < b ? 'A' : b < a ? 'B' : 'T';
  };

  const frontHoles = Array.from({length: 9}, (_, i) => i + 1);
  const backHoles  = Array.from({length: 9}, (_, i) => i + 10);
  const allHoles   = frontHoles.concat(backHoles);

  const frontWin = playSlice(frontHoles);
  const backWin  = playSlice(backHoles);
  const totalWin = playSlice(allHoles);

  const teamTotal = (which) => {
    let amount = 0;
    if (frontWin === which) amount += front;
    else if (frontWin && frontWin !== which && frontWin !== 'T') amount -= front;
    if (backWin === which)  amount += back;
    else if (backWin && backWin !== which && backWin !== 'T')  amount -= back;
    if (totalWin === which) amount += total;
    else if (totalWin && totalWin !== which && totalWin !== 'T') amount -= total;
    return amount;
  };

  const rows = T.map((t, i) => {
    const which = i === 0 ? 'A' : 'B';
    const dollars = teamTotal(which);
    // Composite thru: holes both sides have scored
    const thruCount = allHoles.filter(h => nets[0][h] != null && nets[1][h] != null).length;
    return {
      entryId: 'nassau:' + t.name,
      playerName: t.name,
      teamName: t.name,
      courseHandicap: null,
      thru: thruCount,
      total: thruCount ? dollars : null,
      score: thruCount ? dollars : null,
      slices: {
        front: frontWin ? (frontWin === which ? 'W' : frontWin === 'T' ? 'T' : 'L') : null,
        back:  backWin  ? (backWin  === which ? 'W' : backWin  === 'T' ? 'T' : 'L') : null,
        total: totalWin ? (totalWin === which ? 'W' : totalWin === 'T' ? 'T' : 'L') : null,
      },
    };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'nassau', fmtId: fmt.id });
}

/**
 * Bingo Bango Bongo: count per-player events ('bingo' / 'bango' / 'bongo')
 * from the hole_events table and multiply by the configured point values.
 * Optional value_per_point converts points to dollars.
 */
function buildBBB(entries, fmt, settings, holeEvents) {
  const ptsBingo = Number(settings?.pts_bingo ?? 1);
  const ptsBango = Number(settings?.pts_bango ?? 1);
  const ptsBongo = Number(settings?.pts_bongo ?? 1);
  const counts = {}; // entryId → { bingo, bango, bongo }
  for (const e of entries) counts[e.entryId] = { bingo: 0, bango: 0, bongo: 0 };
  for (const ev of (holeEvents || [])) {
    if (!counts[ev.entry_id]) continue;
    if (ev.event_key === 'bingo' || ev.event_key === 'bango' || ev.event_key === 'bongo') {
      counts[ev.entry_id][ev.event_key] += 1;
    }
  }
  const rows = entries.map(e => {
    const c = counts[e.entryId];
    const points = c.bingo * ptsBingo + c.bango * ptsBango + c.bongo * ptsBongo;
    const totalEvents = c.bingo + c.bango + c.bongo;
    return {
      entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
      courseHandicap: e.courseHandicap,
      thru: totalEvents,
      total: totalEvents ? points : null,
      score: totalEvents ? points : null,
      bbb: c,
    };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'points', fmtId: fmt.id });
}

/**
 * Dots / Garbage: per-player point totals derived from hole_events. Each
 * event_key maps to a point value via the format's `events` setting (an
 * array of { key, points }). Unrecognized event keys score 0.
 */
function buildDots(entries, fmt, settings, holeEvents) {
  const pointsByKey = {};
  for (const ev of (settings?.events || [])) {
    pointsByKey[ev.key] = Number(ev.points) || 0;
  }
  const totals = {};
  for (const e of entries) totals[e.entryId] = { points: 0, events: 0 };
  for (const ev of (holeEvents || [])) {
    if (!totals[ev.entry_id]) continue;
    if (pointsByKey[ev.event_key] != null) {
      totals[ev.entry_id].points += pointsByKey[ev.event_key];
      totals[ev.entry_id].events += 1;
    }
  }
  const rows = entries.map(e => {
    const t = totals[e.entryId];
    return {
      entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
      courseHandicap: e.courseHandicap,
      thru: t.events,
      total: t.events ? t.points : null,
      score: t.events ? t.points : null,
    };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'points', fmtId: fmt.id });
}

/**
 * Snake: a single penalty travels from one three-putter to the next. Whoever
 * holds the snake at the end of the round pays the penalty (negative `total`
 * for them; everyone else is 0). Reads three-putt events keyed 'three_putt'.
 */
function buildSnake(entries, fmt, settings, holeEvents) {
  const penalty = Number(settings?.snake_penalty ?? 0);
  // Sort 3-putt events chronologically by hole; the snake passes hole-by-hole.
  const sorted = (holeEvents || [])
    .filter(ev => ev.event_key === 'three_putt')
    .sort((a, b) => (a.hole_number - b.hole_number) || ((a.created_at || '').localeCompare(b.created_at || '')));
  // The snake holder is the most recent three-putter.
  const snakeHolder = sorted.length ? sorted[sorted.length - 1].entry_id : null;
  const rows = entries.map(e => {
    const isHolder = e.entryId === snakeHolder;
    return {
      entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
      courseHandicap: e.courseHandicap,
      thru: sorted.length,
      total: isHolder ? -penalty : 0,
      score: isHolder ? -penalty : 0,
      holdsSnake: isHolder,
    };
  });
  // Snake leaderboard sorts so the holder is at the bottom (lowest total wins).
  return rankBoard(rows, { highWins: true, scoreType: 'snake', fmtId: fmt.id });
}

/** Skins: the outright-low net score wins the hole; ties carry the pot forward.
 *  If settings.allow_handicaps === false, low GROSS wins (handicaps ignored).
 *  If settings.allow_carryover === false, tied skins die instead of carrying. */
function buildSkins(entries, fmt, settings) {
  const useGross    = settings && settings.allow_handicaps === false;
  const noCarryover = settings && settings.allow_carryover === false;
  const E = entries.map(e => {
    if (!useGross) return { e, net: entryNet(e) };
    const byNum = {};
    for (const h of e.holes || []) byNum[h.hole_number] = h;
    const gross = {};
    for (const [h, s] of Object.entries(e.scores || {})) {
      if (s != null) gross[h] = { net: Number(s), par: byNum[h] ? Number(byNum[h].par) || 0 : 0 };
    }
    return { e, net: gross };
  });
  const holeNums = new Set();
  for (const x of E) for (const h of Object.keys(x.net)) holeNums.add(+h);
  const skins = {}; E.forEach(x => skins[x.e.entryId] = 0);
  // Per-entry list of holes this player won + the skin value on that hole
  // (1 normally, more if previous holes tied and carried). Powers the UI's
  // "💰 holes won" markers in the drawer + card.
  const wonBy = {}; E.forEach(x => wonBy[x.e.entryId] = []);
  // For all-tied holes, every player gets a placeholder so the UI can show
  // "tied — carried over" instead of "lost it".
  const tiedHoles = [];
  let carry = 0;
  for (const hole of [...holeNums].sort((a, b) => a - b)) {
    const scored = E.filter(x => x.net[hole]);
    if (scored.length !== E.length) continue;            // hole not yet complete
    const low = Math.min(...scored.map(x => x.net[hole].net));
    const winners = scored.filter(x => x.net[hole].net === low);
    if (winners.length === 1) {
      const winnerId = winners[0].e.entryId;
      const value = 1 + carry;
      skins[winnerId] += value;
      wonBy[winnerId].push({ hole, value, carry });
      carry = 0;
    } else {
      tiedHoles.push(hole);
      if (!noCarryover) carry += 1;
    }
  }
  // Note: holes that tied at the end of the round carry forever and stay
  // in `tiedHoles` so the UI can render them as "carry-over (unclaimed)".
  const rows = E.map(x => {
    const thru = Object.keys(x.net).length;
    return { entryId: x.e.entryId, playerName: x.e.playerName, teamName: x.e.teamName || null,
             courseHandicap: x.e.courseHandicap,
             thru, total: thru ? skins[x.e.entryId] : null, score: thru ? skins[x.e.entryId] : null,
             skinHoles: wonBy[x.e.entryId],   // [{hole, value, carry}]
             scores: x.e.scores || {},
             strokeMap: strokesPerHole(x.e.courseHandicap, x.e.holes || []),
             skinTiedHoles: tiedHoles.slice(),  // shared on every row; UI shows on the leader / first row
    };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'skins', fmtId: fmt.id });
}

/** Erado: stroke play with the worst N holes erased (4 of 18; the last can't go). */
function buildErado(entries, fmt, holeCount) {
  const dropN = holeCount <= 9 ? 2 : 4;
  const rows = entries.map(e => {
    const net = entryNet(e);
    const played = Object.entries(net).map(([h, v]) => ({ hole: +h, ...v }));
    if (!played.length) return { entryId: e.entryId, playerName: e.playerName,
      teamName: e.teamName || null, courseHandicap: e.courseHandicap, thru: 0, total: null, score: null };
    const lastHole = Math.max(...played.map(p => p.hole));
    const drop = new Set(played.filter(p => p.hole !== lastHole)
      .sort((a, b) => (b.net - b.par) - (a.net - a.par))
      .slice(0, Math.min(dropN, played.length - 1)).map(p => p.hole));
    let n = 0, par = 0;
    for (const p of played) if (!drop.has(p.hole)) { n += p.net; par += p.par; }
    return { entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
             courseHandicap: e.courseHandicap, thru: played.length, total: n - par, score: n };
  });
  return rankBoard(rows, { highWins: false, scoreType: 'topar', fmtId: fmt.id });
}

/** Duplicate: individual Stableford with a random 1×/2×/3× per-hole multiplier. */
function buildDuplicate(entries, fmt, multipliers) {
  const mult = h => (multipliers && multipliers[h - 1]) || 1;
  const rows = entries.map(e => {
    const net = entryNet(e);
    let pts = 0; const holes = Object.keys(net);
    for (const h of holes) pts += stablefordPoints(net[h].net, net[h].par) * mult(+h);
    return { entryId: e.entryId, playerName: e.playerName, teamName: e.teamName || null,
             courseHandicap: e.courseHandicap,
             thru: holes.length, total: holes.length ? pts : null, score: holes.length ? pts : null };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'points', fmtId: fmt.id });
}

/** Net strokes per hole for one entry. */
function netByHole(entry) {
  const n = entryNet(entry);
  const out = {};
  for (const h of Object.keys(n)) out[h] = n[h].net;
  return out;
}

/** Best (lowest) net per hole across a side's members — for better-ball match. */
function bestNetByHole(members) {
  const out = {};
  for (const m of members) {
    const n = netByHole(m);
    for (const h of Object.keys(n)) out[h] = out[h] == null ? n[h] : Math.min(out[h], n[h]);
  }
  return out;
}

/**
 * Score a match: hole by hole, the lower net wins the hole. The match standing
 * is holes-up for side A (negative = side B is up). A match closes out once a
 * side leads by more holes than remain ("3&2" = 3 up, 2 to play).
 */
function scoreMatch(aNet, bNet, totalHoles) {
  const holes = [...new Set([...Object.keys(aNet), ...Object.keys(bNet)])].map(Number).sort((x, y) => x - y);
  let standing = 0, played = 0;
  for (const h of holes) {
    if (aNet[h] == null || bNet[h] == null) continue;
    played += 1;
    if (aNet[h] < bNet[h]) standing += 1;
    else if (bNet[h] < aNet[h]) standing -= 1;
  }
  const holesLeft = Math.max(0, totalHoles - played);
  const lead = Math.abs(standing);
  let status = 'in_progress', result = null;
  if (lead > holesLeft) {
    status = 'closed';
    result = holesLeft > 0 ? `${lead}&${holesLeft}` : `${lead} up`;
  } else if (played >= totalHoles) {
    status = 'closed';
    result = lead === 0 ? 'AS' : `${lead} up`;
  } else if (lead === holesLeft && holesLeft > 0) {
    status = 'dormie';
  }
  return { standing, played, holesLeft,
    leader: standing > 0 ? 'A' : standing < 0 ? 'B' : null, status, result };
}

/** Build a match-play result: two sides, head to head. */
function buildMatchPlay(entries, fmt) {
  const aggregate = typeof fmt.allowance === 'number' && fmt.teamSize[1] > 1;
  let sides;
  if (aggregate) {
    const teams = {};
    for (const e of entries) {
      const k = e.teamId || e.entryId;
      (teams[k] = teams[k] || { name: e.teamName || e.playerName, members: [] }).members.push(e);
    }
    sides = Object.values(teams).map(t => ({ name: t.name, net: bestNetByHole(t.members) }));
  } else {
    sides = entries.map(e => ({ name: e.playerName, net: netByHole(e) }));
  }
  const totalHoles = entries[0]?.holes?.length || 18;
  if (sides.length < 2) {
    return { format: fmt.id, scoreType: 'match', match: null,
      rows: sides.map((s, i) => ({ entryId: 'S' + i, playerName: s.name, thru: 0, total: null, score: null })) };
  }
  const m = scoreMatch(sides[0].net, sides[1].net, totalHoles);
  const rows = [
    { entryId: 'A', playerName: sides[0].name, thru: m.played, total: m.standing,  score: m.standing },
    { entryId: 'B', playerName: sides[1].name, thru: m.played, total: -m.standing, score: -m.standing },
  ];
  rows.sort((x, y) => y.total - x.total);
  rows.forEach((r, i) => { r.position = i + 1; if (m.standing === 0) r.tied = true; });
  return { format: fmt.id, scoreType: 'match', match: m, rows };
}

/** Group member entries by team id. */
function groupTeams(entries) {
  const teams = {};
  for (const e of entries || []) {
    const k = e.teamId || e.entryId;
    (teams[k] = teams[k] || { teamId: k, teamName: e.teamName || e.playerName, members: [] }).members.push(e);
  }
  return Object.values(teams);
}

/** Low Scratch/Net: each hole's team score = best gross + best net of the team. */
function buildLowNet(entries, fmt) {
  const rows = groupTeams(entries).map(t => {
    const M = t.members.map(m => ({ scores: m.scores || {}, net: entryNet(m) }));
    const holeNums = new Set();
    for (const m of M) for (const h of Object.keys(m.net)) holeNums.add(+h);
    let total = 0, parRef = 0, thru = 0;
    for (const hole of [...holeNums].sort((a, b) => a - b)) {
      const grosses = [], nets = []; let par = 0;
      for (const m of M) {
        if (!m.net[hole]) continue;
        grosses.push(Number(m.scores[hole]));
        nets.push(m.net[hole].net);
        par = m.net[hole].par;
      }
      if (!grosses.length) continue;
      thru += 1;
      total += Math.min(...grosses) + Math.min(...nets);
      parRef += par * 2;                       // a gross + a net score per hole
    }
    return { entryId: t.teamId, playerName: t.teamName, teamName: t.teamName, courseHandicap: null,
             thru, total: thru ? total - parRef : null, score: thru ? total : null };
  });
  return rankBoard(rows, { highWins: false, scoreType: 'topar', fmtId: fmt.id });
}

/** Irish Rumble: best-ball Stableford with an escalating count of scores. */
function buildRumble(entries, fmt) {
  const bestN = h => (h <= 6 ? 1 : h <= 12 ? 2 : h <= 17 ? 3 : 99);   // hole 18 = all
  const rows = groupTeams(entries).map(t => {
    const M = t.members.map(entryNet);
    const holeNums = new Set();
    for (const m of M) for (const h of Object.keys(m)) holeNums.add(+h);
    let points = 0, thru = 0;
    for (const hole of [...holeNums].sort((a, b) => a - b)) {
      const pts = [];
      for (const m of M) if (m[hole]) pts.push(stablefordPoints(m[hole].net, m[hole].par));
      if (!pts.length) continue;
      thru += 1;
      pts.sort((a, b) => b - a);
      for (let i = 0; i < Math.min(bestN(hole), pts.length); i++) points += pts[i];
    }
    return { entryId: t.teamId, playerName: t.teamName, teamName: t.teamName, courseHandicap: null,
             thru, total: thru ? points : null, score: thru ? points : null };
  });
  return rankBoard(rows, { highWins: true, scoreType: 'points', fmtId: fmt.id });
}

/**
 * Build a ranked leaderboard for one round.
 * @param {Array} entries  entry objects (see file header). For team formats an
 *                         entry also carries `teamId` and `teamName`.
 * @param {Object} opts    { format: <format id>, multipliers?: number[] }
 */
function buildLeaderboard(entries, opts = {}) {
  const fmt = getFormat(opts.format) || getFormat('stroke_gross');
  const E = entries || [];

  // Best-ball / better-ball: group member entries by team and aggregate.
  if (fmt.engine === 'bestball') {
    const stableford = /stableford/i.test(fmt.sub || '');
    const teams = {};
    for (const e of E) {
      const tid = e.teamId || e.entryId;
      (teams[tid] = teams[tid] || { teamId: tid, teamName: e.teamName || e.playerName, members: [] })
        .members.push(e);
    }
    const rows = Object.values(teams).map(t => {
      // Per-hole "winner" — whose net score is the team's best on that hole.
      // The live drawer uses this to outline the cell that's actually scoring.
      const winnerByHole = {};
      const holeNumbers = new Set();
      const memberAux = t.members.map(m => {
        const auto = strokesPerHole(m.courseHandicap, m.holes || []);
        const strokeMap = (m.strokeOverrides && typeof m.strokeOverrides === 'object') ? m.strokeOverrides : auto;
        for (const h of Object.keys(m.scores || {})) holeNumbers.add(+h);
        return { entry: m, strokeMap };
      });
      for (const h of holeNumbers) {
        let bestNet = Infinity, bestId = null;
        for (const { entry, strokeMap } of memberAux) {
          const s = entry.scores?.[h] ?? entry.scores?.[String(h)];
          if (s == null) continue;
          const net = Number(s) - (strokeMap[h] || 0);
          if (net < bestNet) { bestNet = net; bestId = entry.entryId; }
        }
        if (bestId != null) winnerByHole[h] = bestId;
      }
      const members = memberAux.map(({ entry, strokeMap }) => ({
        entryId:        entry.entryId,
        playerName:     entry.playerName,
        courseHandicap: entry.courseHandicap,
        scores:         entry.scores || {},
        strokeMap,
        strokeOverrides: entry.strokeOverrides || null,
      }));
      // Per-hole "the team's score" — the gross strokes of the member whose
      // net was lowest on that hole + that same member's strokes received,
      // so the live drawer's team grid renders the ball that actually counted.
      const teamScores = {};
      const teamStrokeOverrides = {};
      for (const [h, winnerId] of Object.entries(winnerByHole)) {
        const w = memberAux.find(x => x.entry.entryId === winnerId);
        if (!w) continue;
        const s = w.entry.scores?.[h] ?? w.entry.scores?.[String(h)];
        if (s != null) teamScores[h] = Number(s);
        teamStrokeOverrides[h] = w.strokeMap[+h] || 0;
      }
      return {
        entryId: t.teamId, playerName: t.teamName, teamName: t.teamName,
        courseHandicap: null, ...scoreTeamBestball(t.members, stableford),
        scores: teamScores,
        strokeOverrides: teamStrokeOverrides,
        members,
        winnerByHole,
      };
    });
    return finishBoard(rows, { stableford, net: true, fmtId: fmt.id });
  }

  if (fmt.engine === 'skins')     return buildSkins(E, fmt, opts.format_settings);
  if (fmt.engine === 'erado')     return buildErado(E, fmt, E[0]?.holes?.length || 18);
  if (fmt.engine === 'duplicate') return buildDuplicate(E, fmt, opts.multipliers);
  if (fmt.engine === 'matchplay') return buildMatchPlay(E, fmt);
  if (fmt.engine === 'lownet')    return buildLowNet(E, fmt);
  if (fmt.engine === 'rumble')    return buildRumble(E, fmt);
  if (fmt.engine === 'vegas')     return buildVegas(E, fmt, opts.format_settings);
  if (fmt.engine === 'sixes')     return buildSixes(E, fmt);
  if (fmt.engine === 'nassau')    return buildNassau(E, fmt, opts.format_settings);
  if (fmt.engine === 'bbb')       return buildBBB(E,   fmt, opts.format_settings, opts.holeEvents);
  if (fmt.engine === 'dots')      return buildDots(E,  fmt, opts.format_settings, opts.holeEvents);
  if (fmt.engine === 'snake')     return buildSnake(E, fmt, opts.format_settings, opts.holeEvents);

  // Stroke / Stableford / scramble — one row per entry. A scramble entry is a
  // team card: the team plays one ball, so it scores like a single player.
  const stableford = fmt.engine === 'stableford';
  const rows = E.map(scoreEntry);
  return finishBoard(rows, { stableford, net: fmt.net, fmtId: fmt.id });
}

// Format ids the scoring engine fully supports today (auto-leaderboard).
const SUPPORTED_FORMATS = require('./formats').FORMATS
  .filter(f => f.scored).map(f => f.id);
// All format ids the user can pick at game-creation time — includes
// manual-scoring formats (Snake / Dots / BBB / Chapman / Sixes / Foursomes).
// Those won't auto-leaderboard but the round still saves and runs.
const PICKABLE_FORMATS = require('./formats').FORMATS
  .filter(f => f.scored || f.manualScoring).map(f => f.id);

/**
 * Split a leaderboard into 1–5 handicap flights. Flight 1 gets the lowest
 * course handicaps. Rows keep their score order; positions renumber per flight.
 * Mutates and returns the leaderboard (adds `flight` + `flightPosition` to rows).
 */
function applyFlights(lb, numFlights) {
  const n = Math.max(1, Math.min(5, Number(numFlights) | 0));
  const rows = lb.rows || [];
  const withHcp = rows.filter(r => r.courseHandicap != null)
    .sort((a, b) => a.courseHandicap - b.courseHandicap);
  const perFlight = Math.ceil(withHcp.length / n) || 1;
  withHcp.forEach((r, i) => { r.flight = Math.min(n, Math.floor(i / perFlight) + 1); });
  for (const r of rows) if (r.flight == null) r.flight = n;     // no handicap → last flight
  const count = {};
  for (const r of rows) {                                       // rows already in score order
    count[r.flight] = (count[r.flight] || 0) + 1;
    r.flightPosition = count[r.flight];
  }
  lb.flighted = n;
  return lb;
}

/**
 * Multi-format leaderboard runner (v3.60). Computes the primary leaderboard
 * via buildLeaderboard, then runs each configured side-bet through its own
 * engine on the same entries. Returns:
 *   {
 *     primary:  <the same shape buildLeaderboard returns>,
 *     sideBets: [ { formatId, leaderboard, settings } ]
 *   }
 * If no side-bets are configured, sideBets is an empty array. Callers that
 * only need the primary can read result.primary.
 *
 * Side-bet entries are passed through with the player handicap allowance that
 * matched the SIDE-BET format — so a Skins side-bet on top of Stroke Net Gross
 * applies the Skins (0.95) allowance rather than the primary's (1.0). The
 * mapper rebuilds each entry's courseHandicap from the original raw index.
 */
function buildAllLeaderboards(entries, opts = {}) {
  const primary = buildLeaderboard(entries, opts);
  const sideBetConfigs = Array.isArray(opts.side_bets) ? opts.side_bets : [];
  const sideBets = [];
  for (const sb of sideBetConfigs) {
    const fmt = getFormat(sb.format_id);
    if (!fmt) continue;
    // Side-bet entries reuse the same per-hole gross scores. We re-derive
    // each player's playing handicap under the side-bet's allowance so net
    // math (Skins low-net per hole, etc.) matches a standalone side-bet
    // game. If we don't know the raw index we fall back to the primary's
    // courseHandicap which is "close enough" for the simulator path.
    const sbEntries = entries.map(e => {
      const raw = e.rawHandicapIndex != null ? e.rawHandicapIndex : null;
      let cHcp = e.courseHandicap;
      if (raw != null && typeof fmt.allowance === 'number') {
        cHcp = Math.round(raw * fmt.allowance);
      }
      return { ...e, courseHandicap: cHcp };
    });
    const lb = buildLeaderboard(sbEntries, {
      format: fmt.id,
      format_settings: sb.settings || {},
      multipliers: null,
      // Side-bets can be event-based games too (Dots / Snake / BBB layered on
      // top of a primary stroke-play format). Pass the same hole_events through.
      holeEvents: opts.holeEvents || [],
    });
    sideBets.push({ formatId: fmt.id, formatName: fmt.name + ' · ' + fmt.sub,
                     emoji: fmt.emoji, leaderboard: lb, settings: sb.settings || {} });
  }
  return { primary, sideBets };
}

module.exports = { SUPPORTED_FORMATS, PICKABLE_FORMATS, stablefordPoints, scoreEntry, scoreTeamBestball,
  scoreMatch, applyFlights, buildLeaderboard, buildAllLeaderboards };
