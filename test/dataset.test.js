'use strict';
/**
 * Validates the built dataset: schema, coordinate sanity, dedup, and the
 * specific data-quality regressions we have already fixed once.
 */

const fs = require('fs');
const path = require('path');
const { test, eq, ok } = require('./run');
const { STATE_BBOX, AU_BBOX, STATE_NAMES } = require('../src/build');
const N = require('../src/normalise');

const DATASET = path.join(__dirname, '..', 'data', 'bigthings.json');
if (!fs.existsSync(DATASET)) {
  throw new Error('data/bigthings.json is missing — run `npm run build` before `npm test`');
}
const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const things = dataset.things;

const CATEGORIES = new Set(['fruit-and-veg', 'fauna', 'seafood', 'food-and-drink', 'machinery-and-transport', 'tools-and-industry', 'sport-and-leisure', 'people-and-culture', 'oddity', 'sculpture']);
const STATUSES = new Set(['standing', 'demolished', 'removed', 'relocated', 'replaced']);
const PRECISIONS = new Set(['exact-article', 'exact-wikivoyage', 'exact-osm', 'exact-inline', 'exact-verified', 'town', 'none']);
const REQUIRED = ['id', 'name', 'state', 'stateName', 'category', 'status', 'precision', 'era', 'sources'];

test('dataset is non-trivial', () => {
  ok(things.length > 300, `expected 300+ things, got ${things.length}`);
});

test('every record has the required fields', () => {
  const bad = things.filter((t) => REQUIRED.some((f) => t[f] === undefined || t[f] === null));
  eq(bad.map((t) => t.name), [], 'records missing required fields');
});

test('ids are unique', () => {
  const seen = new Map();
  const dupes = [];
  for (const t of things) {
    if (seen.has(t.id)) dupes.push(`${t.name} (${t.state}) collides with ${seen.get(t.id)}`);
    seen.set(t.id, `${t.name} (${t.state})`);
  }
  eq(dupes, []);
});

