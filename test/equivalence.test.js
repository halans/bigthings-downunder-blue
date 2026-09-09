'use strict';
/**
 * Cross-surface equivalence. The map and the CLI are two front ends over one
 * query definition; this suite extracts the app's own `matches()` out of the
 * generated HTML, runs it against src/query.js for the same filter sets, and
 * diffs the resulting id lists. A divergence fails here instead of quietly
 * shipping a map that disagrees with the terminal.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, eq, ok } = require('./run');
const Q = require('../src/query');
const { generate, slim, FIELDS } = require('../src/build-web');

const ROOT = path.join(__dirname, '..');
const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));

/** Run the generated page's filter logic in a sandbox, without a DOM. */
function loadAppMatcher() {
  const html = generate();
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  // Take only the declarations the matcher needs: everything up to `matches`
  // plus the function itself. The rest touches the DOM and Leaflet.
  const start = script.indexOf('const DATA =');
  const catsEnd = script.indexOf('/* ---------------- state ---------------- */');
  const mStart = script.indexOf('function matches(t)');
  const mEnd = script.indexOf('let visible = [];');
  ok(start >= 0 && catsEnd > start && mStart > 0 && mEnd > mStart, 'could not locate the matcher in the generated page');

  const src = script.slice(start, catsEnd)
    + '\nconst F = { q:"", states:new Set(), cats:new Set(), eras:new Set(), hideGone:false, exactOnly:false };\n'
    + script.slice(mStart, mEnd)
    + '\nmodule.exports = { matches, F, THINGS, CATS };';
  const sandbox = { module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'generated-app.js' });
  return sandbox.module.exports;
}

const app = loadAppMatcher();

/** The filter permutations both surfaces must agree on. */
const CASES = [
  { name: 'no filters', f: {} },
  { name: 'free text: prawn', f: { q: 'prawn' } },
  { name: 'free text: coffs', f: { q: 'coffs' } },
  { name: 'free text: mixed case', f: { q: 'BiG BaNaNa' } },
  { name: 'free text with no hits', f: { q: 'zzzznotathing' } },
  { name: 'one state', f: { states: ['QLD'] } },
  { name: 'two states', f: { states: ['TAS', 'NT'] } },
  { name: 'one category', f: { cats: ['seafood'] } },
  { name: 'two categories', f: { cats: ['fauna', 'fruit-and-veg'] } },
  { name: 'one era', f: { eras: ['pioneer (pre-1970)'] } },
  { name: 'hide the dead', f: { hideGone: true } },
  { name: 'exact pins only', f: { exactOnly: true } },
  { name: 'state + category', f: { states: ['NSW'], cats: ['seafood'] } },
  { name: 'state + category + era', f: { states: ['VIC'], cats: ['fauna'], eras: ['unknown'] } },
  { name: 'state + category + era with no hits', f: { states: ['TAS'], cats: ['machinery-and-transport'], eras: ['pioneer (pre-1970)'] } },
  { name: 'everything at once', f: { q: 'big', states: ['QLD', 'NSW'], cats: ['fruit-and-veg'], eras: ['revival (2000s–2014)'], hideGone: true, exactOnly: true } },
];

for (const c of CASES) {
  test(`map and CLI agree — ${c.name}`, () => {
    Object.assign(app.F, {
      q: c.f.q || '',
      states: new Set(c.f.states || []),
      cats: new Set(c.f.cats || []),
      eras: new Set(c.f.eras || []),
      hideGone: !!c.f.hideGone,
      exactOnly: !!c.f.exactOnly,
    });
    const fromApp = app.THINGS.filter((t) => app.matches(t)).map((t) => t.id).sort();
    const fromLib = Q.query(dataset.things, { ...c.f, limit: 0 }).map((t) => t.id).sort();
    eq(fromApp, fromLib, `${c.name}: app matched ${fromApp.length}, library matched ${fromLib.length}`);
    if (!c.name.includes('no hits')) ok(fromApp.length > 0, `${c.name} produced no results`);
  });
}

test('the app payload carries every field the app reads', () => {
  const s = slim(dataset);
  const banana = s.things.find((t) => t.name === 'Big Banana');
  for (const f of ['id', 'name', 'state', 'lat', 'lng', 'precision', 'category', 'status', 'era', 'sources']) {
    ok(banana[f] !== undefined, `payload missing ${f}`);
  }
  const stray = Object.keys(banana).filter((k) => !FIELDS.includes(k));
  eq(stray, [], 'payload contains fields the app does not declare');
});

test('the app sees the same number of things as the dataset', () => {
  eq(app.THINGS.length, dataset.things.length);
});

test('the app category table covers every category in the data', () => {
  const missing = [...new Set(dataset.things.map((t) => t.category))].filter((c) => !app.CATS[c]);
  eq(missing, [], 'categories with no colour/emoji in the app');
});

test('the app category labels match the library labels', () => {
  for (const [key, val] of Object.entries(app.CATS)) {
    eq(val.label, Q.CATEGORY_LABELS[key], `label drift for ${key}`);
  }
});

test('the generated page has no unsubstituted placeholder', () => {
  ok(!generate().includes('__DATA__'), 'template placeholder still present');
});

