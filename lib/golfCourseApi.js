/**
 * golfCourseApi.js — golfcourseapi.com client
 *
 * Fetches course / scorecard data (par, stroke index, yardage, slope, rating).
 * HTTP-only and provider-specific: `normalizeCourse` converts the provider's
 * JSON into JORD's own shape, so swapping to iGolf later only touches this file.
 *
 * Auth: header `Authorization: Key <GOLF_COURSE_API_KEY>`.
 */

const BASE = 'https://api.golfcourseapi.com/v1';

function authHeaders(apiKey) {
  if (!apiKey) throw new Error('GOLF_COURSE_API_KEY is not set');
  return { Authorization: `Key ${apiKey}`, Accept: 'application/json' };
}

/** Search courses by name. Returns the provider's raw course objects. */
async function searchCourses(query, apiKey) {
  const url = `${BASE}/search?search_query=${encodeURIComponent(query || '')}`;
  const r = await fetch(url, { headers: authHeaders(apiKey) });
  if (!r.ok) throw new Error(`golfcourseapi search failed: HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data?.courses) ? data.courses : [];
}

/** Fetch a single course by the provider's numeric id. */
async function getCourse(id, apiKey) {
  const r = await fetch(`${BASE}/courses/${encodeURIComponent(id)}`, { headers: authHeaders(apiKey) });
  if (!r.ok) throw new Error(`golfcourseapi course fetch failed: HTTP ${r.status}`);
  const data = await r.json();
  return data?.course || data || null;
}

/**
 * Convert a provider course object into JORD's normalized shape.
 * The provider nests holes (par / yardage / handicap) under each tee, so
 * par + stroke index are stored per tee — that's what scoring reads.
 */
function normalizeCourse(apiCourse) {
  if (!apiCourse) return null;
  const loc = apiCourse.location || {};
  const tees = [];

  for (const gender of ['male', 'female']) {
    const list = apiCourse.tees?.[gender] || [];
    for (const t of list) {
      const holes = (t.holes || []).map((h, i) => ({
        hole_number:  i + 1,
        par:          Number(h.par) || 0,
        stroke_index: h.handicap != null ? Number(h.handicap) : null, // provider's "handicap" = stroke index
        yardage:      h.yardage != null ? Number(h.yardage) : null,
      }));
      tees.push({
        name:          t.tee_name || 'Tee',
        gender,
        par_total:     t.par_total != null ? Number(t.par_total) : null,
        yardage_total: t.total_yards != null ? Number(t.total_yards) : null,
        course_rating: t.course_rating != null ? Number(t.course_rating) : null,
        slope_rating:  t.slope_rating != null ? Number(t.slope_rating) : null,
        holes,
      });
    }
  }

  return {
    source:      'golfcourseapi',
    external_id: String(apiCourse.id ?? ''),
    name:        apiCourse.course_name || apiCourse.club_name || 'Unnamed course',
    club_name:   apiCourse.club_name || null,
    city:        loc.city || null,
    state:       loc.state || null,
    country:     loc.country || null,
    lat:         loc.latitude  != null ? Number(loc.latitude)  : null,
    lon:         loc.longitude != null ? Number(loc.longitude) : null,
    num_holes:   tees[0]?.holes.length || 18,
    tees,
  };
}

module.exports = { searchCourses, getCourse, normalizeCourse };
