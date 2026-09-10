'use strict';
/**
 * The shared query engine. This is the single definition of "what matches" —
 * the CLI calls it directly, and the web app's filter code mirrors it field
 * for field. test/equivalence.test.js runs both over the same inputs and
 * diffs the resulting id lists, so a change to one that isn't mirrored in the
 * other fails the build rather than shipping a quiet divergence.
 */

const ERA_ALIASES = {
  pioneer: 'pioneer (pre-1970)',
  boom: 'boom (1970s–early 80s)',
  'late-century': 'late century (1985–1999)',
  revival: 'revival (2000s–2014)',
  modern: 'modern (2015+)',
  unknown: 'unknown',
};

const CATEGORY_LABELS = {
  'fruit-and-veg': 'Fruit & veg',
  fauna: 'Fauna',
  seafood: 'Seafood',
  'food-and-drink': 'Food & drink',
  'machinery-and-transport': 'Machines',
  'tools-and-industry': 'Tools & industry',
  'sport-and-leisure': 'Sport & leisure',
  'people-and-culture': 'People & culture',
  oddity: 'Pure oddity',
  sculpture: 'Sculpture',
};

const isGone = (t) => t.status === 'demolished' || t.status === 'removed';
const isFuzzy = (t) => t.precision === 'town';

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The exact haystack the web app searches, so free-text results agree. */
function haystack(t) {
  return [t.name, t.location, t.town, t.stateName, t.state, t.notes, t.blurb, CATEGORY_LABELS[t.category] || 'Pure oddity']
    .filter(Boolean).join(' ').toLowerCase();
}

/** Does one record satisfy the filter set? Mirrored by `matches()` in the app. */
function matches(t, f = {}) {
  const states = new Set(f.states || []);
  const cats = new Set(f.cats || []);
  const eras = new Set((f.eras || []).map((e) => ERA_ALIASES[e] || e));
  const statuses = new Set(f.statuses || []);
  if (states.size && !states.has(t.state)) return false;
  if (cats.size && !cats.has(t.category)) return false;
  if (eras.size && !eras.has(t.era)) return false;
  if (statuses.size && !statuses.has(t.status)) return false;
  if (f.goneOnly && !isGone(t)) return false;
  if (f.hideGone && isGone(t)) return false;
  if (f.exactOnly && isFuzzy(t)) return false;
  if (f.q) {
    const q = String(f.q).trim().toLowerCase();
    if (q && !haystack(t).includes(q)) return false;
  }
  return true;
}

function query(things, f = {}) {
  let rows = things.filter((t) => matches(t, f));

  if (f.near) {
    rows = rows.map((t) => (t.lat == null ? { ...t, _km: undefined } : { ...t, _km: haversineKm(f.near, { lat: t.lat, lng: t.lng }) }));
    if (Number.isFinite(f.within)) rows = rows.filter((t) => t._km !== undefined && t._km <= f.within);
  }

  const sort = f.sort || (f.near ? 'distance' : 'name');
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    state: (a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name),
    year: (a, b) => (a.builtYear || 9999) - (b.builtYear || 9999) || a.name.localeCompare(b.name),
    size: (a, b) => (b.sizeMaxM || 0) - (a.sizeMaxM || 0) || a.name.localeCompare(b.name),
    distance: (a, b) => (a._km === undefined ? Infinity : a._km) - (b._km === undefined ? Infinity : b._km),
  }[sort];
  rows.sort(cmp);

  const limit = f.limit === 0 || f.limit === undefined ? rows.length : f.limit;
  return rows.slice(0, limit);
}

module.exports = { query, matches, haystack, haversineKm, isGone, isFuzzy, ERA_ALIASES, CATEGORY_LABELS };
