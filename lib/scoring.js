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
  const strokeMap = strokesPerHole(entry.courseHandicap, entry.holes || []);

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
    teamName:       entry.teamName || null,
    courseHandicap: entry.courseHandicap ?? null,
    thru,
    gross:      thru ? gross : null,
    net:        thru ? net : null,
    toParGross: thru ? gross - parPlayed : null,
    toParNet:   thru ? net - parPlayed : null,
    points:     thru ? points : null,
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
  const strokeMap = strokesPerHole(entry.courseHandicap, entry.holes || []);
  const net = {};
  for (const [h, s] of Object.entries(entry.scores || {})) {
    if (s != null) net[h] = { net: Number(s) - (strokeMap[h] || 0), par: byNum[h] ? Number(byNum[h].par) || 0 : 0 };
  }
  return net;
}

/** Skins: the outright-low net score wins the hole; ties carry the pot forward. */
function buildSkins(entries, fmt) {
  const E = entries.map(e => ({ e, net: entryNet(e) }));
  const holeNums = new Set();
  for (const x of E) for (const h of Object.keys(x.net)) holeNums.add(+h);
  const skins = {}; E.forEach(x => skins[x.e.entryId] = 0);
  let carry = 0;
  for (const hole of [...holeNums].sort((a, b) => a - b)) {
    const scored = E.filter(x => x.net[hole]);
    if (scored.length !== E.length) continue;            // hole not yet complete
    const low = Math.min(...scored.map(x => x.net[hole].net));
    const winners = scored.filter(x => x.net[hole].net === low);
    if (winners.length === 1) { skins[winners[0].e.entryId] += 1 + carry; carry = 0; }
    else carry += 1;
  }
  const rows = E.map(x => {
    const thru = Object.keys(x.net).length;
    return { entryId: x.e.entryId, playerName: x.e.playerName, teamName: x.e.teamName || null,
             courseHandicap: x.e.courseHandicap,
             thru, total: thru ? skins[x.e.entryId] : null, score: thru ? skins[x.e.entryId] : null };
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
    const rows = Object.values(teams).map(t => ({
      entryId: t.teamId, playerName: t.teamName, teamName: t.teamName,
      courseHandicap: null, ...scoreTeamBestball(t.members, stableford),
    }));
    return finishBoard(rows, { stableford, net: true, fmtId: fmt.id });
  }

  if (fmt.engine === 'skins')     return buildSkins(E, fmt);
  if (fmt.engine === 'erado')     return buildErado(E, fmt, E[0]?.holes?.length || 18);
  if (fmt.engine === 'duplicate') return buildDuplicate(E, fmt, opts.multipliers);
  if (fmt.engine === 'matchplay') return buildMatchPlay(E, fmt);
  if (fmt.engine === 'lownet')    return buildLowNet(E, fmt);
  if (fmt.engine === 'rumble')    return buildRumble(E, fmt);

  // Stroke / Stableford / scramble — one row per entry. A scramble entry is a
  // team card: the team plays one ball, so it scores like a single player.
  const stableford = fmt.engine === 'stableford';
  const rows = E.map(scoreEntry);
  return finishBoard(rows, { stableford, net: fmt.net, fmtId: fmt.id });
}

// Format ids the scoring engine fully supports today.
const SUPPORTED_FORMATS = require('./formats').FORMATS
  .filter(f => f.scored).map(f => f.id);

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

module.exports = { SUPPORTED_FORMATS, stablefordPoints, scoreEntry, scoreTeamBestball,
  scoreMatch, applyFlights, buildLeaderboard };
