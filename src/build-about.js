'use strict';
/**
 * Generate web/about.html from the canonical dataset.
 *
 * Every number, every correction and every photo credit on the page is read
 * out of data/ at build time. Nothing is typed twice: if the dataset gains a
 * row or an override gains a reason, the prose follows automatically. The
 * alternative — hand-written stats in marketing copy — goes stale silently and
 * then the landing page is quietly lying about the thing it is introducing.
 *
 * Fonts and photos are self-hosted (web/vendor/, web/img/) rather than
 * hotlinked, same as the map — see src/build-web.js.
 */

const fs = require('fs');
const path = require('path');
const SEO = require('./seo');
const { loadImageCredits } = require('./image-credits');

const ROOT = path.join(__dirname, '..');

const TITLE = 'Big Things — what this is, and how honest it is';
const DESCRIPTION = "A mapped dataset of Australia's giant novelty roadside sculptures, built from open data — including where it is uncertain, what it gets wrong, and what we corrected.";

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain text (no markup) version of a superlative, for JSON-LD answer text. */
const describePlain = (t) => (t ? `${t.name} at ${t.location || t.stateName}` : 'unknown');

/** Human labels for the precision tiers, in the order they should be read. */
const PRECISION_COPY = [
  ['exact-article', 'The sculpture has its own Wikipedia article, with coordinates'],
  ['exact-wikivoyage', 'A Wikivoyage travel marker for this name, in this state'],
  ['exact-osm', 'Matched to an OpenStreetMap feature near the right town'],
  ['exact-verified', 'Researched individually against councils, operators and OSM'],
  ['exact-inline', 'A coordinate written inline in the source table'],
  ['town', 'The town’s centre — <strong>not</strong> the sculpture'],
  ['none', 'Could not be placed at all'],
];

/** The famous ones, for the photo strip. First match wins, in this order. */
const STRIP_WANTED = [
  ['Big Banana', 'NSW'],
  ['The Big Merino', 'NSW'],
  ['The Big Lobster', 'SA'],
  ['The Big Pineapple', 'QLD'],
  ['The Big Golden Guitar', 'NSW'],
  ['The Giant Koala', 'VIC'],
];

function bars(entries, fmt) {
  const max = Math.max(...entries.map(([, n]) => n));
  const rows = entries.map(([k, n]) => {
    const label = fmt(k);
    const width = Math.max(2, (n / max) * 100).toFixed(1);
    return `<div class="bar" title="${esc(label)}: ${n}">`
      + `<span class="lbl">${esc(label)}</span>`
      + `<span class="t"><span class="f" style="width:${width}%"></span></span>`
      + `<span class="n">${n}</span></div>`;
  });
  return `<div class="bars">${rows.join('')}</div>`;
}

const CATEGORY_LABEL = {
  'fruit-and-veg': '🍌 Fruit & veg',
  fauna: '🦘 Fauna',
  seafood: '🦐 Seafood',
  'food-and-drink': '🍺 Food & drink',
  'machinery-and-transport': '🚜 Machines',
  'tools-and-industry': '🔨 Tools',
  'sport-and-leisure': '🎾 Sport',
  'people-and-culture': '🎸 People',
  oddity: '🛸 Oddity',
};

/** One photo tile, credited — the licence requires the photographer's name. */
function shot(thing, credits) {
  const c = credits[thing.image];
  if (!c) return '';
  const src = c.local;
  const author = c.author ? esc(c.author.length > 40 ? `${c.author.slice(0, 40)}…` : c.author) : 'Unknown';
  // A custom photo (see docs/ADMIN.md) has no Commons file page to link the
  // photographer's name to — link it only when there's somewhere real to send
  // a reader, rather than a broken href="" or an invented Commons link.
  const authorHtml = c.filePage
    ? `<a href="${esc(c.filePage)}" target="_blank" rel="noopener noreferrer">${author}</a>`
    : author;
  const licence = c.licenceUrl
    ? `<a href="${esc(c.licenceUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.licence)}</a>`
    : esc(c.licence || '');
  // A short place: the Location cell can be verbose ("Woombye, 5.5 km south of
  // Nambour"), which does not fit a 170px tile.
  const place = thing.town || String(thing.location || '').split(',')[0].trim() || thing.stateName;
  return `<figure class="shot">
      <img src="${esc(src)}" alt="${esc(thing.name)}, ${esc(place)}" loading="lazy">
      <figcaption>
        <b>${esc(thing.name)}</b>
        <span class="place">${esc(place)}, ${esc(thing.state)}</span>
        <span class="by">Photo: ${authorHtml} · ${licence}</span>
      </figcaption>
    </figure>`;
}

