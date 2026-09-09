'use strict';
/**
 * Turn cache/discovery-raw.json into data/discovered.json — the audited set of
 * big things that neither wiki list carries.
 *
 * Everything here is about NOT polluting the dataset:
 *   · a candidate must have a name, a state and a coordinate inside that state
 *   · it must not already exist under any name we can recognise
 *   · a low-precision coordinate is labelled town-level, not passed off as a
 *     surveyed point
 *   · nothing is accepted without the URL it came from
 *
 * The output is reviewable as a diff before it reaches the dataset.
 */

const fs = require('fs');
const path = require('path');
const N = require('./normalise');
const { STATE_BBOX, STATE_NAMES } = require('./build');
const M = require('./match-osm');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');

/**
 * The catalogue's own subject categories are better evidence of what a thing
 * IS than our keyword rules are — it knows a thorny devil is an animal and a
 * bogong moth is an insect without us listing every species.
 */
const SOURCE_CATEGORY_MAP = {
  'big-fruit': 'fruit-and-veg',
  'big-vegetables': 'fruit-and-veg',
  'big-animals': 'fauna',
  'big-birds': 'fauna',
  'big-insects': 'fauna',
  'big-reptiles': 'fauna',
  'big-crocodiles': 'fauna',
  'big-dinosaurs': 'fauna',
  'big-fish': 'seafood',
  'big-sea-creatures': 'seafood',
  'big-food': 'food-and-drink',
  'big-alcohol': 'food-and-drink',
  'big-tools': 'tools-and-industry',
  'big-people': 'people-and-culture',
  'big-shoes': 'people-and-culture',
  'big-clothing': 'people-and-culture',
  'big-parade-floats': 'people-and-culture',
};

const SOURCE_META = {
  landofthebigs: { name: 'Land of the Bigs', home: 'https://landofthebigs.com/' },
  aussiebigthings: { name: 'Aussie Big Things Passport', home: 'https://www.aussiebigthings.com.au/' },
};

/**
 * Split "The Big Cauliflower, Waterloo, NSW" into name and town.
 * Titles from both catalogues use "Name, Town, State" or "Name — Town, State".
 */
function splitTitle(title, state) {
  if (!title) return null;
  const cleaned = title.replace(/\s*[—–]\s*/g, ', ').trim();
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  // Drop a trailing state, in code or full-name form.
  const isState = (p) => {
    const u = p.toUpperCase();
    if (u === state) return true;
    return Object.entries(STATE_NAMES).some(([code, full]) => code === state && full.toLowerCase() === p.toLowerCase());
  };
  while (parts.length > 1 && isState(parts[parts.length - 1])) parts.pop();

  const name = parts[0];
  const town = parts.length > 1 ? parts.slice(1).join(', ') : null;
  return { name, town };
}

/** How many decimal places does the coarser of the two coordinates carry? */
function coordPrecisionDp(coords) {
  const dp = (n) => {
    const s = String(n);
    const i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  };
  return Math.min(dp(coords.lat), dp(coords.lng));
}

const inBox = (c, b) => !!b && c.lat >= b[0] && c.lat <= b[2] && c.lng >= b[1] && c.lng <= b[3];
const inState = (c, state) => inBox(c, STATE_BBOX[state]);

/**
 * Jurisdictions whose records must be compared against each other when
 * deduplicating, because one encloses the other.
 *
 * Two earlier attempts at this were worse. Resolving the state purely from the
 * coordinate "relocated" the Big Merino from Goulburn to Victoria, because
 * these bounding boxes are crude overlapping rectangles — Victoria's reaches
 * north to -33.9. Restating NSW as ACT whenever a point fell in the ACT box
 * then moved Queanbeyan and Googong, which are genuinely NSW, because no
 * rectangle traces the ACT's eastern border.
 *
 * The real problem was never classification, it was dedup: the Belconnen Big
 * Powerful Owl arrives labelled NSW and duplicates the ACT record we already
 * hold. So the state is left exactly as the source states it, and the enclave
 * relationship is used only to widen the dedup search — where proximity, not a
 * rectangle, does the deciding.
 */
const ENCLAVE_PEERS = { NSW: ['ACT'], ACT: ['NSW'] };

