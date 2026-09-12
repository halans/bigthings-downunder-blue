'use strict';
/**
 * The single source of truth. Merges the Wikipedia table, the Wikivoyage
 * listings, Wikipedia article/town coordinates and the OSM cross-check into
 * one canonical dataset, resolving coordinates in explicit precision tiers.
 *
 * Precision tiers, best first:
 *   exact-article    the big thing's own Wikipedia article carries coordinates
 *   exact-wikivoyage a Wikivoyage marker for this name + state
 *   exact-osm        an OpenStreetMap feature with a matching name in-state
 *   exact-inline     a {{coord}} template inline in the source table
 *   town             the coordinates of the town it stands in (NOT the sculpture)
 *   none             could not be placed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const N = require('./normalise');

const CACHE = path.join(__dirname, '..', 'cache');
const DATA = path.join(__dirname, '..', 'data');

/** Generous state/territory bounding boxes, used only to reject bad matches. */
const STATE_BBOX = {
  ACT: [-36.0, 148.6, -35.0, 149.6],
  NSW: [-37.7, 140.8, -27.9, 154.1],
  NT: [-26.2, 128.8, -10.8, 138.2],
  QLD: [-29.4, 137.9, -9.0, 154.0],
  SA: [-38.3, 128.8, -25.9, 141.2],
  TAS: [-43.8, 143.7, -39.1, 148.6],
  VIC: [-39.3, 140.8, -33.9, 150.1],
  WA: [-35.3, 112.8, -13.6, 129.2],
};
const AU_BBOX = [-44.0, 112.5, -9.0, 154.2];

const STATE_NAMES = {
  ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory',
  QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
};

function inBox(c, box) {
  return !!c && c.lat >= box[0] && c.lat <= box[2] && c.lng >= box[1] && c.lng <= box[3];
}
const inState = (c, state) => inBox(c, STATE_BBOX[state] || AU_BBOX);

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** OSM name → candidate elements, filtered to plausible novelty features. */
function buildOsmIndex(osm) {
  const NOISE = /\b(creek|river|hill|lake|dam|bridge|road|street|beach|bay|island|park|reserve|forest|swamp|springs?|flat|ridge|rock|point|tree|gully|paddock|mine|station|camp|lookout|walk|track|trail|falls?|desert|plain|valley|bend|crossing|landing|waterhole|billabong|junction)\b/i;
  const idx = new Map();
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    if (!tags.name) continue;
    const c = el.lat != null ? { lat: el.lat, lng: el.lon } : (el.center ? { lat: el.center.lat, lng: el.center.lon } : null);
    if (!inBox(c, AU_BBOX)) continue;
    const isArt = !!(tags.tourism === 'attraction' || tags.tourism === 'artwork' || tags.artwork_type || tags.man_made === 'sculpture' || tags.historic);
    if (!isArt && NOISE.test(tags.name)) continue;
    const key = N.slugName(tags.name);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ name: tags.name, coords: c, isArt, osmId: `${el.type}/${el.id}`, tags });
  }
  return idx;
}

/** Slug-keyed lookup for the Wikivoyage listings. */
function buildVoyageIndex(records) {
  const idx = new Map();
  for (const r of records) {
    for (const key of [`${r.state}|${N.slugName(r.name)}`, N.slugName(r.name)]) {
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(r);
    }
  }
  return idx;
}

