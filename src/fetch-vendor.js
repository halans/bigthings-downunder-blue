'use strict';
/**
 * Vendor the third-party front-end assets so the app has no external
 * dependencies at all: Leaflet, its marker-cluster plugin, their stylesheets
 * and sprite images, and the two webfonts.
 *
 * Also fetches a simplified Australia + state-boundary outline. Basemap tiles
 * are fetched per view and can never be bundled, so at the continent view —
 * where loading tiles for the whole of Australia would be wasteful anyway —
 * this outline is drawn instead, underneath the pins.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');
const UA = 'BigThingsMap/1.0 (open-data research project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, redirects = 0, ua = UA) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return get(new URL(res.headers.location, url).toString(), redirects + 1, ua).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function getRetry(url, attempts = 4, ua = UA) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    try { return await get(url, 0, ua); } catch (e) {
      if (i === attempts) throw e;
      await sleep(wait); wait *= 2;
    }
  }
}

/** Leaflet, MarkerCluster, and the sprite/marker images their CSS references. */
const ASSETS = [
  ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'leaflet.js'],
  ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'leaflet.css'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/layers.png', 'images/layers.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png', 'images/layers-2x.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', 'images/marker-icon.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png', 'images/marker-icon-2x.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', 'images/marker-shadow.png'],
  ['https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js', 'leaflet.markercluster.js'],
  ['https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css', 'MarkerCluster.css'],
  ['https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css', 'MarkerCluster.Default.css'],
];

/**
 * Google Fonts serves a stylesheet whose @font-face rules point at woff2
 * files; fetch the stylesheet, pull the URLs out, download each, and rewrite
 * the CSS to reference the local copies.
 */
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Caprasimo&family=Inter:wght@400;500;600;700&display=swap';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function vendorFonts() {
  // Google Fonts negotiates on User-Agent: our research UA is served legacy
  // TTF (~1.4 MB total), a modern browser UA is served woff2 (~200 KB).
  const css = (await getRetry(FONT_CSS, 4, BROWSER_UA)).toString('utf8');
  const urls = [...new Set((css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || []))];
  let rewritten = css;
  let n = 0;
  for (const u of urls) {
    const name = 'fonts/' + path.basename(new URL(u).pathname);
    const dest = path.join(VENDOR, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, await getRetry(u, 4, BROWSER_UA));
      await sleep(200);
    }
    rewritten = rewritten.split(u).join(name);
    n++;
  }
  fs.writeFileSync(path.join(VENDOR, 'fonts.css'), rewritten);
  console.log(`  fonts: ${n} files + fonts.css`);
}

/**
 * Natural Earth 1:50m states/provinces, filtered to Australia and simplified.
 * Public domain.
 *
 * The 1:110m admin-1 file looks tempting at 180 KB but contains only 51
 * features — the United States. Australia first appears in the 1:50m set,
 * which is 2.3 MB before filtering and a few tens of KB after.
 */
const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson';

/** Natural Earth's postal abbreviations differ from ours for three states. */
const NE_POSTAL_TO_STATE = { WA: 'WA', NT: 'NT', SA: 'SA', QL: 'QLD', TS: 'TAS', VI: 'VIC', CT: 'ACT', NS: 'NSW', JB: 'ACT' };

/** Douglas–Peucker, so the outline ships as tens of KB rather than hundreds. */
function simplifyRing(points, tolerance) {
  if (points.length < 3) return points;
  const sqTol = tolerance * tolerance;
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1];
    let dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  };
  const simplifyStep = (first, last, out) => {
    let maxSqDist = sqTol;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sqDist = sqSegDist(points[i], points[first], points[last]);
      if (sqDist > maxSqDist) { index = i; maxSqDist = sqDist; }
    }
    if (index > 0) {
      if (index - first > 1) simplifyStep(first, index, out);
      out.push(points[index]);
      if (last - index > 1) simplifyStep(index, last, out);
    }
  };
  const out = [points[0]];
  const mid = [];
  simplifyStep(0, points.length - 1, mid);
  mid.sort((a, b) => points.indexOf(a) - points.indexOf(b));
  out.push(...mid, points[points.length - 1]);
  return out;
}

function simplifyGeometry(geom, tolerance) {
  const round = (p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geom.coordinates.map((r) => simplifyRing(r, tolerance).map(round)) };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates
        .map((poly) => poly.map((r) => simplifyRing(r, tolerance).map(round)))
        // Drop slivers that survive simplification as degenerate rings.
        .map((poly) => poly.filter((r) => r.length >= 4))
        .filter((poly) => poly.length > 0),
    };
  }
  return geom;
}

async function vendorOutline() {
  const raw = JSON.parse((await getRetry(NE_URL)).toString('utf8'));
  const features = (raw.features || [])
    .filter((f) => {
      const p = f.properties || {};
      return p.admin === 'Australia' || p.iso_a2 === 'AU' || p.sov_a3 === 'AU1' || p.adm0_a3 === 'AUS';
    })
    .map((f) => ({
      type: 'Feature',
      properties: {
        name: (f.properties || {}).name || null,
        state: NE_POSTAL_TO_STATE[(f.properties || {}).postal] || null,
      },
      geometry: simplifyGeometry(f.geometry, 0.03),
    }))
    .filter((f) => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length);

  const out = { type: 'FeatureCollection', features };
  const dest = path.join(VENDOR, 'australia-outline.geojson');
  fs.writeFileSync(dest, JSON.stringify(out));
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  outline: ${features.length} state/territory polygons, ${kb} KB`);
  if (!features.length) throw new Error('no Australian features found in the Natural Earth data');
}

async function main() {
  fs.mkdirSync(path.join(VENDOR, 'images'), { recursive: true });
  console.log('vendoring front-end assets…');

  for (const [url, name] of ASSETS) {
    const dest = path.join(VENDOR, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, await getRetry(url));
    await sleep(200);
  }
  console.log(`  libraries: ${ASSETS.length} files`);

  await vendorFonts();
  await vendorOutline();

  // A manifest so the bundle can prove its vendored copies are untampered.
  const manifest = {};
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else manifest[rel] = {
        bytes: fs.statSync(p).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
      };
    }
  };
  walk(VENDOR);
  fs.writeFileSync(path.join(ROOT, 'data', 'vendor-manifest.json'), JSON.stringify({
    _readme: 'Checksums for the vendored front-end assets in web/vendor/. Generated by src/fetch-vendor.js.',
    generated: new Date().toISOString().slice(0, 10),
    sources: {
      leaflet: 'https://unpkg.com/leaflet@1.9.4/ — BSD-2-Clause',
      markercluster: 'https://unpkg.com/leaflet.markercluster@1.5.3/ — MIT',
      fonts: 'Google Fonts: Caprasimo + Inter — SIL Open Font License 1.1',
      outline: 'Natural Earth 1:110m admin-1 states/provinces — public domain',
    },
    files: manifest,
  }, null, 1));

  const total = Object.values(manifest).reduce((a, f) => a + f.bytes, 0);
  console.log(`\nweb/vendor/: ${Object.keys(manifest).length} files, ${(total / 1024).toFixed(0)} KB`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { simplifyRing, simplifyGeometry, ASSETS, NE_POSTAL_TO_STATE };
