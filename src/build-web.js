'use strict';
/**
 * Generate the web app from the canonical dataset — twice, from one template.
 *
 *   web/index.html    online build: CDN Leaflet, Google Fonts, OSM tiles, and
 *                     photos hotlinked from Wikimedia Commons. This is what
 *                     gets published.
 *   web/offline.html  offline build: every asset local. Photos come from
 *                     web/img/, libraries and fonts from web/vendor/, and a
 *                     vector Australia outline stands in for the tiles that no
 *                     bundle can contain. Works with the network unplugged.
 *
 * The page is never hand-maintained: web/template.html holds the shell and the
 * placeholders, and a test asserts the offline build contains no external URLs.
 */

const fs = require('fs');
const path = require('path');
const SEO = require('./seo');

const ROOT = path.join(__dirname, '..');

const TITLE = "Big Things — a map of Australia's giant roadside sculptures";
const DESCRIPTION = "An interactive map of Australia's Big Things: giant novelty sculptures, fibreglass fruit and enormous fauna, built from open data.";

/** Fields the app actually reads. Keeps the inlined payload lean. */
const FIELDS = [
  'id', 'name', 'state', 'stateName', 'location', 'town', 'lat', 'lng',
  'precision', 'coordSource', 'builtYear', 'builtCirca', 'builtRaw', 'era',
  'heightM', 'lengthM', 'sizeMaxM', 'sizeKind', 'sizeRaw', 'category',
  'status', 'statusEvidence', 'notes', 'blurb', 'image', 'wikipediaArticle',
  'sources', 'correction', 'coordMatch', 'addedManually',
];

const HEAD_ONLINE = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">`;

const HEAD_OFFLINE = `<link rel="stylesheet" href="vendor/fonts.css">
<link rel="stylesheet" href="vendor/leaflet.css">
<link rel="stylesheet" href="vendor/MarkerCluster.css">`;

const SCRIPTS_ONLINE = `<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>`;

const SCRIPTS_OFFLINE = `<script src="vendor/leaflet.js"></script>
<script src="vendor/leaflet.markercluster.js"></script>`;

function slim(dataset) {
  return {
    meta: {
      generated: dataset.meta.generated,
      claimedNationalTotal: dataset.meta.claimedNationalTotal,
      claimedTotalSource: dataset.meta.claimedTotalSource,
      stats: dataset.meta.stats,
      sources: dataset.meta.sources,
    },
    things: dataset.things.map((t) => {
      const o = {};
      for (const f of FIELDS) if (t[f] !== undefined && t[f] !== null) o[f] = t[f];
      return o;
    }),
  };
}

/**
 * Compact per-photo credit map, keyed by Commons filename. Short keys because
 * this ships inline for every photo in the dataset:
 *   a = author · l = licence · u = licence URL · p = file page · f = local file
 */
function creditMap(dataset) {
  const p = path.join(ROOT, 'data', 'image-credits.json');
  if (!fs.existsSync(p)) return {};
  const { images } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const used = new Set(dataset.things.map((t) => t.image).filter(Boolean));
  const out = {};
  for (const [file, meta] of Object.entries(images || {})) {
    if (!used.has(file)) continue;
    out[file] = {
      a: meta.author || null,
      l: meta.licence || null,
      u: meta.licenceUrl || null,
      p: meta.filePage || null,
      f: meta.local || null,
    };
  }
  return out;
}

/** Escape a JSON payload so it is safe to inline inside a <script> block. */
const inlineJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

/**
 * The Dataset/WebSite/ItemList structured data that makes the 477 individual
 * things machine-readable without needing a per-item page: a crawler that
 * never runs the app's JS still sees every name, location and description in
 * the raw HTML. Facts only — no url is fabricated for an item, since the app
 * has no per-item deep link (address bar never changes), and claiming one
 * would misdirect anything that followed it.
 */
