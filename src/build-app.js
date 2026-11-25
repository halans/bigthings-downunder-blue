'use strict';
/**
 * Generate web/app.html — a short page about the iPhone/iPad app, which carries
 * the whole dataset inside it and so works with no signal (the website doesn't).
 *
 * Deliberately small and unprominent: it is one more way to use the data, and
 * the full story lives on the app's own page (data/site.json → app.pageUrl).
 * Like the About page, every figure is computed from data/ at build time, and
 * every asset (icon, screenshots, fonts) is self-hosted in web/img and web/vendor.
 */

const fs = require('fs');
const path = require('path');
const SEO = require('./seo');

const ROOT = path.join(__dirname, '..');
const IMG = path.join(ROOT, 'web', 'img');

const TITLE = 'Big Things for iPhone: the map that works offline';
const DESCRIPTION = "The Big Things map as an iPhone, iPad and iPhone Duo app: every one of Australia's giant roadside sculptures in your pocket, with no signal needed.";

const SCREENS = [
  ['app-map', 'The map of Australia with clustered pins.', 'The map: zoom from the whole country to one street.'],
  ['app-list', 'The list of big things, each with a photo, its town and its kind.', 'The list: search by name, town or state.'],
  ['app-detail', 'The Big Banana in Coffs Harbour: a photo, when it was built, its size and a description.', 'The details: when it was built and how big it is.'],
];

const esc = SEO.escAttr;

/** Content-hashed screenshot, e.g. web/img/app-map-ac21fb.jpg → 'img/app-map-ac21fb.jpg'. */
function screenshotPath(prefix) {
  const re = new RegExp(`^${prefix}-[0-9a-f]{6}\\.jpe?g$`);
  const hit = fs.readdirSync(IMG).filter((f) => re.test(f)).sort();
  if (!hit.length) throw new Error(`no ${prefix}-<hash>.jpg in web/img — the /app page needs its screenshots`);
  return `img/${hit[hit.length - 1]}`;
}

function generate() {
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
  const app = site.app;
  if (!app || !app.pageUrl) throw new Error('data/site.json needs an `app.pageUrl`');
  const { siteUrl } = SEO.loadSite();
  const s = dataset.meta.stats;
  const withPhotos = dataset.things.filter((t) => t.image).length;

  const figures = [
    [s.total, 'big things'],
    [withPhotos, 'with photos'],
    [Object.keys(s.byState).length, 'states & territories'],
    [Object.keys(s.byCategory).length, 'kinds'],
  ].map(([n, l]) => `<div class="fig"><b>${n.toLocaleString()}</b><span>${l}</span></div>`).join('');

  const appButton = app.storeUrl
    ? `<a class="btn hot big" href="${esc(app.storeUrl)}" target="_blank" rel="noopener noreferrer">Download on the App Store</a>`
    : `<span class="status">${esc(app.comingSoon || 'Coming soon to the App Store')}</span>`;

  const screens = SCREENS.map(([prefix, alt, caption]) => `<figure>
      <img src="${esc(screenshotPath(prefix))}" alt="${esc(alt)}" loading="lazy">
      <figcaption>${esc(caption)}</figcaption>
    </figure>`).join('');

  const breadcrumbs = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Big Things', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'iPhone app' },
    ],
  };
  const seoMeta = `${SEO.metaTags({ siteUrl, pagePath: '/app', title: TITLE, description: DESCRIPTION, image: site.shareImage })}\n${SEO.ldScript([breadcrumbs])}`;

  const template = fs.readFileSync(path.join(ROOT, 'web', 'app-template.html'), 'utf8');
  return template
    .replace('__TITLE__', esc(TITLE))
    .replace('__DESCRIPTION__', esc(DESCRIPTION))
    .replace('__SEO_META__', seoMeta)
    .replace(/__APP_BUTTON__/g, appButton)
    .replace(/__APP_PAGE_URL__/g, esc(app.pageUrl))
    .replace(/__FINE_PRINT__/g, esc(app.fineprint || ''))
    .replace(/__REQUIRES__/g, esc(app.requires || ''))
    .replace(/__FIGURES__/g, figures)
    .replace(/__SCREENS__/g, screens)
    .replace(/__TOTAL__/g, s.total.toLocaleString())
    .replace(/__GENERATED__/g, esc(dataset.meta.generated));
}

if (require.main === module) {
  const dest = path.join(ROOT, 'web', 'app.html');
  const html = generate();
  const left = html.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`unfilled placeholders in the app build: ${[...new Set(left)].join(', ')}`);
  fs.writeFileSync(dest, html);
  console.log(`wrote ${path.relative(ROOT, dest)} — ${(html.length / 1024).toFixed(0)} KB`);
}

module.exports = { generate, TITLE, DESCRIPTION, SCREENS };
