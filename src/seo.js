'use strict';
/**
 * Shared SEO/AEO plumbing for both page generators: site identity, canonical
 * + Open Graph + Twitter tags, and the JSON-LD escaping rule. One copy so the
 * two pages can't drift out of sync with each other or with data/site.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadSite() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
  return { siteUrl: cfg.siteUrl.replace(/\/+$/, ''), shareImage: cfg.shareImage };
}

const escAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escape a JSON payload so it is safe to inline inside a <script> block. */
const jsonLd = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

/** One <script type="application/ld+json"> holding every schema.org node as a @graph. */
function ldScript(graph) {
  return `<script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@graph': graph })}</script>`;
}

/**
 * Canonical link + Open Graph + Twitter Card tags for one page.
 * `pagePath` is the page's public path from the site root, e.g. '/' or '/about.html'.
 */
function metaTags({ siteUrl, pagePath, title, description, image }) {
  const url = `${siteUrl}${pagePath}`;
  const img = `${siteUrl}/${image}`;
  return `<link rel="canonical" href="${escAttr(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Big Things">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(description)}">
<meta property="og:url" content="${escAttr(url)}">
<meta property="og:image" content="${escAttr(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(title)}">
<meta name="twitter:description" content="${escAttr(description)}">
<meta name="twitter:image" content="${escAttr(img)}">`;
}

module.exports = { loadSite, jsonLd, ldScript, metaTags, escAttr };