/**
 * Is this candidate already in the dataset?
 *
 * Name alone is hopeless — Australia has nine Big Apples — and name+town is
 * defeated by nicknames ("Itsy Bitsy the Big Spider" for Urana's Big Spider).
 * So a candidate is a duplicate when it is CLOSE to an existing record and
 * their names overlap at all, or when name+town match outright.
 */
/**
 * Core tokens, plus a variant that keeps parenthesised text. `slugPlace` drops
 * brackets, which hid the nickname in "Big Kangaroo (Matilda)" and let it
 * through as new alongside "Matilda The Kangaroo".
 */
function nameTokenSets(name) {
  const plain = M.coreTokens(name);
  const withBrackets = M.coreTokens(String(name).replace(/[()]/g, ' '));
  return [plain, withBrackets];
}

function findDuplicate(cand, existing) {
  const candSets = nameTokenSets(cand.name);
  const candName = candSets[1];
  const candTown = cand.town ? N.slugPlace(cand.town) : null;

  const peers = ENCLAVE_PEERS[cand.state] || [];
  for (const e of existing) {
    const sameState = e.state === cand.state;
    const enclavePeer = peers.includes(e.state);
    if (!sameState && !enclavePeer) continue;
    // Across an enclave border, only proximity can justify a merge.
    if (enclavePeer) {
      if (!cand.coords || e.lat == null) continue;
      const km = M.haversineKm(cand.coords.lat, cand.coords.lng, e.lat, e.lng);
      const eTokens = nameTokenSets(e.name)[1];
      const overlap = [...candName].some((t) => eTokens.has(t));
      if (km <= 2 && overlap) return { row: e, why: `same object across the ${cand.state}/${e.state} border, ${km.toFixed(2)} km apart` };
      continue;
    }
    const eSets = nameTokenSets(e.name);
    const eName = eSets[1];
    const eTown = N.slugPlace(e.town || e.location || '');

    const nameOverlap = [...candName].some((t) => eName.has(t)) || [...eName].some((t) => candName.has(t));
    const sameTown = !!candTown && !!eTown && (candTown === eTown || candTown.includes(eTown) || eTown.includes(candTown));

    // Same name-ish and same town: duplicate.
    if (nameOverlap && sameTown) return { row: e, why: 'name overlap and same town' };

    // Names identical after normalising: duplicate regardless of town wording.
    for (const a of candSets) {
      for (const b of eSets) {
        if (a.size && b.size && a.size === b.size && [...a].every((t) => b.has(t))) {
          return { row: e, why: 'identical core name in the same state' };
        }
      }
    }
    // A nickname wholly contained in the other name, in the same state, within
    // a few km: "Big Kangaroo (Matilda)" vs "Matilda The Kangaroo".
    if (cand.coords && e.lat != null) {
      const km = M.haversineKm(cand.coords.lat, cand.coords.lng, e.lat, e.lng);
      const contains = [...candName].every((t) => eName.has(t)) || [...eName].every((t) => candName.has(t));
      if (km <= 8 && contains && candName.size && eName.size) {
        return { row: e, why: `one name contains the other and they are ${km.toFixed(1)} km apart` };
      }
    }

    // Within 2 km and the names share a word: the same object, differently named.
    if (cand.coords && e.lat != null && nameOverlap) {
      const km = M.haversineKm(cand.coords.lat, cand.coords.lng, e.lat, e.lng);
      if (km <= 2) return { row: e, why: `name overlap and ${km.toFixed(2)} km apart` };
    }
  }
  return null;
}

