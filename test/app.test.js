'use strict';
/**
 * The /app page: a short, unprominent page about the iPhone app. Like the
 * About page, its figures are generated from data/, and it must stay
 * self-hosted. These tests pin both, plus the link back to the app's own page.
 */

const fs = require('fs');
const path = require('path');
const { test, eq, ok } = require('./run');
const P = require('../src/build-app');

const ROOT = path.join(__dirname, '..');
const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
const s = dataset.meta.stats;

const html = P.generate();

test('the app page fills every placeholder', () => {
  eq(html.match(/__[A-Z_]+__/g), null, 'unfilled placeholder');
});

test('the app page figures are the dataset\'s, not hand-typed', () => {
  const figs = Object.fromEntries([...html.matchAll(/<div class="fig"><b>([\d,]+)<\/b><span>([^<]+)<\/span>/g)]
    .map((m) => [m[2], Number(m[1].replace(/,/g, ''))]));
  eq(figs['big things'], s.total);
  eq(figs['with photos'], dataset.things.filter((t) => t.image).length);
  eq(figs['states & territories'], Object.keys(s.byState).length);
  eq(figs.kinds, Object.keys(s.byCategory).length);
  ok(html.includes(`all ${s.total.toLocaleString()} records`), 'prose total matches the dataset');
});

test('the app page links back to the app\'s own page', () => {
  ok(site.app && site.app.pageUrl, 'data/site.json has app.pageUrl');
  ok(html.includes(`href="${site.app.pageUrl}"`), 'links to the full app page');
});

test('the app page is "coming soon" until a store URL is configured', () => {
  if (site.app.storeUrl) ok(html.includes(site.app.storeUrl), 'store button points at storeUrl');
  else ok(html.includes('class="status"') && !/Download on the App Store/.test(html), 'no download button without a store URL');
});

test('the app page loads only local images, fonts and scripts', () => {
  eq(html.match(/<script(?![^>]*application\/ld\+json)[^>]*\ssrc=/g), null, 'no external scripts');
  const srcs = [...html.matchAll(/\s(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
  ok(srcs.length >= 4, 'icon + screenshots present');
  for (const u of srcs) {
    ok(!/^(https?:)?\/\//.test(u), `image should be local, got ${u}`);
    ok(fs.existsSync(path.join(ROOT, 'web', u)), `${u} exists in web/`);
  }
  for (const m of html.matchAll(/<link[^>]+rel="(?:stylesheet|icon|apple-touch-icon)"[^>]*>/g)) {
    ok(!/href="(https?:)?\/\//.test(m[0]), `stylesheet/icon should be local: ${m[0]}`);
  }
});

test('the app page has a canonical /app URL and every screenshot has alt text', () => {
  ok(html.includes(`<link rel="canonical" href="${site.siteUrl}/app">`), 'canonical');
  for (const m of html.matchAll(/<img [^>]*>/g)) ok(/\salt="/.test(m[0]), `img needs alt: ${m[0]}`);
  eq(P.SCREENS.length, 3);
});

test('the app page is in the sitemap and linked from the map and About footers', () => {
  const pub = fs.readFileSync(path.join(ROOT, 'src', 'build-public.js'), 'utf8');
  ok(/\/app`/.test(pub), 'sitemap lists /app');
  ok(fs.readFileSync(path.join(ROOT, 'web', 'about-template.html'), 'utf8').includes('href="app.html"'), 'About links to app');
  ok(fs.readFileSync(path.join(ROOT, 'web', 'template.html'), 'utf8').includes('href="app.html"'), 'map links to app');
});