function stableId(state, name, location) {
  const basis = `${state}|${N.slugName(name)}|${N.slugPlace(location || '')}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 10);
}

function build() {
  const wp = readJSON(path.join(CACHE, 'stage-wikipedia.json'));
  const wv = readJSON(path.join(CACHE, 'stage-wikivoyage.json'));
  const wikiCoords = readJSON(path.join(CACHE, 'wikipedia-coords.json'));
  const osm = readJSON(path.join(CACHE, 'osm-bigthings.json'));
  const places = fs.existsSync(path.join(CACHE, 'place-coords.json')) ? readJSON(path.join(CACHE, 'place-coords.json')) : {};

  const osmIdx = buildOsmIndex(osm);
  const wvIdx = buildVoyageIndex(wv);
  const usedVoyage = new Set();
  const out = [];

  const titleCoords = (title) => {
    if (!title) return null;
    const e = wikiCoords[title.split('#')[0]];
    return e && e.coords ? e.coords : null;
  };
  const titleWikidata = (title) => {
    if (!title) return null;
    const e = wikiCoords[title.split('#')[0]];
    return e ? e.wikidata : null;
  };

  for (const r of wp) {
    const sources = [{ source: 'wikipedia', page: 'Big things (Australia)', url: 'https://en.wikipedia.org/wiki/Big_things_(Australia)' }];
    let coords = null;
    let precision = 'none';
    let coordSource = null;
    let osmId = null;

    // Tier 1 — its own article (only when it really is its own article, not a
    // "#section" pointer at the town's page).
    const ownArticle = r.articleTitle && !r.articleTitle.includes('#') ? r.articleTitle : null;
    const ownCoords = titleCoords(ownArticle);
    if (ownCoords && inState(ownCoords, r.state)) {
      coords = ownCoords; precision = 'exact-article';
      coordSource = `https://en.wikipedia.org/wiki/${encodeURIComponent(ownArticle.replace(/ /g, '_'))}`;
    }

    // Tier 2 — Wikivoyage marker.
    const vmatches = (wvIdx.get(`${r.state}|${N.slugName(r.name)}`) || []).concat(wvIdx.get(N.slugName(r.name)) || []);
    const vWithCoords = vmatches.find((v) => v.coords && inState(v.coords, r.state));
    const vAny = vmatches[0];
    if (vAny) {
      for (const v of vmatches) usedVoyage.add(v);
      sources.push({ source: 'wikivoyage', page: "Australia's big things", url: 'https://en.wikivoyage.org/wiki/Australia%27s_big_things' });
    }
    if (!coords && vWithCoords) {
      coords = vWithCoords.coords; precision = 'exact-wikivoyage';
      coordSource = 'https://en.wikivoyage.org/wiki/Australia%27s_big_things';
    }

    // Tier 3 — OpenStreetMap name match inside the right state.
    const osmCands = (osmIdx.get(N.slugName(r.name)) || []).filter((e) => inState(e.coords, r.state));
    const osmPick = osmCands.find((e) => e.isArt) || osmCands[0];
    if (osmPick) {
      osmId = osmPick.osmId;
      sources.push({ source: 'openstreetmap', page: osmPick.osmId, url: `https://www.openstreetmap.org/${osmPick.osmId}` });
      if (!coords) {
        coords = osmPick.coords; precision = 'exact-osm';
        coordSource = `https://www.openstreetmap.org/${osmPick.osmId}`;
      }
    }

    // Tier 4 — an inline {{coord}} in the table.
    if (!coords && r.coordTemplate && inState(r.coordTemplate, r.state)) {
      coords = r.coordTemplate; precision = 'exact-inline';
      coordSource = 'https://en.wikipedia.org/wiki/Big_things_(Australia)';
    }

    // Tier 5 — the town. Honest about being town-level.
    let townName = null;
    if (!coords) {
      for (const link of r.locationLinks) {
        const c = titleCoords(link);
        if (c && inState(c, r.state)) { coords = c; precision = 'town'; townName = link.split('#')[0].split(',')[0]; coordSource = `https://en.wikipedia.org/wiki/${encodeURIComponent(link.split('#')[0].replace(/ /g, '_'))}`; break; }
      }
    }
    if (!coords && r.location) {
      const key = `${N.slugPlace(r.location)}|${r.state}`;
      const p = places[key];
      if (p && p.coords && inState(p.coords, r.state)) {
        coords = p.coords; precision = 'town'; townName = p.matchedTitle ? p.matchedTitle.split(',')[0] : r.location;
        coordSource = p.matchedTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.matchedTitle.replace(/ /g, '_'))}` : null;
      }
    }

    const blurb = vAny && vAny.blurb ? vAny.blurb : null;
    out.push({
      id: stableId(r.state, r.name, r.location),
      name: r.name,
      state: r.state,
      stateName: STATE_NAMES[r.state],
      location: r.location,
      town: townName,
      lat: coords ? N.round(coords.lat, 6) : null,
      lng: coords ? N.round(coords.lng, 6) : null,
      precision,
      coordSource,
      builtYear: r.builtYear,
      builtCirca: r.builtCirca,
      builtRaw: r.builtRaw,
      era: r.era,
      heightM: r.heightM,
      lengthM: r.lengthM,
      sizeMaxM: r.sizeMaxM,
      sizeKind: r.sizeKind,
      dimsM: r.dimsM,
      sizeRaw: r.sizeRaw,
      category: r.category,
      status: r.status,
      statusEvidence: r.statusEvidence,
      notes: r.notes,
      blurb,
      image: r.images.length ? r.images[0] : null,
      wikipediaArticle: ownArticle,
      wikidata: titleWikidata(ownArticle),
      osmId,
      sources,
    });
  }

  // Wikivoyage-only entries: real big things the Wikipedia table omits.
  const wpKeys = new Set(out.map((o) => `${o.state}|${N.slugName(o.name)}`));
  const wpNameOnly = new Set(out.map((o) => N.slugName(o.name)));
  for (const v of wv) {
    if (usedVoyage.has(v)) continue;
    const key = `${v.state}|${N.slugName(v.name)}`;
    if (wpKeys.has(key)) continue;
    // A same-named thing in another state is a different big thing, but a
    // same-named thing with no address is more likely a duplicate — skip it.
    if (!v.address && wpNameOnly.has(N.slugName(v.name))) continue;

    let coords = v.coords && inState(v.coords, v.state) ? v.coords : null;
    let precision = coords ? 'exact-wikivoyage' : 'none';
    let coordSource = coords ? 'https://en.wikivoyage.org/wiki/Australia%27s_big_things' : null;
    let osmId = null;
    let townName = null;

    const osmCands = (osmIdx.get(N.slugName(v.name)) || []).filter((e) => inState(e.coords, v.state));
    const osmPick = osmCands.find((e) => e.isArt) || osmCands[0];
    if (osmPick) {
      osmId = osmPick.osmId;
      if (!coords) { coords = osmPick.coords; precision = 'exact-osm'; coordSource = `https://www.openstreetmap.org/${osmPick.osmId}`; }
    }
    if (!coords) {
      for (const link of v.addressLinks) {
        const c = titleCoords(link);
        if (c && inState(c, v.state)) { coords = c; precision = 'town'; townName = link.split('#')[0].split(',')[0]; coordSource = `https://en.wikipedia.org/wiki/${encodeURIComponent(link.split('#')[0].replace(/ /g, '_'))}`; break; }
      }
    }
    if (!coords && v.address) {
      const pk = `${N.slugPlace(v.address)}|${v.state}`;
      const p = places[pk];
      if (p && p.coords && inState(p.coords, v.state)) {
        coords = p.coords; precision = 'town'; townName = p.matchedTitle ? p.matchedTitle.split(',')[0] : v.address;
        coordSource = p.matchedTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.matchedTitle.replace(/ /g, '_'))}` : null;
      }
    }

    const sources = [{ source: 'wikivoyage', page: "Australia's big things", url: 'https://en.wikivoyage.org/wiki/Australia%27s_big_things' }];
    if (osmId) sources.push({ source: 'openstreetmap', page: osmId, url: `https://www.openstreetmap.org/${osmId}` });

    out.push({
      id: stableId(v.state, v.name, v.address),
      name: v.name,
      state: v.state,
      stateName: STATE_NAMES[v.state],
      location: v.address,
      town: townName,
      lat: coords ? N.round(coords.lat, 6) : null,
      lng: coords ? N.round(coords.lng, 6) : null,
      precision,
      coordSource,
      builtYear: null, builtCirca: false, builtRaw: null, era: 'unknown',
      heightM: null, lengthM: null, sizeMaxM: null, sizeKind: 'unknown', dimsM: [], sizeRaw: null,
      category: N.classify(v.name, v.blurb),
      status: 'standing', statusEvidence: null,
      notes: null,
      blurb: v.blurb,
      image: null,
      wikipediaArticle: null, wikidata: null, osmId,
      sources,
    });
  }

  // Order matters. Additions run before overrides so a correction can match
  // and edit an added row by its id — corrections used to run first, which
  // meant a correction targeting a discovered/added record (by id or by
  // name+state) silently matched nothing, because that row didn't exist yet.
  // Overrides and additions between them supply the town points that rows
  // with a blank Location cell would otherwise lack, and the OSM matcher was
  // run against the finished dataset — so it has to see those points too.
  // Human-verified coordinates are applied last because they outrank an
  // automated name match.
  applyAdditions(out);
  applyOverrides(out);
  applyRemovals(out);
  applyOsmMatches(out);
  applyVerifiedCoords(out);
  out.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  return out;
}