/* ---------- query engine behaviour ---------- */

test('distance search finds close things and excludes far ones', () => {
  const sydney = { lat: -33.87, lng: 151.21 };
  const near = Q.query(dataset.things, { near: sydney, within: 100, limit: 0 });
  ok(near.length > 0, 'something is near Sydney');
  ok(near.every((t) => t._km <= 100), 'nothing beyond the radius');
  for (let i = 1; i < near.length; i++) ok(near[i]._km >= near[i - 1]._km, 'sorted by distance');
  const perth = Q.query(dataset.things, { near: { lat: -31.95, lng: 115.86 }, within: 50, limit: 0 });
  eq(perth.some((t) => t.state !== 'WA'), false, 'a 50 km Perth radius stays in WA');
});

test('haversine matches a known distance', () => {
  const km = Q.haversineKm({ lat: -33.8688, lng: 151.2093 }, { lat: -37.8136, lng: 144.9631 });
  ok(Math.abs(km - 713) < 15, `Sydney–Melbourne ≈713 km, got ${km.toFixed(0)}`);
});

test('era aliases resolve', () => {
  const a = Q.query(dataset.things, { eras: ['pioneer'], limit: 0 });
  const b = Q.query(dataset.things, { eras: ['pioneer (pre-1970)'], limit: 0 });
  eq(a.map((t) => t.id), b.map((t) => t.id));
});

test('limit caps results without changing order', () => {
  const all = Q.query(dataset.things, { limit: 0 });
  const five = Q.query(dataset.things, { limit: 5 });
  eq(five.map((t) => t.id), all.slice(0, 5).map((t) => t.id));
});

test('sorts behave', () => {
  const byYear = Q.query(dataset.things, { sort: 'year', limit: 0 }).filter((t) => t.builtYear);
  for (let i = 1; i < byYear.length; i++) ok(byYear[i].builtYear >= byYear[i - 1].builtYear, 'year ascending');
  const bySize = Q.query(dataset.things, { sort: 'size', limit: 0 }).filter((t) => t.sizeMaxM);
  for (let i = 1; i < bySize.length; i++) ok(bySize[i].sizeMaxM <= bySize[i - 1].sizeMaxM, 'size descending');
});

test('goneOnly and hideGone are complements', () => {
  const gone = Q.query(dataset.things, { goneOnly: true, limit: 0 }).length;
  const alive = Q.query(dataset.things, { hideGone: true, limit: 0 }).length;
  eq(gone + alive, dataset.things.length);
});

/* ---------- CLI ---------- */

test('CLI parses flags', () => {
  const { parseArgs } = require('../src/cli');
  const o = parseArgs(['prawn', '-s', 'nsw', '--category', 'SEAFOOD', '--limit', '3', '--format', 'json']);
  eq(o.terms, ['prawn']);
  eq(o.states, ['NSW']);
  eq(o.cats, ['seafood']);
  eq(o.limit, 3);
  eq(o.format, 'json');
});

test('CLI rejects bad usage', () => {
  const { parseArgs, UsageError } = require('../src/cli');
  for (const argv of [['--bogus'], ['--limit'], ['--format', 'yaml'], ['--sort', 'colour'], ['--within', '50'], ['--near', 'here']]) {
    let threw = false;
    try { parseArgs(argv); } catch (e) { threw = e instanceof UsageError; }
    ok(threw, `expected a usage error for: ${argv.join(' ')}`);
  }
});

test('CLI renders every format without throwing', () => {
  const { render } = require('../src/cli');
  const rows = Q.query(dataset.things, { states: ['TAS'], limit: 3 });
  for (const format of ['table', 'json', 'csv', 'tsv', 'geojson']) {
    const out = render(rows, { format, sources: false }, dataset);
    ok(typeof out === 'string' && out.length > 0, `${format} produced nothing`);
    if (format === 'json' || format === 'geojson') JSON.parse(out);
  }
});

test('CSV output escapes commas and quotes', () => {
  const { render } = require('../src/cli');
  const tricky = [{ id: 'x', name: 'Big "Thing", Mk II', state: 'NSW', location: 'A, B', lat: -33, lng: 151, precision: 'town', builtYear: null, sizeRaw: null, category: 'oddity', status: 'standing' }];
  const csv = render(tricky, { format: 'csv' }, dataset);
  ok(csv.includes('"Big ""Thing"", Mk II"'), `quotes not escaped: ${csv}`);
  ok(csv.includes('"A, B"'), 'commas not quoted');
});

test('GeoJSON output is valid and only includes placed things', () => {
  const { render } = require('../src/cli');
  const gj = JSON.parse(render(Q.query(dataset.things, { limit: 0 }), { format: 'geojson' }, dataset));
  eq(gj.type, 'FeatureCollection');
  ok(gj.features.length > 300, 'features present');
  for (const f of gj.features) {
    eq(f.geometry.type, 'Point');
    eq(f.geometry.coordinates.length, 2);
    ok(Number.isFinite(f.geometry.coordinates[0]) && Number.isFinite(f.geometry.coordinates[1]), 'finite coords');
  }
});
