'use strict';
/**
 * Upgrade town-level pins by matching them against the broad OSM attraction
 * harvest, gated on BOTH name similarity and distance from the town we already
 * know the big thing is in.
 *
 * Proximity is what makes fuzzy name matching safe here. "Big Apple" is
 * ambiguous nationally — there are nine of them — but "an OSM artwork called
 * Big Apple within 5 km of Thulimbah, Queensland" is not ambiguous at all.
 *
 * The rules are deliberately conservative. A wrong pin is worse than a town
 * pin: a town pin is honestly labelled, a wrong pin is a lie with a badge
 * saying it is trustworthy. Everything this module accepts is written to
 * cache/osm-matches.json for audit before it reaches the dataset.
 */

const N = require('./normalise');

/** Words that carry no identifying information for a big thing. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'at', 'in', 'on', 'and',
  'big', 'giant', 'large', 'largest', 'biggest', 'tallest', 'world', 'worlds',
  'australias', 'australian', 'mr', 'mrs', 'sir',
]);

/**
 * Tokens that mean the candidate is the *venue around* a big thing rather than
 * the big thing itself. A venue match is usually still within metres of the
 * sculpture, so we allow it — but only as a weaker `venue` match kind.
 */
const VENUE_WORDS = new Set([
  'cafe', 'restaurant', 'hotel', 'motel', 'pub', 'tavern', 'bar', 'kiosk',
  'shop', 'store', 'centre', 'center', 'gallery', 'museum', 'park', 'gardens',
  'garden', 'farm', 'winery', 'brewery', 'distillery', 'zoo', 'sanctuary',
  'hospital', 'school', 'church', 'station', 'depot', 'complex', 'resort',
  'caravan', 'campground', 'playground', 'reserve', 'oval', 'showground',
  'lookout', 'roadhouse', 'servo', 'markets', 'market', 'mall', 'plaza',
]);

/** Reduce a name to its identifying tokens. */
function coreTokens(name) {
  return new Set(
    N.slugPlace(name)
      .split(' ')
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .map((w) => singular(w))
  );
}

/**
 * Crude singulariser: "bananas" → "banana", "bales" → "bale".
 * The -is/-us/-ss guards matter: without them "tennis" becomes "tenni" and
 * the Barellan tennis racquet stops matching itself.
 */
// Only genuinely non-plural endings. An earlier version also listed -as,
// which wrongly protected "bananas", "koalas" and every other plural of an
// -a noun.
const NOT_PLURAL = /(is|us|ss)$/;
function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !NOT_PLURAL.test(w)) return w.slice(0, -1);
  return w;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const isSuperset = (big, small) => [...small].every((x) => big.has(x));

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Is this candidate tagged as an artwork/sculpture rather than a generic POI? */
const isArtwork = (c) => !!(c.artwork || c.tourism === 'artwork' || c.manMade === 'sculpture');

/**
 * Decide whether an OSM candidate is the same object as our record.
 * Returns { kind, confidence, why } or null.
 *
 * Distance bands, from the town point we already trust:
 *   ≤ 12 km  exact core-token equality (the town point can sit a few km off
 *            for rural entries, but the name must be unambiguous)
 *   ≤ 8 km   superset / high Jaccard also allowed
 *   ≤ 2 km   venue-style matches allowed (the shop the big thing advertises)
 */
function scoreMatch(record, cand, km) {
  const ours = coreTokens(record.name);
  const theirs = coreTokens(cand.name);
  if (!ours.size || !theirs.size) return null;

  const equal = ours.size === theirs.size && isSuperset(theirs, ours);
  const j = jaccard(ours, theirs);
  const extra = [...theirs].filter((x) => !ours.has(x));
  const venueOnlyExtra = extra.length > 0 && extra.every((x) => VENUE_WORDS.has(x));

  // 12 km, not 30: a sculpture is essentially never that far from the centre
  // of the town it is credited to. An audit run at 30 km paired Latrobe's Big
  // Platypus with a different Giant Platypus 29 km away.
  if (equal && km <= 12) {
    return { kind: 'name-exact', confidence: km <= 8 ? 'high' : 'medium', why: `core name "${[...ours].join(' ')}" matches exactly, ${km.toFixed(1)} km from the town point` };
  }
  // Candidate adds detail we lack: "Big Boxing Crocodile" for our "Big Crocodile".
  if (km <= 8 && isSuperset(theirs, ours) && ours.size >= 2) {
    return { kind: 'name-superset', confidence: 'high', why: `OSM name adds detail (${extra.join(', ')}), ${km.toFixed(1)} km away` };
  }
  // We add detail OSM lacks: our "The Big Wine Bottle" vs OSM "Wine Bottle".
  if (km <= 8 && isSuperset(ours, theirs) && theirs.size >= 2) {
    return { kind: 'name-subset', confidence: 'high', why: `OSM name is a shorter form, ${km.toFixed(1)} km away` };
  }
  // A single distinctive noun, very close, and tagged as an artwork.
  if (km <= 3 && isSuperset(theirs, ours) && ours.size === 1 && isArtwork(cand)) {
    return { kind: 'name-artwork', confidence: 'medium', why: `single-token name matched on an OSM artwork ${km.toFixed(1)} km away` };
  }
  // The venue the big thing stands at, when only venue words differ.
  if (km <= 2 && venueOnlyExtra && isSuperset(theirs, ours)) {
    return { kind: 'venue', confidence: 'medium', why: `matched the venue "${cand.name}" ${km.toFixed(1)} km away; only venue words differ` };
  }
  if (km <= 8 && j >= 0.7 && ours.size >= 2) {
    return { kind: 'name-fuzzy', confidence: 'medium', why: `name similarity ${j.toFixed(2)}, ${km.toFixed(1)} km away` };
  }
  return null;
}

const KIND_RANK = { 'name-exact': 0, 'name-superset': 1, 'name-subset': 2, 'name-fuzzy': 3, 'name-artwork': 4, venue: 5 };

/**
 * Find the best OSM candidate for one town-level record.
 * `record` needs { name, state, lat, lng } where lat/lng are the town point.
 */
function bestMatch(record, candidates) {
  if (record.lat == null) return null;
  const hits = [];
  for (const cand of candidates) {
    const km = haversineKm(record.lat, record.lng, cand.lat, cand.lng);
    if (km > 12) continue;
    const m = scoreMatch(record, cand, km);
    if (m) hits.push({ ...m, km, cand });
  }
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (KIND_RANK[a.kind] - KIND_RANK[b.kind])
    || (isArtwork(b.cand) - isArtwork(a.cand))
    || (a.km - b.km));
  const best = hits[0];
  // Two different candidates matching equally well means the name is ambiguous
  // in this area — refuse rather than guess.
  const rivals = hits.filter((h) => h.kind === best.kind && h.cand.osmId !== best.cand.osmId && haversineKm(h.cand.lat, h.cand.lng, best.cand.lat, best.cand.lng) > 0.5);
  if (rivals.length) {
    return { ambiguous: true, why: `${rivals.length + 1} equally good candidates near ${record.name}`, candidates: [best, ...rivals].map((h) => `${h.cand.name} (${h.cand.osmId})`) };
  }
  return best;
}

module.exports = { bestMatch, scoreMatch, coreTokens, jaccard, haversineKm, isArtwork, singular, STOPWORDS, VENUE_WORDS };