function build() {
  const rawPath = path.join(CACHE, 'discovery-raw.json');
  if (!fs.existsSync(rawPath)) {
    console.error('cache/discovery-raw.json not found — run `node src/fetch-discovery.js` first');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));

  // Dedup against everything EXCEPT rows this pass previously contributed.
  // The dataset already contains them after a build, so comparing against the
  // whole thing makes the stage non-idempotent: a second run matched all 100
  // discoveries against themselves and emptied discovered.json.
  const CATALOGUE_HOSTS = /landofthebigs\.com|aussiebigthings\.com\.au/;
  const fromDiscovery = (t) => !!t.addedManually
    && (t.sources || []).some((sc) => sc.url && CATALOGUE_HOSTS.test(sc.url));
  const existing = dataset.things.filter((t) => !fromDiscovery(t));

  const accepted = [];
  const rejected = { noTitle: [], noState: [], noCoords: [], outOfState: [], duplicate: [], notABigThing: [] };
  const review = [];    // catalogued, but does not read as a novelty big thing
  const restated = [];  // the coordinate disagreed with the stated state
  const seen = [];

  // Prefer the higher-precision catalogue when both list the same thing.
  const order = { landofthebigs: 0, aussiebigthings: 1 };
  const rows = [...raw].sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9));

  for (const r of rows) {
    if (r.error || !r.title) { rejected.noTitle.push(r.url); continue; }
    if (!r.state) { rejected.noState.push(r.url); continue; }
    const split = splitTitle(r.title, r.state);
    if (!split || !split.name) { rejected.noTitle.push(r.url); continue; }

    // Guard against listicles and non-Australian entries slipping through.
    if (/\b\d+\s+big\b/i.test(split.name) || /^(the )?(awesome|best|top|ultimate)\b/i.test(split.name)) {
      rejected.notABigThing.push(`${split.name} — ${r.url}`);
      continue;
    }
    if (!r.coords) { rejected.noCoords.push(`${split.name} (${r.state})`); continue; }

    const state = r.state;
    if (!inState(r.coords, state)) {
      rejected.outOfState.push(`${split.name} (${state}) @ ${r.coords.lat},${r.coords.lng}`);
      continue;
    }

    const cand = { name: split.name, town: split.town, state, coords: r.coords };

    const dupOfExisting = findDuplicate(cand, existing);
    if (dupOfExisting) {
      rejected.duplicate.push(`${cand.name} (${cand.state}) ≈ ${dupOfExisting.row.name} [${dupOfExisting.why}]`);
      continue;
    }
    const dupOfAccepted = findDuplicate(cand, seen);
    if (dupOfAccepted) {
      rejected.duplicate.push(`${cand.name} (${cand.state}) ≈ already accepted ${dupOfAccepted.row.name} [${dupOfAccepted.why}]`);
      continue;
    }

    // Scope guard, decided by the catalogue's own taxonomy rather than by us.
    //
    // Both sources list civic public art and memorials alongside novelty
    // roadside sculpture. Absorbing a war memorial into a playful Big Things
    // map is both a category error and a tonal one. An earlier version guessed
    // from the name, which mis-sorted "Bigfoot" and "Chickaletta" as art and
    // could not tell "Almost Once" from a giant clam. The site itself already
    // makes the distinction: genuine novelties get a `big-*` category and the
    // `big-things` / `roadside-attractions` tags; the rest sit in
    // `uncategorized`. The name test runs alongside it as a second positive
    // signal, so an un-tagged or un-filed page still yields something.
    const cats = r.categories || [];
    const tags = r.tags || [];
    const hasTaxonomy = cats.length > 0 || tags.length > 0;
    const taxonomySaysBigThing = cats.some((c) => /^big[-_]/.test(c))
      || tags.some((t) => t === 'big-things' || t === 'roadside-attractions' || /^big-/.test(t));
    const nameSaysBigThing = /\b(big|bigg?est|giant|large|largest|world'?s|mini|colossal|enormous|jumbo)\b/i.test(split.name)
      || /\bbigfoot\b/i.test(split.name)
      || /\b\w+\s+the\s+\w+/i.test(split.name);
    // Either signal is positive evidence, so accept on either. Requiring both
    // held back "The Big Bow and Arrow" and "Norbert the Yellow Dragon", which
    // are plainly big things the site simply never filed under a big-* category
    // — an incomplete taxonomy is not a claim that something is fine art.
    const inScope = taxonomySaysBigThing || nameSaysBigThing;
    if (!inScope) {
      review.push({
        name: split.name, town: split.town, state,
        lat: N.round(r.coords.lat, 6), lng: N.round(r.coords.lng, 6),
        source: r.url, sourceName: (SOURCE_META[r.source] || {}).name || r.source,
        why: hasTaxonomy
          ? `The catalogue files this under ${cats.length ? cats.join(', ') : 'no category'}${tags.length ? ` with tags ${tags.slice(0, 6).join(', ')}` : ''} — not its big-things taxonomy.`
          : 'No taxonomy on the page, and the name does not read as a novelty big thing.',
      });
      continue;
    }

    // Two decimal places is roughly a kilometre — that is a locality, not a
    // sculpture, so it must not claim to be a surveyed point.
    const dp = coordPrecisionDp(r.coords);
    const precision = dp >= 4 ? 'exact-verified' : 'town';
    const meta = SOURCE_META[r.source] || { name: r.source, home: r.url };

    const row = {
      name: cand.name,
      state,
      location: cand.town,
      town: cand.town,
      lat: N.round(r.coords.lat, 6),
      lng: N.round(r.coords.lng, 6),
      precision,
      coordSource: r.url,
      // Source subject category first; our keyword rules only as a fallback.
      category: (cats.map((c) => SOURCE_CATEGORY_MAP[c]).find(Boolean)) || N.classify(cand.name, null),
      status: 'standing',
      source: r.url,
      sourceName: meta.name,
      sourceCategories: cats.filter((c) => /^big[-_]/.test(c)),
      why: `Catalogued by ${meta.name}${cats.filter((c) => /^big[-_]/.test(c)).length ? ` under ${cats.filter((c) => /^big[-_]/.test(c)).join(', ')}` : ''}, which publishes ${precision === 'town' ? 'a locality-level position' : 'a mapped position'} for it.`,
    };

    accepted.push(row);
    seen.push({ ...row, town: cand.town, location: cand.town });
  }

  accepted.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  review.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  return { accepted, rejected, review, restated };
}

