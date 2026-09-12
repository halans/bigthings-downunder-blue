'use strict';
/**
 * Overpass harvest of every public EV charging point in Australia
 * (amenity=charging_station), used by src/build.js to flag a big thing as
 * having a charger within walking distance. Optional: if this cache is
 * never fetched, that flag is simply never set — nothing else depends on it.
 */

const fs = require('fs');
const path = require('path');
const { post } = require('./fetch-coords');

const CACHE = path.join(__dirname, '..', 'cache');

const QUERY = `
[out:json][timeout:180];
area["ISO3166-1"="AU"][admin_level=2]->.au;
(
  nwr["amenity"="charging_station"](area.au);
);
out center tags;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchChargers() {
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

/** Flatten to just what the proximity check needs: {lat, lng, osmId}. */
function condense(json) {
  const out = [];
  for (const el of json.elements || []) {
    const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
    const lng = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
    if (lat == null || lng == null) continue;
    out.push({
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      osmId: `${el.type}/${el.id}`,
    });
  }
  return out;
}

async function main() {
  const json = await fetchChargers();
  const rows = condense(json);
  fs.writeFileSync(path.join(CACHE, 'ev-chargers.json'), JSON.stringify(rows));
  console.log(`${(json.elements || []).length} raw elements → ${rows.length} located charging points`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { fetchChargers, condense, QUERY };
