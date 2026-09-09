'use strict';
/**
 * Fetch-and-cache stage. Pulls coordinates from two free sources:
 *   1. MediaWiki API `prop=coordinates` for every article title referenced by
 *      the Wikipedia table (the big thing itself, and its town).
 *   2. OpenStreetMap Overpass for AU features whose name starts with "Big"/
 *      "Giant"/"World's Largest" — used as an independent cross-check.
 * Results are written to cache/ so the build runs offline afterwards.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, '..', 'cache');
const UA = 'BigThingsMap/1.0 (open-data research project; nodejs)';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, headers).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 200)}`))));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

function post(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`))));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with exponential backoff. Wikimedia answers 429 when a batch run gets
 * enthusiastic; the retry is what keeps a full rebuild unattended-safe.
 */
async function getRetry(url, attempts = 6) {
  let wait = 2000;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await get(url);
    } catch (e) {
      const retryable = /HTTP (429|5\d\d)|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(e.message);
      if (!retryable || i === attempts) throw e;
      process.stderr.write(`  retry ${i}/${attempts} after ${wait}ms (${e.message.slice(0, 60)})\n`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
    }
  }
  throw new Error('unreachable');
}

/** Batch MediaWiki coordinate + wikidata-id lookup, 50 titles at a time. */
async function fetchWikiCoords(titles) {
  const unique = [...new Set(titles.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2'
      + '&prop=coordinates|pageprops&ppprop=wikibase_item&coprop=type|name&colimit=max&redirects=1'
      + '&titles=' + batch.map(encodeURIComponent).join('|');
    const json = JSON.parse(await getRetry(url));
    const q = json.query || {};
    const normMap = {};
    for (const n of q.normalized || []) normMap[n.from] = n.to;
    for (const r of q.redirects || []) normMap[r.from] = r.to;
    const byTitle = {};
    for (const p of q.pages || []) {
      byTitle[p.title] = {
        title: p.title,
        missing: !!p.missing,
        wikidata: p.pageprops && p.pageprops.wikibase_item ? p.pageprops.wikibase_item : null,
        coords: p.coordinates && p.coordinates.length ? { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon } : null,
      };
    }
    for (const t of batch) {
      let resolved = t;
      const seen = new Set();
      while (normMap[resolved] && !seen.has(resolved)) { seen.add(resolved); resolved = normMap[resolved]; }
      out[t] = byTitle[resolved] || { title: resolved, missing: true, wikidata: null, coords: null };
    }
    process.stderr.write(`  wiki coords ${Math.min(i + 50, unique.length)}/${unique.length}\n`);
    await sleep(1200);
  }
  return out;
}

/** Overpass: AU nodes/ways/relations named like a big thing. */
async function fetchOverpass() {
  const query = `
[out:json][timeout:170];
area["ISO3166-1"="AU"][admin_level=2]->.au;
(
  node["name"~"^(The )?(Big|Giant|Large|World'?s Largest) ",i](area.au);
  way["name"~"^(The )?(Big|Giant|Large|World'?s Largest) ",i](area.au);
  relation["name"~"^(The )?(Big|Giant|Large|World'?s Largest) ",i](area.au);
);
out center tags;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastErr;
  for (const ep of endpoints) {
    try {
      return JSON.parse(await post(ep, 'data=' + encodeURIComponent(query)));
    } catch (e) { lastErr = e; process.stderr.write(`  overpass ${ep} failed: ${e.message}\n`); }
  }
  throw lastErr;
}

async function main() {
  const stage = JSON.parse(fs.readFileSync(path.join(CACHE, 'stage-wikipedia.json'), 'utf8'));

  const titles = [];
  for (const r of stage) {
    if (r.articleTitle) titles.push(r.articleTitle.split('#')[0]);
    for (const l of r.locationLinks) titles.push(l.split('#')[0]);
  }
  console.log(`resolving ${new Set(titles).size} unique Wikipedia titles…`);
  const wiki = await fetchWikiCoords(titles);
  fs.writeFileSync(path.join(CACHE, 'wikipedia-coords.json'), JSON.stringify(wiki, null, 1));
  const withCoords = Object.values(wiki).filter((v) => v.coords).length;
  console.log(`  ${withCoords}/${Object.keys(wiki).length} titles have coordinates`);

  console.log('querying Overpass for AU "Big *" features…');
  const osm = await fetchOverpass();
  fs.writeFileSync(path.join(CACHE, 'osm-bigthings.json'), JSON.stringify(osm, null, 1));
  console.log(`  ${(osm.elements || []).length} OSM elements`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { get, getRetry, post, fetchWikiCoords, fetchOverpass };