function pickStrip(things) {
  const out = [];
  for (const [name, state] of STRIP_WANTED) {
    const hit = things.find((t) => t.name === name && t.state === state && t.image);
    if (hit) out.push(hit);
  }
  // Top up with anything photographed and precisely placed, if a name moved.
  for (const t of things) {
    if (out.length >= 6) break;
    if (t.image && t.precision.startsWith('exact') && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 6);
}

function generate() {
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'overrides.json'), 'utf8'));
  const credits = loadImageCredits();

  const template = fs.readFileSync(path.join(ROOT, 'web', 'about-template.html'), 'utf8');
  const things = dataset.things;
  const s = dataset.meta.stats;
  const lost = (s.byStatus.demolished || 0) + (s.byStatus.removed || 0);
  const exactPct = Math.round((s.exact / s.total) * 100);
  const photoCount = Object.keys(credits).length;

  /* ---- headline figures ---- */
  const figures = [
    [s.total.toLocaleString(), 'mapped'],
    [s.exact.toLocaleString(), 'pinpointed'],
    [(s.byPrecision.town || 0).toLocaleString(), 'town-level'],
    [String(lost), 'lost'],
    [dataset.meta.claimedNationalTotal.toLocaleString(), 'claimed to exist'],
  ].map(([n, l]) => `<div class="fig"><b>${n}</b><span>${l}</span></div>`).join('');

  /* ---- precision table ---- */
  const precisionRows = PRECISION_COPY
    .filter(([key]) => s.byPrecision[key])
    .map(([key, copy]) => `<tr><td>${copy}</td><td class="num">${s.byPrecision[key]}</td></tr>`)
    .join('')
    + `<tr class="total"><td>Total</td><td class="num">${s.total}</td></tr>`;

  /* ---- corrections, straight from the curated overrides ---- */
  const curated = things.filter((t) => t.correction && t.correction.why && !t.addedManually);
  // Show the substantial ones, not the first six alphabetically. Several
  // records share a single override (the three Sapphire entries have identical
  // reasoning), so dedupe on the explanation before ranking by how much there
  // is to explain — the Nullarbor bull deserves the space, its neighbours
  // in the alphabet do not.
  const seenWhy = new Set();
  const showcase = [...curated]
    .filter((t) => {
      const key = t.correction.why.slice(0, 60);
      if (seenWhy.has(key)) return false;
      seenWhy.add(key);
      return true;
    })
    .sort((a, b) => b.correction.why.length - a.correction.why.length);
  const fixes = showcase.slice(0, 6).map((t) => {
    const why = t.correction.why.length > 300 ? `${t.correction.why.slice(0, 300)}…` : t.correction.why;
    const src = t.correction.source
      ? `<p class="src"><a href="${esc(t.correction.source)}" target="_blank" rel="noopener noreferrer">Source</a></p>`
      : '';
    return `<div class="fix"><h4>${esc(t.name)} <span style="font-size:12px;color:var(--ink-soft)">${esc(t.state)}</span></h4><p>${esc(why)}</p>${src}</div>`;
  }).join('');

  /* ---- superlatives, computed not typed ---- */
  const describe = (t) => (t ? `<strong>${esc(t.name)}</strong> at ${esc(t.location || t.stateName)}` : 'unknown');
  const withYear = things.filter((t) => t.builtYear);
  const oldest = [...withYear].sort((a, b) => a.builtYear - b.builtYear)[0];
  const newest = [...withYear].sort((a, b) => b.builtYear - a.builtYear)[0];
  const biggest = [...things].filter((t) => t.sizeMaxM).sort((a, b) => b.sizeMaxM - a.sizeMaxM)[0];
  const tallest = [...things].filter((t) => t.heightM).sort((a, b) => b.heightM - a.heightM)[0];

  /* ---- sources ---- */
  const sourceCards = (dataset.meta.sources || []).map((src) => `<div class="src-card">
      <h4><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.name)}</a></h4>
      <p>${esc(sourceBlurb(src.name))}</p>
      <span class="lic">${esc(src.licence)}</span>
    </div>`).join('')
    + `<div class="src-card">
      <h4><a href="https://landofthebigs.com/" target="_blank" rel="noopener noreferrer">Land of the Bigs</a> &amp; <a href="https://www.aussiebigthings.com.au/" target="_blank" rel="noopener noreferrer">Aussie Big Things</a></h4>
      <p>Community catalogues that enumerate far more than the wikis do. Facts only — a name, a place, a coordinate — cited per row.</p>
      <span class="lic">facts only, cited</span>
    </div>`;

  // Download links come from data/downloads.json so they can be refreshed
  // without touching code.
  const dlPath = path.join(ROOT, 'data', 'downloads.json');
  const dls = fs.existsSync(dlPath) ? JSON.parse(fs.readFileSync(dlPath, 'utf8')).downloads || [] : [];
  const downloads = dls.map((d) => {
    const body = `<b>${esc(d.file)}</b><span>${esc(d.blurb)}</span>`;
    return `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
  }).join('');

  const footerSources = (dataset.meta.sources || [])
    .map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.name.replace(/ —.*$/, ''))}</a>`)
    .join(' · ');

  /* ---- structured data — the same superlatives above, as answer-engine-readable Q&A ---- */
  const site = SEO.loadSite();
  const faqs = [
    ['How many big things are in Australia?', `A 2023 academic census counted ${dataset.meta.claimedNationalTotal.toLocaleString()} big things in Australia, but that figure comes from a census, not a published list — nobody has ever named all of them in one place.`],
    ['How many big things does this map show, and how accurate are the locations?', `This map shows ${s.total.toLocaleString()} of the claimed ${dataset.meta.claimedNationalTotal.toLocaleString()}. ${s.exact.toLocaleString()} (${exactPct}%) are placed at the sculpture itself; the rest sit at their town's centre because that is all the sources give.`],
    ['What is the oldest big thing in Australia?', oldest ? `The oldest is ${describePlain(oldest)}, built in ${oldest.builtYear}.` : null],
    ['What is the newest big thing in Australia?', newest ? `The newest is ${describePlain(newest)}, built in ${newest.builtYear}.` : null],
    ['What is the biggest big thing in Australia?', biggest ? `The largest along any single axis is ${describePlain(biggest)}, at ${biggest.sizeMaxM} m.` : null],
    ['What is the tallest big thing in Australia?', tallest ? `The tallest, measured as a height by its own source, is ${describePlain(tallest)}, at ${tallest.heightM} m.` : null],
    ['How many big things have been demolished or removed?', `${lost} of the ${s.total.toLocaleString()} mapped here are recorded as demolished or removed, and are kept on the map rather than deleted.`],
    ['Is there an official list of Australia\'s big things?', 'No. There is no official register. This dataset is assembled from Wikipedia, Wikivoyage, OpenStreetMap and two independent community catalogues, cross-checked against each other, with every correction recorded and cited.'],
  ].filter(([, a]) => a);

  const faqPage = {
    '@type': 'FAQPage',
    mainEntity: faqs.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };

  const breadcrumbs = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Big Things', item: `${site.siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'About' },
    ],
  };

  const seoMeta = `${SEO.metaTags({ siteUrl: site.siteUrl, pagePath: '/about.html', title: TITLE, description: DESCRIPTION, image: site.shareImage })}\n${SEO.ldScript([faqPage, breadcrumbs])}`;

  return template
    .replace('__TITLE__', SEO.escAttr(TITLE))
    .replace('__DESCRIPTION__', SEO.escAttr(DESCRIPTION))
    .replace('__SEO_META__', seoMeta)
    .replace(/__FIGURES__/g, figures)
    .replace(/__STRIP__/g, pickStrip(things).map((t) => shot(t, credits)).join(''))
    .replace(/__PRECISION_ROWS__/g, precisionRows)
    .replace(/__FIXES__/g, fixes)
    .replace(/__FIXCOUNT__/g, String(curated.length))
    .replace(/__BY_STATE__/g, bars(Object.entries(s.byState).sort((a, b) => b[1] - a[1]), (k) => k))
    .replace(/__BY_CATEGORY__/g, bars(Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]), (k) => CATEGORY_LABEL[k] || k))
    .replace(/__OLDEST__/g, oldest ? `${describe(oldest)}, ${oldest.builtYear}` : 'unknown')
    .replace(/__NEWEST__/g, newest ? `${describe(newest)}, ${newest.builtYear}` : 'unknown')
    .replace(/__BIGGEST__/g, biggest ? `${describe(biggest)} at ${biggest.sizeMaxM} m` : 'unknown')
    .replace(/__TALLEST__/g, tallest ? `${describe(tallest)} at ${tallest.heightM} m` : 'unknown')
    .replace(/__SOURCES__/g, sourceCards)
    .replace(/__DOWNLOADS__/g, downloads)
    .replace(/__FOOTER_SOURCES__/g, footerSources)
    .replace(/__PHOTOS__/g, String(photoCount))
    .replace(/__CLAIMED__/g, dataset.meta.claimedNationalTotal.toLocaleString())
    .replace(/__EXACT_PCT__/g, String(exactPct))
    .replace(/__EXACT__/g, s.exact.toLocaleString())
    .replace(/__LOST__/g, String(lost))
    .replace(/__TOTAL__/g, s.total.toLocaleString())
    .replace(/__GENERATED__/g, esc(dataset.meta.generated));
}

function sourceBlurb(name) {
  if (/^Wikipedia/.test(name)) return 'The spine of the dataset: names, towns, years, dimensions and notes, state by state.';
  if (/^Wikivoyage/.test(name)) return 'Surveyed marker coordinates, travel-guide voice, and entries Wikipedia omits.';
  if (/OpenStreetMap/.test(name)) return 'An independent coordinate cross-check, and the basemap tiles once you zoom in on the map.';
  if (/Commons/.test(name)) return 'The photographs, each under its own free licence and credited to its photographer.';
  return 'A contributing source, cited on every record that uses it.';
}

if (require.main === module) {
  const dest = path.join(ROOT, 'web', 'about.html');
  const html = generate();
  const left = html.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`unfilled placeholders in the about build: ${[...new Set(left)].join(', ')}`);
  fs.writeFileSync(dest, html);
  console.log(`wrote ${path.relative(ROOT, dest)} — ${(html.length / 1024).toFixed(0)} KB`);
}

module.exports = { generate, bars, pickStrip, PRECISION_COPY, CATEGORY_LABEL };
