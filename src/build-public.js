'use strict';
/**
 * Assemble public/ — web/index.html and web/about.html plus their assets,
 * packaged as a normal static site ready to deploy as-is to Cloudflare Pages
 * (or any static host).
 *
 * The build already loads zero third-party assets (see standalone.test.js) —
 * everything is self-hosted — so this step is just gathering the pieces:
 * copy the two generated pages, copy img/ and vendor/ verbatim (every path
 * inside them is already relative), and add the deploy-only extras that
 * belong in a site root rather than in web/ (_headers, robots.txt,
 * sitemap.xml).
 *
 *   node src/build-public.js
 */

const fs = require('fs');
const path = require('path');
const W = require('./build-web');
const A = require('./build-about');
const SEO = require('./seo');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const PUBLIC = path.join(ROOT, 'public');

const HEADERS = `/vendor/*
  Cache-Control: public, max-age=604800, immutable
/img/*
  Cache-Control: public, max-age=31536000, immutable
`;

function robotsTxt(siteUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

function sitemapXml(siteUrl, lastmod) {
  const urls = [
    { loc: `${siteUrl}/`, priority: '1.0' },
    { loc: `${siteUrl}/about.html`, priority: '0.8' },
  ];
  const entries = urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  if (!fs.existsSync(path.join(WEB, 'img')) || !fs.existsSync(path.join(WEB, 'vendor'))) {
    throw new Error('web/img and web/vendor must exist first — run `npm run standalone`');
  }

  fs.mkdirSync(PUBLIC, { recursive: true });

  const map = W.generate();
  fs.writeFileSync(path.join(PUBLIC, 'index.html'), map);

  const about = A.generate();
  fs.writeFileSync(path.join(PUBLIC, 'about.html'), about);

  copyDir(path.join(WEB, 'img'), path.join(PUBLIC, 'img'));
  copyDir(path.join(WEB, 'vendor'), path.join(PUBLIC, 'vendor'));

  fs.writeFileSync(path.join(PUBLIC, '_headers'), HEADERS);

  const { siteUrl } = SEO.loadSite();
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  fs.writeFileSync(path.join(PUBLIC, 'robots.txt'), robotsTxt(siteUrl));
  fs.writeFileSync(path.join(PUBLIC, 'sitemap.xml'), sitemapXml(siteUrl, dataset.meta.generated));

  for (const [name, html] of [['index.html', map], ['about.html', about]]) {
    console.log(`wrote public/${name} — ${(html.length / 1024).toFixed(0)} KB`);
  }
  console.log('copied img/ and vendor/ into public/, wrote public/_headers, robots.txt, sitemap.xml');
}

if (require.main === module) main();

module.exports = { main };
