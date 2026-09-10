'use strict';
/**
 * The About/landing page. Its whole purpose is to describe the dataset, so the
 * risk is not that it breaks — it is that it drifts, and quietly starts
 * describing a dataset that no longer exists. Every figure on it is therefore
 * generated, and these tests assert the generated figures match the data.
 */

const fs = require('fs');
const path = require('path');
const { test, eq, ok } = require('./run');
const A = require('../src/build-about');

const ROOT = path.join(__dirname, '..');
const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
const stats = dataset.meta.stats;
const creditsPath = path.join(ROOT, 'data', 'image-credits.json');
const credits = fs.existsSync(creditsPath) ? JSON.parse(fs.readFileSync(creditsPath, 'utf8')).images : {};

const html = A.generate();

/* ---------- nothing left unfilled ---------- */

test('the about page fills every placeholder', () => {
  eq(html.match(/__[A-Z_]+__/g), null, 'unfilled placeholder');
});

/* ---------- the figures are the dataset's, not hand-typed ---------- */

test('the headline figures match the dataset', () => {
  const figs = [...html.matchAll(/<div class="fig"><b>([\d,]+)<\/b><span>([^<]+)<\/span>/g)]
    .map((m) => [m[2], Number(m[1].replace(/,/g, ''))]);
  const byLabel = Object.fromEntries(figs);
  eq(byLabel.mapped, stats.total);
  eq(byLabel.pinpointed, stats.exact);
  eq(byLabel['town-level'], stats.byPrecision.town || 0);
  eq(byLabel.lost, (stats.byStatus.demolished || 0) + (stats.byStatus.removed || 0));
  eq(byLabel['claimed to exist'], dataset.meta.claimedNationalTotal);
});

test('the precision table adds up to the dataset total', () => {
  const rows = [...html.matchAll(/<tr(?: class="total")?><td>(?:[\s\S]*?)<\/td><td class="num">(\d+)<\/td><\/tr>/g)]
    .map((m) => Number(m[1]));
  ok(rows.length >= 3, `expected several precision rows, got ${rows.length}`);
  const total = rows.pop(); // the last row is the explicit total
  eq(total, stats.total);
  eq(rows.reduce((a, b) => a + b, 0), stats.total, 'the tiers must sum to the total');
});

test('every precision tier present in the data is explained in words', () => {
  const explained = new Set(A.PRECISION_COPY.map(([k]) => k));
  const missing = Object.keys(stats.byPrecision).filter((k) => !explained.has(k));
  eq(missing, [], 'a tier with no human explanation would appear as a bare count');
});

test('the state and category bars match the dataset counts', () => {
  // Titles are HTML-escaped, so "Fruit & veg" arrives as "Fruit &amp; veg".
  const unesc = (x) => x.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const bars = [...html.matchAll(/<div class="bar" title="([^"]+): (\d+)"/g)]
    .map((m) => [unesc(m[1]), Number(m[2])]);
  eq(bars.length, Object.keys(stats.byState).length + Object.keys(stats.byCategory).length);
  for (const [state, n] of Object.entries(stats.byState)) {
    const hit = bars.find(([l]) => l === state);
    ok(hit, `${state} has a bar`);
    eq(hit[1], n);
  }
  for (const [cat, n] of Object.entries(stats.byCategory)) {
    const label = A.CATEGORY_LABEL[cat];
    ok(label, `${cat} has a chart label`);
    const hit = bars.find(([l]) => l === label);
    ok(hit, `${cat} has a bar`);
    eq(hit[1], n);
  }
});

test('the bar fills are blocks with a visible minimum width', () => {
  // Same trap as the map's Superlatives: an inline span ignores width.
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/\.bar \.f\{[^}]*display:block/.test(style), 'the fill must be blockified');
  const widths = [...html.matchAll(/class="f" style="width:([\d.]+)%"/g)].map((m) => Number(m[1]));
  ok(widths.length > 10, 'found the fills');
  ok(widths.every((w) => w >= 2), 'no fill collapses to nothing');
  ok(widths.some((w) => w === 100), 'the largest bar fills its track');
});

test('the superlatives quoted in prose are the real extremes', () => {
  const withYear = dataset.things.filter((t) => t.builtYear);
  const oldest = [...withYear].sort((a, b) => a.builtYear - b.builtYear)[0];
  const biggest = [...dataset.things].filter((t) => t.sizeMaxM).sort((a, b) => b.sizeMaxM - a.sizeMaxM)[0];
  ok(html.includes(oldest.name), `names the oldest (${oldest.name})`);
  ok(html.includes(String(oldest.builtYear)), 'gives its year');
  ok(html.includes(biggest.name), `names the biggest (${biggest.name})`);
  ok(html.includes(`${biggest.sizeMaxM} m`), 'gives its size');
});

/* ---------- corrections are quoted from the overrides, with sources ---------- */

test('the corrections shown are real, sourced overrides', () => {
  const curated = dataset.things.filter((t) => t.correction && t.correction.why && !t.addedManually);
  ok(curated.length >= 5, `expected several curated corrections, got ${curated.length}`);
  const cards = [...html.matchAll(/<div class="fix"><h4>([^<]+)/g)].map((m) => m[1].trim());
  ok(cards.length >= 3, 'correction cards rendered');
  for (const name of cards) {
    ok(curated.some((t) => t.name === name), `"${name}" is a real corrected record`);
  }
  // Each card carries a source link.
  const fixBlock = html.slice(html.indexOf('class="fixes"'), html.indexOf('</section>', html.indexOf('class="fixes"')));
  eq((fixBlock.match(/class="fix"/g) || []).length, (fixBlock.match(/class="src"/g) || []).length,
    'every correction card needs its source');
});

