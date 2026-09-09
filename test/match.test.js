'use strict';
/**
 * The OSM proximity matcher. These tests exist because the matcher is the one
 * place in the pipeline that can invent a confidently-wrong coordinate, and a
 * wrong pin is worse than an honest town pin.
 */

const { test, eq, ok } = require('./run');
const M = require('../src/match-osm');

let seq = 0;
const art = (name, lat, lng) => ({ name, lat, lng, osmId: `node/${++seq}`, artwork: 'sculpture', tourism: 'artwork' });
const poi = (name, lat, lng) => ({ name, lat, lng, osmId: `node/${++seq}`, tourism: 'attraction' });

// Roughly 1 km per 0.009° of latitude.
const km = (n) => n * 0.009;

/* ---------- tokenising ---------- */

test('core tokens drop size words and articles', () => {
  eq([...M.coreTokens('The Big Banana')], ['banana']);
  eq([...M.coreTokens("World's Biggest Tennis Racquet")], ['tennis', 'racquet']);
  eq([...M.coreTokens('Giant Koala')], ['koala']);
});

test('singularises so plurals match', () => {
  eq(M.singular('bananas'), 'banana');
  eq(M.singular('bales'), 'bale');
  eq(M.singular('cherries'), 'cherry');
  eq(M.singular('glass'), 'glass', 'double-s words are left alone');
  eq(M.singular('tennis'), 'tennis', '-is is not a plural');
  eq(M.singular('cactus'), 'cactus', '-us is not a plural');
  eq(M.singular('thongs'), 'thong');
  eq(M.singular('koalas'), 'koala', 'plurals of -a nouns must still singularise');
  eq(M.singular('bales'), 'bale');
});

test('"Big Wool Bales" and "Wool Bale" share core tokens', () => {
  const a = M.coreTokens('Big Wool Bales');
  const b = M.coreTokens('The Wool Bale');
  eq(M.jaccard(a, b), 1);
});

/* ---------- accepting good matches ---------- */

test('accepts an exact core-name match nearby', () => {
  const r = { name: 'The Big Banana', state: 'NSW', lat: -30.27, lng: 153.13 };
  const m = M.bestMatch(r, [art('Big Banana', -30.27 + km(0.4), 153.13)]);
  ok(m && !m.ambiguous, 'matched');
  eq(m.kind, 'name-exact');
  eq(m.confidence, 'high');
});

test('accepts when OSM adds detail to a multi-token name', () => {
  const r = { name: 'Big Tennis Racquet', state: 'NSW', lat: -34.28, lng: 146.57 };
  const m = M.bestMatch(r, [poi('Evonne Goolagong Big Tennis Racquet', -34.28 + km(0.5), 146.57)]);
  ok(m && !m.ambiguous, 'matched');
  eq(m.kind, 'name-superset');
});

test('accepts a single-token name only when it is an artwork and very close', () => {
  const r = { name: 'The Big Kangaroo', state: 'SA', lat: -31.63, lng: 129.0 };
  const near = M.bestMatch(r, [art('The Big Kangaroo - Rooey II', -31.63 + km(0.4), 129.0)]);
  ok(near && near.kind === 'name-artwork', `expected name-artwork, got ${near && near.kind}`);
  // "souvenirs" is not a venue word, so the extra tokens are not purely venue
  // noise and the single-token core is not enough to accept it.
  const plain = M.bestMatch(r, [poi('Kangaroo Cafe and Souvenirs', -31.63 + km(0.4), 129.0)]);
  eq(plain, null, 'a POI whose extra tokens are not purely venue words is refused');
});

test('accepts the venue when only venue words differ and it is within 2 km', () => {
  const r = { name: 'Big Kronosaurus', state: 'QLD', lat: -20.73, lng: 143.14 };
  const m = M.bestMatch(r, [art('Kronosaurus Korner Museum', -20.73 + km(0.2), 143.14)]);
  ok(m, 'matched');
  ok(m.kind === 'venue' || m.kind === 'name-artwork', `got ${m.kind}`);
});

/* ---------- refusing bad matches ---------- */

test('refuses a name match that is too far away', () => {
  const r = { name: 'The Big Platypus', state: 'TAS', lat: -41.23, lng: 146.4 };
  // 29 km away: this is the real Latrobe/Giant Platypus false positive that a
  // 30 km band accepted before the radius was tightened.
  eq(M.bestMatch(r, [art('Giant Platypus', -41.23 + km(29), 146.4)]), null);
});

test('refuses an unrelated nearby artwork', () => {
  const r = { name: 'The Big Potato', state: 'NSW', lat: -34.59, lng: 150.58 };
  eq(M.bestMatch(r, [art('Reconciliation Sculpture', -34.59 + km(0.3), 150.58)]), null);
});

