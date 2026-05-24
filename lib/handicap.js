/**
 * handicap.js — World Handicap System (WHS) calculations
 *
 * Pure functions, no I/O — unit-testable. All inputs are plain numbers/arrays.
 *
 * Course Handicap  = Index × (Slope / 113) + (Course Rating − Par)
 * Playing Handicap = Course Handicap × format allowance
 * Stroke allocation follows hole stroke index (1 = hardest).
 */

/**
 * Course handicap: how many strokes the player gets on this tee.
 * Falls back to rounding the index when slope/rating are unavailable.
 * @returns integer (may be negative for plus handicaps)
 */
function courseHandicap(index, slope, rating, par) {
  const idx = Number(index);
  if (!Number.isFinite(idx)) return null;
  if (slope == null || rating == null || par == null) return Math.round(idx);
  return Math.round(idx * (Number(slope) / 113) + (Number(rating) - Number(par)));
}

/**
 * Playing handicap = course handicap × allowance (e.g. 0.95 stroke play,
 * 1.0 default). Rounded to the nearest integer.
 */
function playingHandicap(courseHcp, allowance = 1) {
  if (courseHcp == null) return null;
  return Math.round(Number(courseHcp) * Number(allowance));
}

/**
 * Allocate handicap strokes across holes by stroke index.
 * A course handicap of 20 over 18 holes = 1 stroke everywhere + a 2nd stroke
 * on the 2 hardest holes. Plus handicaps remove strokes from the easiest holes.
 *
 * @param {number} courseHcp  course (or playing) handicap, may be negative
 * @param {Array<{hole_number:number, stroke_index:number}>} holes
 * @returns {Object} map hole_number -> strokes received (negative for plus hcp)
 */
function strokesPerHole(courseHcp, holes) {
  const out = {};
  if (courseHcp == null || !holes?.length) {
    for (const h of holes || []) out[h.hole_number] = 0;
    return out;
  }
  const n = holes.length;
  const sign = courseHcp >= 0 ? 1 : -1;
  const abs = Math.abs(courseHcp);
  const base = Math.floor(abs / n);
  const remainder = abs % n;

  for (const h of holes) {
    const si = Number(h.stroke_index) || n;
    let extra = 0;
    if (sign >= 0) {
      // strokes given on the hardest holes first (SI 1..remainder)
      if (si <= remainder) extra = 1;
    } else {
      // plus handicap: strokes removed from the easiest holes (highest SI)
      if (si > n - remainder) extra = 1;
    }
    out[h.hole_number] = sign * (base + extra);
  }
  return out;
}

/**
 * Net score for a round.
 * @param {Object} grossByHole    map hole_number -> gross strokes
 * @param {Object} strokesByHole  map hole_number -> handicap strokes received
 * @returns {number} total net strokes over holes that have a gross score
 */
function netTotal(grossByHole, strokesByHole) {
  let net = 0;
  for (const [hole, gross] of Object.entries(grossByHole)) {
    if (gross == null) continue;
    net += Number(gross) - (strokesByHole[hole] || 0);
  }
  return net;
}

/**
 * Team handicap for pair/team formats whose WHS allowance depends on the
 * whole team's course handicaps rather than a flat percentage.
 *
 * @param {number[]} courseHandicaps  each member's course handicap
 * @param {string} allowanceKey  'scramble2' | 'scramble4' | 'foursomes' | 'greensome'
 * @returns integer team handicap
 */
function teamHandicap(courseHandicaps, allowanceKey) {
  const hcps = (courseHandicaps || []).filter(h => h != null).map(Number).sort((a, b) => a - b);
  if (!hcps.length) return null;

  if (allowanceKey === 'foursomes') {
    return Math.round(hcps.reduce((a, b) => a + b, 0) * 0.5);
  }
  if (allowanceKey === 'greensome') {
    if (hcps.length === 1) return Math.round(hcps[0]);
    return Math.round(0.6 * hcps[0] + 0.4 * hcps[hcps.length - 1]);
  }
  // scramble: a descending percentage applied per player by handicap rank.
  // 2-person 35/15; 3–5 person 25/20/15/10/5.
  const pct = allowanceKey === 'scramble2'
    ? [0.35, 0.15]
    : [0.25, 0.20, 0.15, 0.10, 0.05];
  let total = 0;
  hcps.forEach((h, i) => { total += h * (pct[i] ?? 0); });
  return Math.round(total);
}

/**
 * Resolve a format's playing handicap. `allowance` is either a number
 * (× course handicap) or a team-allowance key handled by `teamHandicap`.
 */
function applyAllowance(courseHandicaps, allowance) {
  if (typeof allowance === 'string') return teamHandicap(courseHandicaps, allowance);
  const list = Array.isArray(courseHandicaps) ? courseHandicaps : [courseHandicaps];
  if (list[0] == null) return null;
  return playingHandicap(list[0], allowance);
}

module.exports = {
  courseHandicap, playingHandicap, strokesPerHole, netTotal,
  teamHandicap, applyAllowance,
};
