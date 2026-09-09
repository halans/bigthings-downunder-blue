'use strict';
/**
 * The discovery pipeline. Its whole job is deciding what NOT to let in, so
 * these tests are mostly about refusals — every one of them is a mistake the
 * pipeline actually made before the rule existed.
 */

const fs = require('fs');
const path = require('path');
const { test, eq, ok } = require('./run');
const D = require('../src/extract-discovery');
const F = require('../src/fetch-discovery');

/* ---------- scraping the facts out of a page ---------- */

test('pulls a coordinate out of a Google Maps embed', () => {
  const html = '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3311.6!2d151.19807931513557!3d-33.8988785!2m3"></iframe>';
  const c = F.coordsFromGoogleEmbed(html);
  ok(c, 'found');
  // The embed puts longitude first — swapping them lands the pin in the ocean.
  ok(Math.abs(c.lat + 33.8988) < 0.001, `lat ${c.lat}`);
  ok(Math.abs(c.lng - 151.198) < 0.001, `lng ${c.lng}`);
});

test('returns null when there is no embed', () => {
  eq(F.coordsFromGoogleEmbed('<p>no map here</p>'), null);
});

test('decodes numeric HTML entities in titles', () => {
  // "World&#x27;s Tallest Bin" failed every name test while still encoded.
  eq(F.decodeEntities('World&#x27;s Tallest Bin'), "World's Tallest Bin");
  eq(F.decodeEntities('Fish &amp; Chips'), 'Fish & Chips');
  eq(F.decodeEntities('Bob&#39;s Big Thing'), "Bob's Big Thing");
});

test('reads the catalogue taxonomy off a page', () => {
  const html = '<a href="/category/big-sea-creatures/">x</a><a href="/tag/big-things/">y</a><a href="/tag/roadside-attractions/">z</a>';
  const t = F.taxonomyFrom(html);
  eq(t.categories, ['big-sea-creatures']);
  ok(t.tags.includes('big-things'), 'tags captured');
});

/* ---------- parsing name and town out of a title ---------- */

test('splits "Name, Town, STATE"', () => {
  eq(D.splitTitle('The Big Cauliflower, Waterloo, NSW', 'NSW'), { name: 'The Big Cauliflower', town: 'Waterloo' });
});

test('splits "Name — Town, Full State Name"', () => {
  eq(D.splitTitle('Big Axe — Kew, New South Wales', 'NSW'), { name: 'Big Axe', town: 'Kew' });
});

test('survives a title with no town', () => {
  eq(D.splitTitle('Big Thing', 'VIC'), { name: 'Big Thing', town: null });
});

/* ---------- coordinate precision honesty ---------- */

test('counts the decimal places of the coarser axis', () => {
  eq(D.coordPrecisionDp({ lat: -31.63, lng: 152.72 }), 2);
  eq(D.coordPrecisionDp({ lat: -33.898879, lng: 151.198079 }), 6);
  eq(D.coordPrecisionDp({ lat: -33.898879, lng: 151.19 }), 2, 'the coarser axis governs');
});

/* ---------- refusing duplicates ---------- */

const rec = (name, state, town, lat, lng) => ({ name, state, town, location: town, lat, lng });

test('catches a duplicate hiding behind a parenthesised nickname', () => {
  // "Big Kangaroo (Matilda)" vs "Matilda The Kangaroo": slug normalisation
  // strips brackets, so the nickname vanished and it came through as new.
  const existing = [rec('Matilda The Kangaroo', 'QLD', 'Kybong', -26.341461, 152.730363)];
  const dup = D.findDuplicate({ name: 'Big Kangaroo (Matilda)', town: 'Traveston', state: 'QLD', coords: { lat: -26.32, lng: 152.78 } }, existing);
  ok(dup, 'matched as duplicate');
});

test('catches the same object across the NSW/ACT enclave border', () => {
  // The Belconnen owl is catalogued as NSW; we hold it as ACT. The ACT sits
  // inside the NSW bounding box, so only proximity can settle it.
  const existing = [rec('The Big Powerful Owl', 'ACT', 'Belconnen', -35.24759, 149.06752)];
  const dup = D.findDuplicate({ name: 'The Big Powerful Owl', town: 'Belconnen', state: 'NSW', coords: { lat: -35.2476, lng: 149.0631 } }, existing);
  ok(dup, 'matched across the border');
  ok(/border/.test(dup.why), `expected a border reason, got ${dup.why}`);
});