test('refuses a single extra non-venue token on a one-token name', () => {
  const r = { name: 'Big Cow', state: 'QLD', lat: -26.62, lng: 152.95 };
  const m = M.bestMatch(r, [poi('Cow Shed Antiques', -26.62 + km(1.0), 152.95)]);
  // "shed" and "antiques" are not venue words, and the core is a single token.
  eq(m, null);
});

test('refuses when the name is ambiguous between two distinct candidates', () => {
  const r = { name: 'Big Apple', state: 'QLD', lat: -28.6, lng: 151.9 };
  const m = M.bestMatch(r, [
    art('Big Apple', -28.6 + km(1), 151.9),
    art('Big Apple', -28.6 + km(4), 151.9),
  ]);
  ok(m && m.ambiguous, 'two equally good candidates must be refused, not guessed');
  eq(m.candidates.length, 2);
});

test('two candidates at essentially the same spot are not ambiguous', () => {
  const r = { name: 'Big Apple', state: 'QLD', lat: -28.6, lng: 151.9 };
  const m = M.bestMatch(r, [
    art('Big Apple', -28.6 + km(1), 151.9),
    art('Big Apple', -28.6 + km(1.05), 151.9),
  ]);
  ok(m && !m.ambiguous, 'duplicate mappings of one object should still match');
});

test('refuses a record with no town point to measure from', () => {
  eq(M.bestMatch({ name: 'Big Thing', state: 'NSW', lat: null, lng: null }, [art('Big Thing', -33, 151)]), null);
});

test('refuses a candidate with an empty name', () => {
  const r = { name: 'Big Banana', state: 'NSW', lat: -30.27, lng: 153.13 };
  eq(M.bestMatch(r, [art('The', -30.27, 153.13)]), null);
});

/* ---------- geometry ---------- */

test('haversine agrees with the query engine on a known distance', () => {
  const Q = require('../src/query');
  const a = M.haversineKm(-33.8688, 151.2093, -37.8136, 144.9631);
  const b = Q.haversineKm({ lat: -33.8688, lng: 151.2093 }, { lat: -37.8136, lng: 144.9631 });
  ok(Math.abs(a - b) < 0.001, `matcher ${a} vs query engine ${b}`);
});

/* ---------- the audited output, as actually applied ---------- */

test('every applied OSM match is close to the town it replaced', () => {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'cache', 'osm-matches.json');
  if (!fs.existsSync(p)) return; // matcher has not been run in this checkout
  const { matches } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const far = Object.values(matches).filter((m) => m.km > 12);
  eq(far.map((m) => `${m.name} (${m.km} km)`), [], 'no applied match may exceed the 12 km band');
});

test('every applied OSM match carries a source and a reason', () => {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'cache', 'osm-matches.json');
  if (!fs.existsSync(p)) return;
  const { matches } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bad = Object.values(matches).filter((m) => !m.source || !m.why || !m.osmId);
  eq(bad.map((m) => m.name), []);
});

/* ---------- place-name candidate ordering ---------- */

test('road-derived place names are tried last', () => {
  const { placeCandidates } = require('../src/fetch-places');
  // "Forrest Highway" would otherwise resolve to Forrest, WA — a Nullarbor
  // locality 1,200 km from the Forrest Highway. Bunbury must be tried first.
  const wa = placeCandidates('Forrest Highway, just north of Bunbury', 'WA');
  ok(wa.indexOf('Bunbury, Western Australia') < wa.indexOf('Forrest, Western Australia'),
    `Bunbury must precede Forrest, got ${JSON.stringify(wa)}`);

  const sa = placeCandidates('Port Wakefield Road, Lower Light', 'SA');
  ok(sa.indexOf('Lower Light, South Australia') < sa.indexOf('Port Wakefield, South Australia'),
    `Lower Light must precede Port Wakefield, got ${JSON.stringify(sa)}`);

  // A plain street address should still surface its suburb first.
  const vic = placeCandidates('45 Campbell Street, Rutherglen', 'VIC');
  eq(vic[0], 'Rutherglen, Victoria');
});

test('Fergus the Bull is near Bunbury, not on the Nullarbor', () => {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'data', 'bigthings.json');
  if (!fs.existsSync(p)) return; // dataset not built yet in this checkout
  const dataset = JSON.parse(fs.readFileSync(p, 'utf8'));
  const f = dataset.things.find((t) => t.name === 'Fergus the Bull');
  ok(f, 'Fergus present');
  ok(M.haversineKm(f.lat, f.lng, -33.327, 115.637) < 30,
    `expected within 30 km of Bunbury, got ${f.lat},${f.lng}`);
});
