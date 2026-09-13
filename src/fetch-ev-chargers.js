'use strict';
/**
 * Every public EV charging point in Australia, from two independent sources,
 * merged and deduped into one list. Used by src/build.js to flag a big thing
 * as having a charger within walking distance. Optional at every layer: if
 * this cache is never fetched, that flag is simply never set — nothing else
 * depends on it.
 *
 *   OSM (always): Overpass query for amenity=charging_station.
 *   Open Charge Map (optional): needs OCM_API_KEY — a free key from
 *     https://openchargemap.org/site/developerinfo — in a .env file at the
 *     repo root (OCM_API_KEY=..., gitignored) or already in the environment.
 *     Without one, this step is skipped and the cache is OSM-only, same as
 *     before OCM support existed.
 *
 * The two overlap a lot (a charger mapped in both counts once), but OCM adds
 * real coverage OSM doesn't have: run against Australia on 2026-09-13, OSM
 * had 1,604 points, OCM had 1,337 operational ones, and 638 of those weren't
 * within 75 m of an existing OSM point — roughly 40% more chargers than OSM
 * alone.
 */

const fs = require('fs');
const path = require('path');
const { post } = require('./fetch-coords');

const CACHE = path.join(__dirname, '..', 'cache');
const ROOT = path.join(__dirname, '..');

// A charger mapped in both sources won't sit at the exact same coordinate —
// each project's own surveying error — so "the same charger" means "close
// enough to be the same site", not "identical". 75 m comfortably covers that
// without merging two genuinely different chargers on the same street.
const DEDUPE_KM = 0.075;

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- OSM (Overpass) ---------------- */

const OSM_QUERY = `
[out:json][timeout:180];
area["ISO3166-1"="AU"][admin_level=2]->.au;
(
  nwr["amenity"="charging_station"](area.au);
);
out center tags;`;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchOsmChargers() {
  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      process.stderr.write(`  querying ${new URL(ep).hostname}…\n`);
      const body = await post(ep, 'data=' + encodeURIComponent(OSM_QUERY));
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

/** Flatten Overpass's response to just {lat, lng, osmId}. */
function condenseOsm(json) {
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

/* ---------------- Open Charge Map ---------------- */

const OCM_BASE = 'https://api.openchargemap.io/v3';

/** {lat,lng} for every AU point OCM doesn't itself mark as not-operational
 * (removed, planned, decommissioned — see its own referencedata, fetched
 * fresh rather than hardcoding OCM's status-ID taxonomy here). */
async function fetchOcmChargers(apiKey) {
  const refRes = await fetch(`${OCM_BASE}/referencedata/?output=json&key=${apiKey}`);
  if (!refRes.ok) throw new Error(`OCM referencedata failed: ${refRes.status}`);
  const { StatusTypes } = await refRes.json();
  const notOperational = new Set(StatusTypes.filter((s) => s.IsOperational === false).map((s) => s.ID));

  const poiUrl = `${OCM_BASE}/poi/?output=json&countrycode=AU&maxresults=10000&compact=true&verbose=false&key=${apiKey}`;
  const poiRes = await fetch(poiUrl);
  if (!poiRes.ok) throw new Error(`OCM poi failed: ${poiRes.status}`);
  const pois = await poiRes.json();
  if (pois.length >= 10000) {
    process.stderr.write(`  warning: OCM returned the full 10,000-result cap — some AU chargers may be missing.\n`);
  }

  const out = [];
  for (const p of pois) {
    if (notOperational.has(p.StatusTypeID)) continue;
    const addr = p.AddressInfo;
    if (!addr || addr.Latitude == null || addr.Longitude == null) continue;
    out.push({
      lat: Math.round(addr.Latitude * 1e6) / 1e6,
      lng: Math.round(addr.Longitude * 1e6) / 1e6,
      ocmId: p.UUID || p.ID,
    });
  }
  return out;
}

/* ---------------- merge ---------------- */

/**
 * Appends `additions` to `base`, skipping any point within DEDUPE_KM of one
 * already present — from `base` or from an earlier addition in this same
 * call. Bounding-box pre-filter first, same idiom as build.js's own
 * per-thing proximity check, since this runs base.length × additions.length
 * times in the worst case.
 */
function mergeDeduped(base, additions) {
  const combined = [...base];
  for (const point of additions) {
    const latPad = DEDUPE_KM / 111;
    const lngPad = DEDUPE_KM / (111 * Math.cos((point.lat * Math.PI) / 180) || 1);
    const isDupe = combined.some((c) => Math.abs(c.lat - point.lat) <= latPad
      && Math.abs(c.lng - point.lng) <= lngPad
      && haversineKm(point.lat, point.lng, c.lat, c.lng) <= DEDUPE_KM);
    if (!isDupe) combined.push(point);
  }
  return combined;
}

async function main() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch (e) { /* Node < 20.6 — fall through to a plain env var, if any */ }
  }

  const osmJson = await fetchOsmChargers();
  const osm = condenseOsm(osmJson);
  console.log(`OSM: ${(osmJson.elements || []).length} raw elements → ${osm.length} located charging points`);

  let combined = osm;
  const ocmKey = process.env.OCM_API_KEY;
  if (ocmKey) {
    process.stderr.write('  querying openchargemap.org…\n');
    const ocm = await fetchOcmChargers(ocmKey);
    combined = mergeDeduped(osm, ocm);
    console.log(`OCM: ${ocm.length} operational points → ${combined.length - osm.length} not already within ${DEDUPE_KM * 1000}m of an OSM point`);
  } else {
    console.log('OCM: skipped — no OCM_API_KEY in .env or the environment (get one free at https://openchargemap.org/site/developerinfo)');
  }

  fs.writeFileSync(path.join(CACHE, 'ev-chargers.json'), JSON.stringify(combined));
  console.log(`wrote cache/ev-chargers.json — ${combined.length} charging points total`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { fetchOsmChargers, condenseOsm, fetchOcmChargers, mergeDeduped, OSM_QUERY };