function buildJsonLd(dataset, offline) {
  const { siteUrl } = SEO.loadSite();
  const creditsPath = path.join(ROOT, 'data', 'image-credits.json');
  const images = fs.existsSync(creditsPath) ? JSON.parse(fs.readFileSync(creditsPath, 'utf8')).images : {};
  const downloadsPath = path.join(ROOT, 'data', 'downloads.json');
  const downloads = fs.existsSync(downloadsPath) ? JSON.parse(fs.readFileSync(downloadsPath, 'utf8')).downloads || [] : [];

  const website = { '@type': 'WebSite', name: 'Big Things', url: `${siteUrl}/`, description: DESCRIPTION, inLanguage: 'en-AU' };

  const datasetLd = {
    '@type': 'Dataset',
    name: "Australia's Big Things",
    description: DESCRIPTION,
    url: `${siteUrl}/`,
    license: 'https://creativecommons.org/licenses/by-sa/4.0/',
    dateModified: dataset.meta.generated,
    spatialCoverage: { '@type': 'Place', name: 'Australia' },
    distribution: downloads
      .filter((d) => /\.(json|geojson)$/.test(d.file))
      .map((d) => ({
        '@type': 'DataDownload',
        name: d.file,
        contentUrl: d.url,
        encodingFormat: d.file.endsWith('.geojson') ? 'application/geo+json' : 'application/json',
      })),
  };

  const itemListElement = dataset.things.map((t, i) => {
    const img = t.image ? images[t.image] : null;
    const photo = img ? (offline ? `${siteUrl}/${img.local}` : img.remote) : undefined;
    return {
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Place',
        name: t.name,
        description: t.blurb || t.notes || undefined,
        geo: { '@type': 'GeoCoordinates', latitude: t.lat, longitude: t.lng },
        address: {
          '@type': 'PostalAddress',
          addressLocality: t.town || undefined,
          addressRegion: t.stateName,
          addressCountry: 'AU',
        },
        image: photo,
        sameAs: t.wikipediaArticle
          ? `https://en.wikipedia.org/wiki/${encodeURIComponent(t.wikipediaArticle.replace(/ /g, '_'))}`
          : undefined,
        // Most things are still standing, so schema.org's default assumption
        // needs no flag. The ones that aren't are exactly the ones an answer
        // engine must not cite as if they still exist.
        additionalProperty: t.status === 'standing' ? undefined : [{ '@type': 'PropertyValue', name: 'status', value: t.status }],
      },
    };
  });

  const itemList = { '@type': 'ItemList', name: "Australia's Big Things", numberOfItems: itemListElement.length, itemListElement };

  return SEO.ldScript([website, datasetLd, itemList]);
}

function generate(mode = 'online') {
  if (mode !== 'online' && mode !== 'offline') throw new Error(`unknown build mode: ${mode}`);
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const template = fs.readFileSync(path.join(ROOT, 'web', 'template.html'), 'utf8');
  for (const token of ['__DATA__', '__MODE__', '__CREDITS__', '__OUTLINE__', '__HEAD_ASSETS__', '__SCRIPT_ASSETS__', '__ABOUT_HREF__', '__TITLE__', '__DESCRIPTION__', '__SEO_META__']) {
    if (!template.includes(token)) throw new Error(`template.html is missing the ${token} placeholder`);
  }

  const offline = mode === 'offline';
  let outline = 'null';
  if (offline) {
    const op = path.join(ROOT, 'web', 'vendor', 'australia-outline.geojson');
    if (!fs.existsSync(op)) throw new Error('web/vendor/australia-outline.geojson missing — run `node src/fetch-vendor.js`');
    outline = inlineJson(JSON.parse(fs.readFileSync(op, 'utf8')));
  }

  const site = SEO.loadSite();
  const seoMeta = `${SEO.metaTags({ siteUrl: site.siteUrl, pagePath: '/', title: TITLE, description: DESCRIPTION, image: site.shareImage })}\n${buildJsonLd(dataset, offline)}`;

  return template
    .replace(/__ABOUT_HREF__/g, offline ? 'about-offline.html' : 'about.html')
    .replace('__TITLE__', SEO.escAttr(TITLE))
    .replace('__DESCRIPTION__', SEO.escAttr(DESCRIPTION))
    .replace('__SEO_META__', seoMeta)
    .replace('__HEAD_ASSETS__', offline ? HEAD_OFFLINE : HEAD_ONLINE)
    .replace('__SCRIPT_ASSETS__', offline ? SCRIPTS_OFFLINE : SCRIPTS_ONLINE)
    .replace('__MODE__', mode)
    .replace('__DATA__', inlineJson(slim(dataset)))
    .replace('__CREDITS__', inlineJson(creditMap(dataset)))
    .replace('__OUTLINE__', outline);
}

