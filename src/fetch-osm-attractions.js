'use strict';
/**
 * Broad Overpass harvest: every Australian feature that could plausibly BE a
 * big thing, regardless of what it is called.
 *
 * The original query only matched names starting with "Big"/"Giant"/… which
 * misses every sculpture mapped under its proper name — Larry the Lobster,
 * Rambo, Ploddy the Dinosaur, Krys the Savannah King. Those are exactly the
 * famous ones, so they are exactly the ones worth catching.
 *
 * Precision comes from the matcher (src/match-osm.js), not the query: a
 * candidate must be near the big thing's known town AND have a name that
 * fuzzy-matches. So this query can afford to be greedy.
 */

const fs = require('fs');
const path = require('path');
const { post } = require('./fetch-coords');

const CACHE = path.join(__dirname, '..', 'cache');

const QUERY = `
[out:json][timeout:600];
area["ISO3166-1"="AU"][admin_level=2]->.au;
(
  nwr["tourism"="artwork"](area.au);
  nwr["artwork_type"](area.au);
  nwr["man_made"="sculpture"](area.au);
  nwr["tourism"="attraction"](area.au);
  nwr["historic"="memorial"]["name"](area.au);
  nwr["building"="roof"]["name"~"[Bb]ig|[Gg]iant"](area.au);
);
out center tags;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchAttractions() {
  let lastErr;
  for (const ep of ENDPOINTS) {
    try {
      process.stderr.write(`  querying ${new URL(ep).hostname}…\n`);
      const body = await post(ep, 'data=' + encodeURIComponent(QUERY));
      const json = JSON.parse(body);
      if (!json.elements) throw new Error('no elements in response');
      return json;
    } catch (e) {
      lastErr = e;
      process.stderr.write(`  ${new URL(ep).hostname} failed: ${e.message.slice(0, 120)}\n`);
    }
  }
  throw lastErr;
}

/** Keep only named features, flattened to {name, lat, lng, tags}. */
function condense(json) {
  const out = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const name = tags.name || tags['name:en'] || tags.alt_name;
    if (!name) continue;
    const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
    const lng = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
    if (lat == null || lng == null) continue;
    out.push({
      name,
      altName: tags.alt_name || null,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      osmId: `${el.type}/${el.id}`,
      tourism: tags.tourism || null,
      artwork: tags.artwork_type || null,
      manMade: tags.man_made || null,
      historic: tags.historic || null,
      subject: tags.subject || null,
      wikidata: tags.wikidata || null,
    });
  }
  return out;
}

async function main() {
  const json = await fetchAttractions();
  const rows = condense(json);
  const out = path.join(CACHE, 'osm-attractions.json');
  fs.writeFileSync(out, JSON.stringify(rows));
  console.log(`${(json.elements || []).length} raw elements → ${rows.length} named, located features`);
  const byKind = {};
  for (const r of rows) {
    const k = r.artwork ? 'artwork_type' : r.tourism || r.manMade || r.historic || 'other';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  console.log('by kind:', byKind);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { fetchAttractions, condense, QUERY };
