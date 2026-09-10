'use strict';
/**
 * The build's contract: every image, font and script must be self-hosted —
 * no photo hotlinked from Wikimedia Commons, no library pulled from a CDN —
 * and every photograph must carry its photographer and licence. Real
 * OpenStreetMap tiles are the one intentional exception, loaded live once
 * you zoom in; that's map data, not a bundle dependency.
 *
 * The distinction that matters here is between assets the browser *loads*
 * (which must all be local) and hyperlinks the user *clicks* (which must be
 * external — attribution links have to point at the source). An audit that
 * conflates the two either passes a broken bundle or fails a correct one.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, eq, ok } = require('./run');
const B = require('../src/build-web');
const FI = require('../src/fetch-images');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const CREDITS_PATH = path.join(ROOT, 'data', 'image-credits.json');
const hasImages = fs.existsSync(CREDITS_PATH);
const credits = hasImages ? JSON.parse(fs.readFileSync(CREDITS_PATH, 'utf8')) : { images: {}, skipped: [] };

/** Assets the browser fetches on load, as opposed to links a user follows. */
function loadedAssets(html) {
  const out = [];
  // Strip inline script bodies: they contain JS template literals such as
  // src="${heroSrc}", which are code, not asset references.
  html = html.replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
  for (const m of html.matchAll(/<script[^>]+src\s*=\s*"([^"]+)"/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<link[^>]+rel\s*=\s*"stylesheet"[^>]*>/gi)) {
    const href = /href\s*=\s*"([^"]+)"/i.exec(m[0]);
    if (href) out.push(href[1]);
  }
  for (const m of html.matchAll(/<img[^>]+src\s*=\s*"([^"]+)"/gi)) out.push(m[1]);
  // url() inside the page's own <style> block
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const m of style.matchAll(/url\(\s*['"]?([^'")]+)/g)) out.push(m[1]);
  return out.filter((u) => u && !u.startsWith('data:'));
}

/* ---------- self-hosted assets ---------- */

test('the build loads nothing from the network at page load', () => {
  const html = B.generate();
  const external = loadedAssets(html).filter((u) => /^(https?:)?\/\//.test(u));
  eq(external, [], 'every loaded asset must be a local relative path');
});

test('every asset the build references exists on disk', () => {
  const html = B.generate();
  const missing = loadedAssets(html)
    .filter((u) => !/^(https?:)?\/\//.test(u))
    .filter((u) => !fs.existsSync(path.join(WEB, u.split('?')[0])));
  eq(missing, [], 'referenced local assets must be present');
});

test('the vendored stylesheets reference only local files', () => {
  const dir = path.join(WEB, 'vendor');
  if (!fs.existsSync(dir)) return;
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      const u = m[1];
      if (/^(https?:)?\/\//.test(u)) problems.push(`${f} → ${u}`);
      // `url(#default#VML)` is Leaflet's legacy IE behaviour hook, not a file.
      else if (u.startsWith('data:') || u.startsWith('#')) continue;
      else if (!fs.existsSync(path.join(dir, u.split('?')[0]))) problems.push(`${f} → missing ${u}`);
    }
  }
  eq(problems, []);
});

test('the basemap is gated on zoom, not loaded unconditionally', () => {
  const html = B.generate();
  // The old contract was "gated on offline mode"; there is no mode any more,
  // so a bare L.tileLayer(...).addTo(map) — added regardless of zoom — would
  // load tiles for the whole continent at once, which is what the zoom gate
  // exists to avoid.
  ok(!/L\.tileLayer\([^)]*\)\.addTo\(map\)/.test(html.replace(/\s+/g, '')),
    'the tile layer must not be added unconditionally');
  ok(/const TILE_ZOOM\s*=\s*\d/.test(html), 'a zoom threshold decides which basemap shows');
  ok(html.includes('tileLayer.addTo(map)') && html.includes('outlineLayer'),
    'both the tile layer and the outline are added conditionally, not at init');
});

test('the outline covers every state and territory', () => {
  const html = B.generate();
  const m = /const OUTLINE = (\{.*?\});\n/s.exec(html);
  ok(m, 'OUTLINE is injected');
  const outline = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  eq(outline.type, 'FeatureCollection');
  ok(outline.features.length >= 8, `expected all states/territories, got ${outline.features.length}`);
  const states = new Set(outline.features.map((f) => f.properties.state));
  for (const s of ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']) {
    ok(states.has(s), `outline covers ${s}`);
  }
});

/* ---------- photo resolution ---------- */

/** Run the generated page's photo helpers without a DOM. */
function loadPhotoHelpers() {
  const html = B.generate();
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const start = script.indexOf('const DATA =');
  const declsEnd = script.indexOf('/* ---------------- state ----------------');
  const fnStart = script.indexOf('function photoUrl(');
  const fnEnd = script.indexOf('function photoCredit(');
  ok(start >= 0 && declsEnd > start && fnStart > 0 && fnEnd > fnStart, 'could not locate the photo helpers');
  // Declarations + photoUrl only; everything between them touches Leaflet.
  const src = script.slice(start, declsEnd)
    + script.slice(fnStart, fnEnd)
    + '\nmodule.exports = { photoUrl, CREDITS, THINGS };';
  const sandbox = { module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'generated-app.js' });
  return sandbox.module.exports;
}

test('photo URLs are always local, never hotlinked', () => {
  if (!hasImages) return;
  const app = loadPhotoHelpers();
  const files = Object.keys(app.CREDITS);
  ok(files.length > 100, `expected a real credit map, got ${files.length}`);
  for (const f of files) {
    const local = app.photoUrl(f);
    ok(local && local.startsWith('img/'), `URL for ${f} should be local, got ${local}`);
  }
});

test('an uncredited photo yields nothing rather than reaching out', () => {
  const app = loadPhotoHelpers();
  eq(app.photoUrl('Definitely Not Vendored.jpg'), null);
});

test('every big thing with a photo can actually resolve it', () => {
  if (!hasImages) return;
  const app = loadPhotoHelpers();
  const unresolvable = app.THINGS
    .filter((t) => t.image)
    .filter((t) => !app.photoUrl(t.image))
    .map((t) => `${t.name}: ${t.image}`);
  // Anything not vendored must be recorded as skipped, with a reason.
  const skipped = new Set((credits.skipped || []).map((s) => s.file));
  const unexplained = unresolvable.filter((u) => !skipped.has(u.split(': ').slice(1).join(': ')));
  eq(unexplained, [], 'an unresolvable photo must appear in the skipped list with a reason');
});

/* ---------- licensing ---------- */

test('every vendored photo names a photographer and a licence', () => {
  if (!hasImages) return;
  const bad = Object.entries(credits.images)
    .filter(([, m]) => !m.author || !m.licence)
    .map(([f]) => f);
  eq(bad, [], 'attribution is a licence condition, not a nicety');
});

test('no photo ships under a licence we cannot redistribute', () => {
  if (!hasImages) return;
  const bad = Object.entries(credits.images)
    .filter(([, m]) => !FI.assessLicence({ licence: m.licenceCode, usageTerms: m.licence, licenceName: m.licence }).free)
    .map(([f, m]) => `${f} (${m.licenceCode})`);
  eq(bad, []);
});

test('the licence assessor accepts free licences and refuses the rest', () => {
  const free = ['cc0', 'cc-by-2.0', 'cc-by-sa-3.0', 'cc-by-sa-4.0', 'pd', 'pd-old-100', 'public domain'];
  for (const code of free) {
    ok(FI.assessLicence({ licence: code, usageTerms: 'Creative Commons' }).free, `${code} should be free`);
  }
  ok(!FI.assessLicence({ licence: '', usageTerms: '' }).free, 'no licence at all is refused');
  ok(!FI.assessLicence({ licence: 'fair use', usageTerms: 'Fair use' }).free, 'fair use is refused');
  ok(!FI.assessLicence({ licence: 'all-rights-reserved', usageTerms: 'All rights reserved' }).free, 'ARR is refused');
});

test('each vendored file on disk matches its recorded checksum', () => {
  if (!hasImages) return;
  const bad = [];
  for (const [file, m] of Object.entries(credits.images)) {
    const p = path.join(WEB, m.local);
    if (!fs.existsSync(p)) { bad.push(`${file}: missing ${m.local}`); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (sha !== m.sha256) bad.push(`${file}: checksum drift`);
  }
  eq(bad, []);
});

test('the credit shown in the app matches the manifest', () => {
  if (!hasImages) return;
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const map = B.creditMap(dataset);
  const used = new Set(dataset.things.map((t) => t.image).filter(Boolean));
  for (const [file, c] of Object.entries(map)) {
    ok(used.has(file), `${file} is actually referenced`);
    eq(c.a, credits.images[file].author);
    eq(c.l, credits.images[file].licence);
  }
});

test('the photo credits document lists every shipped photo', () => {
  if (!hasImages) return;
  const md = B.creditsMarkdown();
  ok(md && md.length > 500, 'credits document generated');
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const used = new Set(dataset.things.map((t) => t.image).filter(Boolean));
  const listed = Object.keys(credits.images).filter((f) => used.has(f));
  const absent = listed.filter((f) => !md.includes(f));
  eq(absent, []);
  ok(/not covered by this repository/i.test(md), 'states that photos keep their own licences');
});

/* ---------- local filenames ---------- */

test('local filenames are safe and collision-free', () => {
  const a = FI.localName('Big Banana.jpg');
  const b = FI.localName('Big banana.JPG');
  ok(/^[a-z0-9.-]+$/.test(a), `filesystem-safe, got ${a}`);
  ok(a !== b, 'names differing only by case must not collide');
  eq(FI.localName('Big Banana.jpg'), a, 'stable across calls');
  ok(FI.localName('a'.repeat(200) + '.jpg').length < 80, '長い names are truncated');
});

/* ---------- layout traps ---------- */

test('any element given an inline width is styled to accept one', () => {
  // A <span> is inline, and width/height do not apply to non-replaced inline
  // elements. The Superlatives bar fills were spans inside a plain block, so
  // every bar rendered as an empty outline while the numbers beside them were
  // correct — invisible to data tests, and to a render health check.
  const html = B.generate();
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  // Collect classes on spans that receive an inline width/height.
  const sized = new Set();
  for (const m of html.matchAll(/<span[^>]*class="([a-z0-9 _-]+)"[^>]*style="[^"]*\b(?:width|height)\s*:/gi)) {
    for (const c of m[1].trim().split(/\s+/)) sized.add(c);
  }
  ok(sized.size > 0, 'found at least one inline-sized span to check');

  const problems = [];
  for (const cls of sized) {
    // Either the class itself is blockified, or its parent makes it a
    // flex/grid item. We only assert the simple, checkable case.
    const rule = new RegExp(`\\.[a-z-]*\\s*\\.?${cls}\\s*\\{[^}]*display\\s*:\\s*(block|flex|grid|inline-block|inline-flex)`, 'i');
    if (!rule.test(style)) problems.push(cls);
  }
  eq(problems, [], 'an inline-sized span needs a display that honours width/height');
});

test('the superlatives bars produce a non-zero fill width', () => {
  const html = B.generate();
  const m = /const bars = \(obj, fmt\) => \{[\s\S]*?\n  \};/.exec(html);
  ok(m, 'located the bars helper');
  // Rebuild the fill-width expression and check it never yields 0%, so a
  // category with a single entry still shows a sliver rather than nothing.
  const widthFor = (n, max) => Math.max(2, (n / max) * 100).toFixed(1);
  eq(widthFor(1, 151), '2.0', 'the smallest bar stays visible');
  eq(widthFor(151, 151), '100.0', 'the largest bar fills the track');
  ok(html.includes('Math.max(2, n / max * 100)'), 'the generated page uses the clamped width');
});

test('every category has a chart label that reads on its own', () => {
  // Deriving the chart label from the first word turned "Pure oddity" into
  // "Pure", which means nothing.
  const html = B.generate();
  const m = /const CATS = \{([\s\S]*?)\n\};/.exec(html);
  ok(m, 'located the category table');
  const shorts = [...m[1].matchAll(/short:\s*'([^']+)'/g)].map((x) => x[1]);
  const labels = [...m[1].matchAll(/label:\s*'([^']+)'/g)].map((x) => x[1]);
  eq(shorts.length, labels.length, 'every category needs a short chart label');
  const vague = shorts.filter((s) => /^(pure|the|a)$/i.test(s.trim()));
  eq(vague, [], 'a chart label must stand alone');
  for (const s of shorts) ok(s.length <= 10, `"${s}" is too long for the label column`);
});