/** Every photo, its photographer and its licence — for the bundle. */
function creditsMarkdown() {
  const p = path.join(ROOT, 'data', 'image-credits.json');
  if (!fs.existsSync(p)) return null;
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const byFile = new Map();
  for (const t of dataset.things) if (t.image) byFile.set(t.image, t);

  const rows = Object.entries(manifest.images || {})
    .filter(([file]) => byFile.has(file))
    .sort((a, b) => byFile.get(a[0]).name.localeCompare(byFile.get(b[0]).name));

  const byLicence = {};
  for (const [, m] of rows) byLicence[m.licence || 'unstated'] = (byLicence[m.licence || 'unstated'] || 0) + 1;

  const lines = [
    '# Photo credits',
    '',
    `${rows.length} photographs, vendored from Wikimedia Commons at ${manifest.width}px wide on ${manifest.generated}.`,
    '',
    'Every one is reproduced under a free licence. Most require attribution, so the',
    'photographer and licence are named here, on each photo in the app, and in',
    '`data/image-credits.json` alongside a checksum of the local copy.',
    '',
    '**The photographs are not covered by this repository\'s licence.** Each remains',
    'under the licence its author chose; the dataset itself is CC BY-SA 4.0.',
    '',
    '## Licences used',
    '',
    ...Object.entries(byLicence).sort((a, b) => b[1] - a[1]).map(([l, n]) => `- ${l} — ${n} ${n === 1 ? 'photo' : 'photos'}`),
    '',
    '## Every photo',
    '',
    '| Big thing | Photographer | Licence | File |',
    '|---|---|---|---|',
    ...rows.map(([file, m]) => {
      const thing = byFile.get(file);
      const author = (m.author || 'Unknown').replace(/\|/g, '\\|').slice(0, 60);
      const lic = m.licenceUrl ? `[${m.licence}](${m.licenceUrl})` : (m.licence || 'see file page');
      return `| ${thing.name} (${thing.state}) | ${author} | ${lic} | [${file.replace(/\|/g, '\\|')}](${m.filePage}) |`;
    }),
    '',
  ];
  if ((manifest.skipped || []).length) {
    lines.push('## Not vendored', '',
      'These were referenced by the dataset but not shipped. A card without a photo is',
      'a better outcome than a file we cannot license.', '',
      ...manifest.skipped.map((s) => `- \`${s.file}\` — ${s.why}`), '');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const outputs = [
    ['online', path.join(ROOT, 'web', 'index.html')],
    ['offline', path.join(ROOT, 'web', 'offline.html')],
  ];
  for (const [mode, dest] of outputs) {
    try {
      const html = generate(mode);
      fs.writeFileSync(dest, html);
      console.log(`wrote ${path.relative(ROOT, dest)} — ${(html.length / 1024).toFixed(0)} KB (${mode})`);
    } catch (e) {
      if (mode === 'offline') { console.log(`skipped the offline build: ${e.message}`); continue; }
      throw e;
    }
  }
  const md = creditsMarkdown();
  if (md) {
    fs.writeFileSync(path.join(ROOT, 'docs', 'IMAGE-CREDITS.md'), md);
    console.log('wrote docs/IMAGE-CREDITS.md');
  }
}

module.exports = { generate, slim, creditMap, creditsMarkdown, FIELDS, HEAD_OFFLINE, SCRIPTS_OFFLINE };
