'use strict';
/**
 * Generate web/credits.html — every photo on the site, its photographer and
 * its licence, readable by a visitor rather than only by someone browsing the
 * repository. Same rows as docs/IMAGE-CREDITS.md (both come from
 * photoCredits()), so the page and the doc cannot disagree.
 *
 *   node src/build-credits.js
 */

const fs = require('fs');
const path = require('path');
const SEO = require('./seo');
const { photoCredits, displayFile } = require('./image-credits');

const ROOT = path.join(__dirname, '..');

const TITLE = 'Photo credits · Big Things Down Under';
const DESCRIPTION = 'Every photograph on the Big Things map, with its photographer and licence.';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function row({ file, thing, credit: c, custom }) {
  // A custom photo's filePage is the photographer's own site (see
  // data/custom-photos.json), so the name links there. A Commons filePage is
  // the file's page, already linked from the File column.
  const author = custom && c.filePage ? ext(c.filePage, esc(c.author || 'Unknown')) : esc(c.author || 'Unknown');
  const licence = c.licenceUrl ? ext(c.licenceUrl, esc(c.licence)) : esc(c.licence || 'see file page');
  const name = esc(displayFile(file));
  return `<tr>
    <td class="thumb"><img src="${esc(c.local)}" alt="" loading="lazy" width="64" height="48"></td>
    <td><a href="index.html#thing=${esc(thing.id)}" title="View ${esc(thing.name)} on the map">${esc(thing.name)}</a> <span class="st">${esc(thing.state)}</span></td>
    <td>${author}</td>
    <td>${licence}</td>
    <td class="file">${c.filePage ? ext(c.filePage, name) : name}</td>
  </tr>`;
}

function generate() {
  const pc = photoCredits();
  const site = SEO.loadSite();
  const seoMeta = SEO.metaTags({ siteUrl: site.siteUrl, pagePath: '/credits.html', title: TITLE, description: DESCRIPTION, image: site.shareImage });
  const licences = pc.licences.map(([l, n]) => `<li><b>${n}</b> ${esc(l)}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${SEO.escAttr(TITLE)}</title>
<meta name="description" content="${SEO.escAttr(DESCRIPTION)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍌</text></svg>">
${seoMeta}
<link rel="stylesheet" href="vendor/fonts.css">
<style>
:root{
  --ink:#1b1a17; --ink-soft:#4a463e; --cream:#fdf6e8; --cream-2:#f6ebd6; --paper:#fffdf7;
  --earth:#c8452b; --sun:#f0a71c; --line:#e3d6bd;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--cream); color:var(--ink);
  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased; line-height:1.6;
}
a{color:var(--earth)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.topbar{position:sticky;top:0;z-index:50;background:rgba(253,246,232,.94);backdrop-filter:blur(6px);border-bottom:2px solid var(--ink)}
.topbar .inner{max-width:1120px;margin:0 auto;padding:9px 24px;display:flex;align-items:center;gap:10px}
.topbar .mark{font-family:Caprasimo,Inter,sans-serif;font-size:19px;color:var(--earth);text-decoration:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{
  display:inline-block;border:2px solid var(--ink);border-radius:11px;padding:7px 13px;
  font-size:13.5px;font-weight:700;text-decoration:none;color:var(--ink);background:var(--cream);
  box-shadow:0 2px 0 var(--ink);transition:transform .08s;white-space:nowrap;
}
.btn:active{transform:translateY(2px);box-shadow:none}
.btn.hot{background:var(--sun)}
h1{font-family:Caprasimo,Inter,sans-serif;font-weight:400;font-size:clamp(34px,7vw,56px);line-height:1;color:var(--earth);margin:40px 0 0}
p{max-width:66ch;margin:14px 0 0}
.lic{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:20px 0 0}
.lic li{background:var(--paper);border:1.5px solid var(--ink);border-radius:999px;padding:3px 11px;font-size:12.5px}
.scroll{overflow-x:auto;margin:26px 0 48px;border:2px solid var(--ink);border-radius:13px;background:var(--paper)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);border-bottom:2px solid var(--ink);background:var(--cream-2)}
tr:last-child td{border-bottom:none}
td.thumb{width:76px;padding-right:0}
td.thumb img{display:block;width:64px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
td.file{overflow-wrap:anywhere;min-width:180px}
.st{font-size:11.5px;color:var(--ink-soft)}
@media (max-width:600px){
  .wrap,.topbar .inner{padding-left:16px;padding-right:16px}
  .topbar .btn.secondary{display:none}
  td.thumb{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<div class="topbar"><div class="inner">
  <a class="mark" href="about.html">Big Things Down Under</a>
  <a class="btn secondary" href="about.html">About</a>
  <a class="btn hot" href="index.html">Open the map →</a>
</div></div>

<main class="wrap">
  <h1>Photo credits</h1>
  <p>
    ${pc.rows.length} photographs: ${pc.commonsCount} from Wikimedia Commons and ${pc.customCount} added by hand.
    Each is reproduced under a free licence, and most of those licences require the photographer to be named,
    so every one is listed here as well as on its card on the map.
  </p>
  <p>
    <strong>The photographs are not covered by this project's licence.</strong> Each stays under the licence
    its author chose; the dataset itself is CC BY-SA 4.0.
  </p>
  <ul class="lic">${licences}</ul>
  <div class="scroll"><table>
    <thead><tr><th><span hidden>Photo</span></th><th>Big thing</th><th>Photographer</th><th>Licence</th><th>File</th></tr></thead>
    <tbody>${pc.rows.map(row).join('')}</tbody>
  </table></div>
</main>

</body>
</html>
`;
}

if (require.main === module) {
  const dest = path.join(ROOT, 'web', 'credits.html');
  const html = generate();
  fs.writeFileSync(dest, html);
  console.log(`wrote ${path.relative(ROOT, dest)} — ${(html.length / 1024).toFixed(0)} KB`);
}

module.exports = { generate };
