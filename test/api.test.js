'use strict';
/**
 * The app-facing copy of the dataset (src/build-api.js): records gain a resolved
 * imageUrl + imageCredit, and the GeoJSON is generated from the dataset rather
 * than copied from data/ (which can go stale).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, eq, ok } = require('./run');
const { enrichThing, buildApi } = require('../src/build-api');
const { loadImageCredits } = require('../src/image-credits');
const SEO = require('../src/seo');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://example.test';

const credits = {
  'Big Prawn.jpg': {
    local: 'img/big-prawn-aaaaaa.jpg', author: 'Ann', licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0', filePage: 'https://commons.wikimedia.org/wiki/File:Big_Prawn.jpg',
    sha256: 'x', bytes: 1,
  },
  'custom:big-pig-bbbbbb.jpeg': {
    local: 'img/custom/big-pig-bbbbbb.jpeg', author: 'Bob', licence: 'CC BY-SA 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/deed.en', filePage: 'https://halansphotography.com',
  },
};

const mk = (o) => ({ id: 'id', name: 'n', lat: -30, lng: 150, image: null, ...o });
const dataset = () => ({
  meta: { generated: '2026-11-21' },
  things: [
    mk({ id: 'a', image: 'Big Prawn.jpg', lat: -28.8, lng: 153.5 }),
    mk({ id: 'b', image: 'custom:big-pig-bbbbbb.jpeg' }),
    mk({ id: 'c', image: null }),
    mk({ id: 'd', image: 'Missing.jpg', lat: null, lng: null }),
  ],
});

test('enrichThing resolves imageUrl and a four-field imageCredit, keeping image', () => {
  const t = enrichThing(dataset().things[0], credits, SITE);
  eq(t.image, 'Big Prawn.jpg');
  eq(t.imageUrl, 'https://example.test/img/big-prawn-aaaaaa.jpg');
  eq(t.imageCredit, {
    author: 'Ann', licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0', filePage: 'https://commons.wikimedia.org/wiki/File:Big_Prawn.jpg',
  });
});

test('enrichThing resolves a custom: photo under img/custom/', () => {
  eq(enrichThing(dataset().things[1], credits, SITE).imageUrl, 'https://example.test/img/custom/big-pig-bbbbbb.jpeg');
});

test('enrichThing gives null url and credit for no image or an uncredited image', () => {
  for (const i of [2, 3]) {
    const t = enrichThing(dataset().things[i], credits, SITE);
    eq(t.imageUrl, null);
    eq(t.imageCredit, null);
  }
});

test('buildApi geojson has one finite-coordinate feature per record with a lat', () => {
  const g = JSON.parse(buildApi({ dataset: dataset(), credits, siteUrl: SITE }).geojson);
  eq(g.type, 'FeatureCollection');
  eq(g.features.length, 3);
  eq(g.features[0].geometry.coordinates, [153.5, -28.8]);
  for (const f of g.features) ok(f.geometry.coordinates.every(Number.isFinite), 'finite coordinates');
  eq(g.features.map((f) => f.id), ['a', 'b', 'c'], 'feature id is the record id');
  eq(g.features[0].properties.imageUrl, 'https://example.test/img/big-prawn-aaaaaa.jpg');
});

test('buildApi version describes exactly the json it returns', () => {
  const { json, version } = buildApi({ dataset: dataset(), credits, siteUrl: SITE });
  eq(version.generated, '2026-11-21');
  eq(version.count, 4);
  eq(version.bytes, Buffer.byteLength(json));
  eq(version.sha256, crypto.createHash('sha256').update(json).digest('hex'));
  eq(JSON.parse(json).meta, { generated: '2026-11-21' });
});

test('buildApi does not mutate its input', () => {
  const d = dataset();
  const before = JSON.stringify(d);
  buildApi({ dataset: d, credits, siteUrl: SITE });
  eq(JSON.stringify(d), before);
});

test('real data: every photographed record gets a url and an author; urls point at real files', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const { siteUrl } = SEO.loadSite();
  const out = JSON.parse(buildApi({ dataset: real, credits: loadImageCredits(), siteUrl }).json);
  eq(out.things.length, real.things.length);
  const hasImg = fs.existsSync(path.join(ROOT, 'web', 'img'));
  for (const t of out.things.filter((x) => x.image)) {
    ok(t.imageUrl, `${t.name}: no imageUrl for ${t.image}`);
    ok(t.imageCredit && t.imageCredit.author, `${t.name}: no credit author`);
    if (hasImg) ok(fs.existsSync(path.join(ROOT, 'web', new URL(t.imageUrl).pathname)), `${t.name}: ${t.imageUrl} missing from web/`);
  }
});

// --- writing into public/ -------------------------------------------------

const os = require('os');
const { writeApi } = require('../src/build-api');
const { HEADERS } = require('../src/build-public');

test('_headers revalidates /data/* and types the geojson', () => {
  ok(/\/data\/\*\n\s+Cache-Control: public, max-age=0, must-revalidate/.test(HEADERS), '/data/* revalidate rule');
  ok(/\/data\/bigthings-au\.geojson\n\s+Content-Type: application\/geo\+json/.test(HEADERS), 'geojson content-type rule');
});

test('writeApi writes three parseable files whose version matches the json on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-api-'));
  try {
    writeApi(dir);
    for (const f of ['bigthings.json', 'bigthings-au.geojson', 'version.json']) {
      JSON.parse(fs.readFileSync(path.join(dir, 'data', f), 'utf8'));
    }
    const raw = fs.readFileSync(path.join(dir, 'data', 'bigthings.json'));
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'version.json'), 'utf8'));
    eq(v.bytes, raw.length);
    eq(v.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
    eq(v.count, JSON.parse(raw).things.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