/* ---------- photos are credited ---------- */

test('every photo in the strip names its photographer and licence', () => {
  const shots = [...html.matchAll(/<figure class="shot">([\s\S]*?)<\/figure>/g)].map((m) => m[1]);
  ok(shots.length >= 4, `expected a photo strip, got ${shots.length}`);
  for (const s of shots) {
    ok(/Photo: /.test(s), 'photographer is named');
    // A Commons photo must link the photographer to its file page; a custom
    // one (see docs/ADMIN.md) has no such page and must not claim one.
    const isCustom = /src="img\/custom\//.test(s);
    if (isCustom) {
      ok(!/commons\.wikimedia\.org|en\.wikipedia\.org/.test(s), 'a custom photo must not claim a Commons/Wikipedia source');
    } else {
      ok(/Photo: <a href="http/.test(s), 'photographer is named and linked');
      ok(/commons\.wikimedia\.org|en\.wikipedia\.org/.test(s), 'links to the file page');
    }
    ok(/alt="[^"]+"/.test(s), 'has alt text');
  }
});

test('the strip only picks big things whose photo is actually vendored', () => {
  const picked = A.pickStrip(dataset.things);
  ok(picked.length >= 4, 'picked enough');
  for (const t of picked) {
    ok(t.image, `${t.name} has a photo`);
    ok(credits[t.image], `${t.name}'s photo is in the credit manifest`);
  }
});

/* ---------- self-hosted, not hotlinked ---------- */

test('the about page loads no external image or stylesheet', () => {
  const loaded = [];
  const stripped = html.replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const m of stripped.matchAll(/<img[^>]+src\s*=\s*"([^"]+)"/gi)) loaded.push(m[1]);
  for (const m of stripped.matchAll(/<link[^>]+rel\s*=\s*"stylesheet"[^>]*>/gi)) {
    const href = /href\s*=\s*"([^"]+)"/i.exec(m[0]);
    if (href) loaded.push(href[1]);
  }
  const external = loaded.filter((u) => /^(https?:)?\/\//.test(u));
  eq(external, [], 'the landing page must not fetch a photo or stylesheet from anywhere else');
  const missing = loaded.filter((u) => !fs.existsSync(path.join(ROOT, 'web', u.split('?')[0])));
  eq(missing, [], 'every local asset must exist');
});

test('the about page points at the map and real download URLs', () => {
  ok(html.includes('href="index.html"'), 'links to the map');
  const grab = html.slice(html.indexOf('class="grab"'));
  const links = [...grab.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
  ok(links.length >= 3, `expected download links, got ${links.length}`);
  ok(links.every((u) => /^https:/.test(u)), 'downloads are https');
});

/* ---------- the map links back ---------- */

test('the map links to the about page', () => {
  const B = require('../src/build-web');
  ok(B.generate().includes('href="about.html"'), 'map links to about.html');
});

/* ---------- prose accuracy ---------- */

test('the page states the Australia/Canada split correctly', () => {
  ok(html.includes('1,250'), 'gives the Canadian count');
  ok(/1,075<\/strong> in Australia|<strong>1,075 in Australia/.test(html.replace(/\s+/g, ' ')),
    'attributes 1,075 to Australia specifically');
  ok(html.includes('10.1080/14443058.2022.2144928'), 'cites the paper by DOI');
});

test('the page does not overclaim completeness', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ok(/census/.test(text), 'explains the claimed figure is a census');
  ok(!/every big thing in Australia|complete list of/i.test(text), 'makes no completeness claim');
});

test('no section leaves text against the viewport edge', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/\.wrap\{[^}]*padding:0 24px/.test(style), 'the main column has a gutter');
  ok(/\.wide\{[^}]*padding:0 24px/.test(style), 'the wide column has a gutter');
  ok(/@media \(max-width:600px\)[\s\S]*?padding:0 18px/.test(style), 'and keeps one on a phone');
});

test('the photo tiles are not eaten by default figure margins', () => {
  // <figure> ships with a UA margin of 1em 40px. Inside a 170px grid track
  // that leaves 90px, which shrank every photo to a third of its size and
  // looked like a deliberate (bad) design choice rather than a bug.
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/(^|[,{\s])figure[,{][^}]*margin:0|figure,figcaption[^{]*\{[^}]*margin:0/.test(style),
    'figure margins must be reset');
});

test('the sticky bar does not crowd the wordmark on a phone', () => {
  // At 390px the wordmark, an anchor link and the map button do not coexist:
  // the mark wrapped onto a second line and the buttons overlapped it.
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/\.topbar \.mark\{[^}]*white-space:nowrap/.test(style), 'the wordmark must not wrap');
  ok(/\.topbar \.mark\{[^}]*text-overflow:ellipsis/.test(style), 'and should truncate rather than overlap');
  const mq = style.slice(style.indexOf('@media (max-width:600px)'));
  ok(/\.topbar \.btn\.secondary\{display:none\}/.test(mq), 'the secondary button steps aside on a phone');
  ok(html.includes('class="btn secondary"'), 'the anchor link is marked as secondary');
});

test('anchor targets clear the sticky bar', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/section\{[^}]*scroll-margin-top:\d+px/.test(style), 'jumping to a section must not hide its heading');
});