if (require.main === module) {
  const { accepted, rejected, review, restated } = build();
  const out = path.join(ROOT, 'data', 'discovered.json');
  fs.writeFileSync(out, JSON.stringify({
    _readme: 'Big things absent from both wiki lists, discovered from community catalogues. Only facts are taken (name, place, coordinate) and each row cites the page it came from. Generated by src/extract-discovery.js — review as a diff, do not hand-edit.',
    generated: new Date().toISOString().slice(0, 10),
    additions: accepted,
  }, null, 1));

  const byState = {};
  const byPrecision = {};
  for (const a of accepted) {
    byState[a.state] = (byState[a.state] || 0) + 1;
    byPrecision[a.precision] = (byPrecision[a.precision] || 0) + 1;
  }
  fs.writeFileSync(path.join(ROOT, 'data', 'discovered-review.json'), JSON.stringify({
    _readme: 'Entries the community catalogues list that do NOT read as novelty big things — civic public art, memorials, gallery pieces. Held out of the dataset deliberately so the collection keeps its meaning. Promote one by moving it into overrides.json additions.',
    generated: new Date().toISOString().slice(0, 10),
    heldBack: review,
  }, null, 1));

  console.log(`accepted: ${accepted.length}`);
  console.log(`held back as public art / not a big thing: ${review.length} (data/discovered-review.json)`);
  if (restated.length) {
    console.log(`state corrected from the coordinate: ${restated.length}`);
    restated.forEach((x) => console.log(`   ${x}`));
  }
  console.log('  by state:    ', byState);
  console.log('  by precision:', byPrecision);
  console.log('rejected:');
  for (const [k, v] of Object.entries(rejected)) console.log(`  ${k.padEnd(14)} ${v.length}`);
  if (process.argv.includes('--report')) {
    for (const [k, v] of Object.entries(rejected)) {
      if (!v.length) continue;
      console.log(`\n--- ${k} (${v.length}) ---`);
      v.forEach((x) => console.log('   ', x));
    }
    console.log(`\n--- held back (${review.length}) ---`);
    review.forEach((x) => console.log(`   ${x.state} ${x.name} | ${x.town || '?'}`));
    console.log('\n--- accepted ---');
    accepted.forEach((a) => console.log(`  ${a.state} ${a.name} | ${a.town || '?'} | ${a.lat},${a.lng} [${a.precision}]`));
  }
}

module.exports = { build, splitTitle, findDuplicate, coordPrecisionDp, nameTokenSets, ENCLAVE_PEERS, SOURCE_CATEGORY_MAP };