test('does NOT merge two different sculptures that merely sit close together', () => {
  const existing = [rec('The Big Hard Rock Guitar', 'QLD', 'Surfers Paradise', -27.9986, 153.4278)];
  const dup = D.findDuplicate({ name: 'The Big Octopus', town: 'Surfers Paradise', state: 'QLD', coords: { lat: -28.002007, lng: 153.427863 } }, existing);
  eq(dup, null, 'a guitar and an octopus are two big things, not one');
});

test('does NOT merge same-named big things in different towns', () => {
  const existing = [rec('The Big Stubby', 'QLD', 'Tewantin', -26.3916, 153.0386)];
  const dup = D.findDuplicate({ name: 'Big Stubby', town: 'Larrimah', state: 'NT', coords: { lat: -14.24, lng: 133.24 } }, existing);
  eq(dup, null, 'Larrimah and Tewantin each have their own Big Stubby');
});

test('catches an identical core name in the same state', () => {
  const existing = [rec('The Big Merino', 'NSW', 'Goulburn', -34.772586, 149.691463)];
  const dup = D.findDuplicate({ name: 'Big Merino', town: 'Goulburn', state: 'NSW', coords: { lat: -34.77, lng: 149.69 } }, existing);
  ok(dup, 'matched');
});

/* ---------- the audited output, as actually applied ---------- */

const DISCOVERED = path.join(__dirname, '..', 'data', 'discovered.json');

test('every discovered addition carries a source URL and a reason', () => {
  if (!fs.existsSync(DISCOVERED)) return;
  const { additions } = JSON.parse(fs.readFileSync(DISCOVERED, 'utf8'));
  const bad = additions.filter((a) => !a.source || !/^https?:\/\//.test(a.source) || !a.why || !a.sourceName);
  eq(bad.map((a) => a.name), []);
});

test('a low-precision discovered coordinate is labelled town-level', () => {
  if (!fs.existsSync(DISCOVERED)) return;
  const { additions } = JSON.parse(fs.readFileSync(DISCOVERED, 'utf8'));
  const lying = additions.filter((a) => a.precision !== 'town' && D.coordPrecisionDp({ lat: a.lat, lng: a.lng }) < 4);
  eq(lying.map((a) => `${a.name} @ ${a.lat},${a.lng} claims ${a.precision}`), [],
    'a kilometre-scale coordinate must not claim to be surveyed');
});

test('discovered additions do not collide with each other', () => {
  if (!fs.existsSync(DISCOVERED)) return;
  const { additions } = JSON.parse(fs.readFileSync(DISCOVERED, 'utf8'));
  const seen = new Set();
  const dupes = [];
  for (const a of additions) {
    const k = `${a.state}|${String(a.name).toLowerCase()}|${String(a.town || '').toLowerCase()}`;
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  eq(dupes, []);
});

test('held-back entries record why they were held back', () => {
  const p = path.join(__dirname, '..', 'data', 'discovered-review.json');
  if (!fs.existsSync(p)) return;
  const { heldBack } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bad = heldBack.filter((h) => !h.why || !h.source);
  eq(bad.map((h) => h.name), []);
});

test('the discovery stage is idempotent', () => {
  // A build folds discovered rows into the dataset. If the extractor then
  // deduplicated against the whole dataset it would match its own previous
  // output and empty itself — which is exactly what happened once.
  if (!fs.existsSync(path.join(__dirname, '..', 'cache', 'discovery-raw.json'))) return;
  const first = D.build().accepted.length;
  const second = D.build().accepted.length;
  eq(second, first, 're-running must accept the same rows, not zero');
  ok(first > 0, 'and it must accept something');
});

test('classification handles plural names', () => {
  const N = require('../src/normalise');
  eq(N.classify('The Big Bogong Moths', null), 'fauna');
  eq(N.classify('Big Cherries', null), 'fruit-and-veg');
  eq(N.classify('The Big Praying Mantids', null), 'fauna');
  eq(N.depluralise('Moths'), 'Moths Moth', 'case is preserved; matching is case-insensitive');
  eq(N.depluralise('cherries'), 'cherries cherry');
  eq(N.depluralise('glass'), 'glass', 'not a plural');
});

test('source subject categories beat our keyword guesses', () => {
  // "Thorny Devil" is not in any keyword list; the catalogue files it under
  // big-animals and that is better evidence than a regex.
  eq(D.SOURCE_CATEGORY_MAP['big-animals'], 'fauna');
  eq(D.SOURCE_CATEGORY_MAP['big-insects'], 'fauna');
  eq(D.SOURCE_CATEGORY_MAP['big-sea-creatures'], 'seafood');
  eq(D.SOURCE_CATEGORY_MAP['big-fruit'], 'fruit-and-veg');
});