test('no duplicate name+location within a state', () => {
  const seen = new Set();
  const dupes = [];
  for (const t of things) {
    const k = `${t.state}|${N.slugName(t.name)}|${N.slugPlace(t.location || '')}`;
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  eq(dupes, []);
});

test('categories, statuses and precisions are all from the known sets', () => {
  eq(things.filter((t) => !CATEGORIES.has(t.category)).map((t) => t.category), []);
  eq(things.filter((t) => !STATUSES.has(t.status)).map((t) => t.status), []);
  eq(things.filter((t) => !PRECISIONS.has(t.precision)).map((t) => t.precision), []);
});

test('state codes and full names agree', () => {
  const bad = things.filter((t) => STATE_NAMES[t.state] !== t.stateName);
  eq(bad.map((t) => `${t.name}: ${t.state} vs ${t.stateName}`), []);
});

test('every coordinate sits inside Australia', () => {
  const bad = things.filter((t) => t.lat != null && !(t.lat >= AU_BBOX[0] && t.lat <= AU_BBOX[2] && t.lng >= AU_BBOX[1] && t.lng <= AU_BBOX[3]));
  eq(bad.map((t) => `${t.name} @ ${t.lat},${t.lng}`), []);
});

test('every coordinate sits inside its own state', () => {
  const bad = things.filter((t) => {
    if (t.lat == null) return false;
    const b = STATE_BBOX[t.state];
    return !b || !(t.lat >= b[0] && t.lat <= b[2] && t.lng >= b[1] && t.lng <= b[3]);
  });
  eq(bad.map((t) => `${t.name} (${t.state}) @ ${t.lat},${t.lng}`), []);
});

test('a coordinate implies a precision better than "none", and vice versa', () => {
  eq(things.filter((t) => t.lat != null && t.precision === 'none').map((t) => t.name), [], 'placed but precision none');
  eq(things.filter((t) => t.lat == null && t.precision !== 'none').map((t) => t.name), [], 'unplaced but precision set');
});

test('every record carries at least one source', () => {
  const bad = things.filter((t) => !Array.isArray(t.sources) || t.sources.length === 0);
  eq(bad.map((t) => t.name), []);
});

test('every non-town coordinate cites where it came from', () => {
  const bad = things.filter((t) => t.precision.startsWith('exact') && !t.coordSource);
  eq(bad.map((t) => t.name), []);
});

test('years are plausible', () => {
  const now = new Date().getFullYear();
  const bad = things.filter((t) => t.builtYear != null && (t.builtYear < 1850 || t.builtYear > now));
  eq(bad.map((t) => `${t.name}: ${t.builtYear}`), []);
});

test('sizes are positive and sane', () => {
  const bad = things.filter((t) => t.sizeMaxM != null && (!(t.sizeMaxM > 0) || t.sizeMaxM > 400));
  eq(bad.map((t) => `${t.name}: ${t.sizeMaxM}`), []);
});

test('a height is only claimed when the source supports it', () => {
  const bad = things.filter((t) => t.heightM != null && t.sizeKind === 'dimensions');
  eq(bad.map((t) => t.name), [], 'ambiguous dimensions must not become a height');
});

test('non-standing records keep their evidence or a curated correction', () => {
  const bad = things.filter((t) => t.status !== 'standing' && !t.statusEvidence && !t.correction);
  eq(bad.map((t) => `${t.name} (${t.status})`), []);
});

test('meta stats match the actual rows', () => {
  const s = dataset.meta.stats;
  eq(s.total, things.length);
  eq(s.mapped, things.filter((t) => t.lat != null).length);
  const byState = {};
  for (const t of things) byState[t.state] = (byState[t.state] || 0) + 1;
  eq(s.byState, byState);
});

/* ---------- regressions we have already paid for once ---------- */

test('the Woombye Big Pineapple is standing, not demolished', () => {
  const p = things.find((t) => t.name === 'The Big Pineapple' && t.state === 'QLD');
  ok(p, 'Woombye pineapple present');
  eq(p.status, 'standing', 'a dismantled water tower in Hawaii is not our pineapple');
});

test('the Gympie Big Pineapple is still correctly demolished', () => {
  const p = things.find((t) => t.name === 'Big Pineapple' && t.location === 'Gympie');
  ok(p, 'Gympie pineapple present');
  eq(p.status, 'demolished');
});

test('every era matches its builtYear', () => {
  // applyOverrides() sets fields directly; era is derived from builtYear, not
  // stored independently, so a correction that sets builtYear without also
  // setting era used to leave era stuck at whatever it was computed as when
  // the row was first built — "unknown", for a discovered/added record with
  // no year at harvest time. Invisible in the data, but silently breaks the
  // era filter (a thing built in 2015 stopped showing under "modern 2015+").
  const wrong = things.filter((t) => t.builtYear && t.era !== N.era(t.builtYear))
    .map((t) => `${t.name}: builtYear ${t.builtYear} but era "${t.era}"`);
  eq(wrong, []);
});

test('the Big Triceratops is in Queensland, at Ballandean', () => {
  const t = things.find((x) => x.name === 'Big Triceratops');
  ok(t, 'triceratops present');
  eq(t.state, 'QLD');
  eq(t.location, 'Ballandean');
});

test('the Giant Worm is not 250 metres tall', () => {
  const w = things.find((t) => t.name === 'The Giant Worm');
  ok(w, 'worm present');
  eq(w.heightM, null);
  eq(w.sizeMaxM, 250);
  eq(w.status, 'demolished');
});

test('Larry the Lobster is at Kingston SE', () => {
  const l = things.find((t) => t.name === 'The Big Lobster' && t.state === 'SA');
  eq(l.location, 'Kingston SE');
  eq(l.builtYear, 1979);
});

test('the Ballina Big Prawn survived its demolition vote', () => {
  const p = things.find((t) => t.name === 'The Big Prawn' && t.state === 'NSW');
  eq(p.status, 'standing', 'refurbished in situ by Bunnings, not replaced');
});

test('the Big Banana is placed precisely and dated 1964', () => {
  const b = things.find((t) => t.name === 'Big Banana' && t.state === 'NSW');
  eq(b.builtYear, 1964);
  ok(b.precision.startsWith('exact'), `expected an exact pin, got ${b.precision}`);
  ok(Math.abs(b.lat + 30.27) < 0.1 && Math.abs(b.lng - 153.13) < 0.1, `Coffs Harbour-ish, got ${b.lat},${b.lng}`);
});

test('curated corrections and additions all carry a reason', () => {
  const bad = things.filter((t) => t.correction && !t.correction.why);
  eq(bad.map((t) => t.name), []);
});