/**
 * Upgrade town-level pins using the audited OSM proximity matches produced by
 * src/run-osm-match.js. Only matches that survived the audit in
 * cache/osm-matches.json are applied, and only over a `town` pin.
 */
function applyOsmMatches(rows) {
  const p = path.join(CACHE, 'osm-matches.json');
  if (!fs.existsSync(p)) return;
  const { matches } = readJSON(p);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, m] of Object.entries(matches || {})) {
    const row = byId.get(id);
    if (!row || row.precision !== 'town') continue;
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
    if (!inState({ lat: m.lat, lng: m.lng }, row.state)) continue;
    row.lat = N.round(m.lat, 6);
    row.lng = N.round(m.lng, 6);
    row.precision = 'exact-osm';
    row.coordSource = m.source;
    row.osmId = row.osmId || m.osmId;
    row.coordMatch = { kind: m.kind, confidence: m.confidence, why: m.why, osmName: m.osmName };
    if (!row.sources.some((s) => s.url === m.source)) {
      row.sources.push({ source: 'openstreetmap', page: m.osmId, url: m.source });
    }
  }
}

/**
 * Upgrade town-level pins to surveyed points where a coordinate has been
 * independently verified against OSM/Nominatim/operator sources.
 */
function applyVerifiedCoords(rows) {
  // Several research passes each write their own file; merge them all so a new
  // batch is picked up by dropping a file in, with no code change.
  const files = fs.readdirSync(CACHE)
    .filter((f) => /^verified-coords.*\.json$/.test(f))
    .sort();
  if (!files.length) return;
  const verified = {};
  for (const f of files) Object.assign(verified, readJSON(path.join(CACHE, f)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, v] of Object.entries(verified)) {
    const row = byId.get(id);
    if (!row || !v || v.townOnly || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
    if (!inState({ lat: v.lat, lng: v.lng }, row.state)) continue;
    // Beats a town pin or an automated OSM name match; defers to a coordinate
    // published on the sculpture's own Wikipedia/Wikivoyage entry.
    if (!['town', 'none', 'exact-osm'].includes(row.precision)) continue;
    row.lat = N.round(v.lat, 6);
    row.lng = N.round(v.lng, 6);
    row.precision = 'exact-verified';
    row.coordSource = v.source || null;
    row.coordMatch = { kind: 'researched', confidence: v.confidence || 'medium', why: v.note || null, osmName: v.sourceName || null };
    if (!row.sources.some((s) => s.url && s.url === v.source)) {
      row.sources.push({ source: 'verified', page: v.sourceName || 'independent lookup', url: v.source || null });
    }
  }
}

/**
 * Add big things that independent sources document but neither wiki list
 * carries. Each needs a source; they are marked so the app can show provenance.
 */
function applyAdditions(rows) {
  // Two sources of additions: the small hand-curated list in overrides.json,
  // and the bulk discovery output in discovered.json. Curated entries are
  // applied first so a human judgement wins any collision.
  const additions = [];
  const curated = path.join(DATA, 'overrides.json');
  if (fs.existsSync(curated)) additions.push(...(readJSON(curated).additions || []));
  const discovered = path.join(DATA, 'discovered.json');
  if (fs.existsSync(discovered)) additions.push(...(readJSON(discovered).additions || []));
  if (!additions.length) return;

  for (const a of additions) {
    const key = `${a.state}|${N.slugName(a.name)}`;
    if (rows.some((r) => `${r.state}|${N.slugName(r.name)}` === key)) continue;
    rows.push({
      id: stableId(a.state, a.name, a.location),
      name: a.name,
      state: a.state,
      stateName: STATE_NAMES[a.state],
      location: a.location || null,
      town: a.town || a.location || null,
      lat: a.lat != null ? N.round(a.lat, 6) : null,
      lng: a.lng != null ? N.round(a.lng, 6) : null,
      precision: a.precision || 'none',
      coordSource: a.coordSource || null,
      builtYear: a.builtYear || null,
      builtCirca: false,
      builtRaw: a.builtRaw || null,
      era: N.era(a.builtYear || null),
      heightM: a.heightM || null,
      lengthM: null,
      sizeMaxM: a.heightM || null,
      sizeKind: a.heightM ? 'height' : 'unknown',
      dimsM: a.heightM ? [a.heightM] : [],
      sizeRaw: a.sizeRaw || null,
      category: a.category || N.classify(a.name, a.notes),
      status: a.status || 'standing',
      statusEvidence: null,
      notes: a.notes || null,
      blurb: null,
      image: null,
      wikipediaArticle: null,
      wikidata: null,
      osmId: null,
      addedManually: true,
      correction: { why: a.why, source: a.source || null },
      sources: [{ source: a.sourceName || 'independent reporting', page: a.source || 'curated addition', url: a.source || null }],
    });
  }
}

/**
 * Drop rows that duplicate another row under a different name. Kept explicit
 * and sourced rather than folded into the dedup heuristics, because these are
 * editorial judgements about two names meaning one sculpture.
 */
function applyRemovals(rows) {
  const p = path.join(DATA, 'overrides.json');
  if (!fs.existsSync(p)) return;
  const { removals } = readJSON(p);
  for (const r of removals || []) {
    const idx = rows.findIndex((x) => Object.entries(r.match).every(([k, v]) => x[k] === v));
    if (idx === -1) { process.stderr.write(`  removal matched nothing: ${JSON.stringify(r.match)}\n`); continue; }
    rows.splice(idx, 1);
  }
}

/** Apply the hand-curated corrections in data/overrides.json. */
function applyOverrides(rows) {
  const p = path.join(DATA, 'overrides.json');
  if (!fs.existsSync(p)) return;
  const { corrections } = readJSON(p);
  for (const c of corrections || []) {
    const matches = rows.filter((r) => Object.entries(c.match).every(([k, v]) => r[k] === v));
    if (!matches.length) { process.stderr.write(`  override matched nothing: ${JSON.stringify(c.match)}\n`); continue; }
    for (const row of matches) {
      // Never let an override clobber a coordinate that is already surveyed.
      const set = { ...c.set };
      if (row.precision.startsWith('exact') && set.precision === 'town') {
        delete set.lat; delete set.lng; delete set.precision; delete set.coordSource;
      }
      Object.assign(row, set);
      row.correction = { why: c.why, source: c.source || null };
      if (set.state) row.id = stableId(row.state, row.name, row.location);
      // era is derived from builtYear, not stored independently — a
      // correction that sets one without the other left `era` stuck at
      // whatever it was computed as originally (often "unknown", for a
      // discovered/added record with no year at harvest time), which is
      // invisible in the data but silently breaks the era filter on the map.
      if (set.builtYear !== undefined && set.era === undefined) row.era = N.era(row.builtYear);
    }
  }
}

function stats(rows) {
  const tally = (fn) => rows.reduce((acc, r) => { const k = fn(r); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  return {
    total: rows.length,
    mapped: rows.filter((r) => r.lat != null).length,
    exact: rows.filter((r) => r.precision.startsWith('exact')).length,
    byPrecision: tally((r) => r.precision),
    byState: tally((r) => r.state),
    byCategory: tally((r) => r.category),
    byStatus: tally((r) => r.status),
    byEra: tally((r) => r.era),
    withYear: rows.filter((r) => r.builtYear).length,
    withHeight: rows.filter((r) => r.heightM).length,
    withAnySize: rows.filter((r) => r.sizeMaxM).length,
    withImage: rows.filter((r) => r.image).length,
  };
}

if (require.main === module) {
  fs.mkdirSync(DATA, { recursive: true });
  const rows = build();
  const s = stats(rows);
  fs.writeFileSync(path.join(DATA, 'bigthings.json'), JSON.stringify({
    meta: {
      generated: new Date().toISOString().slice(0, 10),
      claimedNationalTotal: 1075,
      claimedTotalSource: 'Clarke, A. (2023). Making a Mark… Journal of Australian Studies 47(2), cited by Wikipedia',
      sources: [
        { name: 'Wikipedia: Big things (Australia)', url: 'https://en.wikipedia.org/wiki/Big_things_(Australia)', licence: 'CC BY-SA 4.0' },
        { name: "Wikivoyage: Australia's big things", url: 'https://en.wikivoyage.org/wiki/Australia%27s_big_things', licence: 'CC BY-SA 4.0' },
        { name: 'OpenStreetMap via Overpass API', url: 'https://www.openstreetmap.org/', licence: 'ODbL 1.0' },
        { name: 'Wikimedia Commons (images)', url: 'https://commons.wikimedia.org/', licence: 'various free licences' },
      ],
      stats: s,
    },
    things: rows,
  }, null, 1));
  console.log(JSON.stringify(s, null, 2));
}

module.exports = { build, stats, STATE_BBOX, AU_BBOX, STATE_NAMES, inState, buildOsmIndex, stableId };
