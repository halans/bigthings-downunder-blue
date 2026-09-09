'use strict';
/**
 * Resolve free-text Location strings ("Pokolbin", "Picton, at Saddleworld,
 * 20/15 Henry Street") to town coordinates via the MediaWiki API, and cache
 * the result. Town-level only — callers must label the precision accordingly.
 */

const fs = require('fs');
const path = require('path');
const { getRetry, fetchWikiCoords } = require('./fetch-coords');
const N = require('./normalise');
const { STATE_NAMES } = require('./build');

const CACHE = path.join(__dirname, '..', 'cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reduce a messy location string to candidate place names, most specific
 * first. "Picton, at Saddleworld, 20/15 Henry Street" → ["Picton"].
 */
function placeCandidates(location, state) {
  if (!location) return [];
  let s = location
    .replace(/\bWA\b|\bNSW\b|\bQLD\b|\bVIC\b|\bSA\b|\bNT\b|\bTAS\b|\bACT\b/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\b(cnr|corner of|corner|opposite|next to|near|just north of|just south of|just east of|just west of|north of|south of|at|on|in)\b/gi, ',');
  const parts = s.split(/[,;/()]+/).map((p) => p.trim()).filter(Boolean);
  const cands = [];
  const roadDerived = [];
  /**
   * A fragment that names a road ("Forrest Highway", "Port Wakefield Road")
   * yields a treacherous town candidate: strip the road type and "Forrest" is
   * a real locality on the Nullarbor, 900 km from the Forrest Highway, while
   * "Port Wakefield" is 30 km from Port Wakefield Road at Lower Light. Such
   * fragments are still tried, but only after every other fragment.
   */
  const ROAD_TYPE = /\b(highway|hwy|road|rd|street|st|drive|dr|avenue|ave|terrace|tce|lane|ln|parade|pde|crescent|cres|esplanade|boulevard|blvd|way|court|ct)\b/i;
  for (const p of parts) {
    const namesARoad = ROAD_TYPE.test(p);
    const clean = p
      .replace(/\b\d+\s*/g, '')
      .replace(/\b(street|st|road|rd|highway|hwy|drive|dr|avenue|ave|terrace|tce|lane|ln|place|pl|parade|pde|crescent|cres|way|court|ct|esplanade|boulevard|blvd|park|farm|centre|center|complex|hotel|motel|caravan|tourist|information|visitor|shopping|mall|club|reserve|oval|showground|roadhouse|service|station|store|shop|winery|cellar|door|museum|gallery|zoo|gardens?)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length >= 3 && /[a-z]/i.test(clean) && !/^the$/i.test(clean)) {
      (namesARoad ? roadDerived : cands).push(clean);
    }
  }
  // Road-derived candidates go last, so a real locality in the same string wins.
  const uniq = [...new Set([...cands, ...roadDerived])];
  const out = [];
  for (const c of uniq) {
    out.push(`${c}, ${STATE_NAMES[state]}`);
    out.push(c);
  }
  return out;
}

/** MediaWiki full-text search restricted to a state, returning best title. */
async function searchPlace(place, state) {
  const q = `${place} ${STATE_NAMES[state]}`;
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&list=search&srlimit=5&srnamespace=0&srsearch=' + encodeURIComponent(q);
  const json = JSON.parse(await getRetry(url));
  const hits = (json.query && json.query.search) || [];
  return hits.map((h) => h.title);
}

async function main() {
  const wp = JSON.parse(fs.readFileSync(path.join(CACHE, 'stage-wikipedia.json'), 'utf8'));
  const wv = JSON.parse(fs.readFileSync(path.join(CACHE, 'stage-wikivoyage.json'), 'utf8'));

  const needed = new Map(); // key -> {location, state}
  for (const r of wp) {
    if (!r.location) continue;
    needed.set(`${N.slugPlace(r.location)}|${r.state}`, { location: r.location, state: r.state });
  }
  for (const v of wv) {
    if (!v.address) continue;
    needed.set(`${N.slugPlace(v.address)}|${v.state}`, { location: v.address, state: v.state });
  }

  const existing = fs.existsSync(path.join(CACHE, 'place-coords.json'))
    ? JSON.parse(fs.readFileSync(path.join(CACHE, 'place-coords.json'), 'utf8')) : {};

  // Pass 1 — try direct title lookups for all candidates at once.
  const allTitles = [];
  const candsByKey = new Map();
  for (const [key, v] of needed) {
    if (existing[key] && existing[key].coords) continue;
    const cands = placeCandidates(v.location, v.state);
    candsByKey.set(key, cands);
    allTitles.push(...cands);
  }
  console.log(`${candsByKey.size} locations to resolve, ${new Set(allTitles).size} candidate titles`);
  const coords = await fetchWikiCoords(allTitles);

  const stillMissing = [];
  for (const [key, cands] of candsByKey) {
    let hit = null;
    for (const c of cands) {
      const e = coords[c];
      if (e && e.coords) { hit = { coords: e.coords, matchedTitle: e.title, via: 'title' }; break; }
    }
    if (hit) existing[key] = hit;
    else stillMissing.push(key);
  }
  console.log(`resolved by title: ${candsByKey.size - stillMissing.length}; falling back to search for ${stillMissing.length}`);

  // Pass 2 — full-text search for the stubborn ones.
  const searchTitles = new Map();
  for (const key of stillMissing) {
    const v = needed.get(key);
    const first = placeCandidates(v.location, v.state)[1] || v.location;
    try {
      const titles = await searchPlace(first, v.state);
      searchTitles.set(key, titles);
    } catch (e) { process.stderr.write(`  search failed ${key}: ${e.message}\n`); }
    await sleep(700);
  }
  const flat = [...searchTitles.values()].flat();
  const coords2 = flat.length ? await fetchWikiCoords(flat) : {};
  let viaSearch = 0;
  for (const [key, titles] of searchTitles) {
    for (const t of titles) {
      const e = coords2[t];
      if (e && e.coords) { existing[key] = { coords: e.coords, matchedTitle: e.title, via: 'search' }; viaSearch++; break; }
    }
  }
  console.log(`resolved by search: ${viaSearch}`);

  fs.writeFileSync(path.join(CACHE, 'place-coords.json'), JSON.stringify(existing, null, 1));
  console.log(`place-coords.json now holds ${Object.keys(existing).length} places`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { placeCandidates, searchPlace };
