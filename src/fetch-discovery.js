'use strict';
/**
 * Discovery pass: find big things that neither wiki list carries.
 *
 * Two community catalogues enumerate far more than Wikipedia does, and both
 * expose the facts we need in machine-readable form:
 *
 *   landofthebigs.com     — ~258 Australian item pages, each embedding a Google
 *                           Maps iframe whose URL carries !2d<lng>!3d<lat>
 *   aussiebigthings.com.au — ~95 item pages with latitude/longitude in the
 *                           page's own hydration payload
 *
 * We take only facts — name, place, coordinate — which are not copyrightable,
 * and cite the page they came from. No prose is copied; the `notes` on a
 * discovered record stay empty rather than lifting someone's writing.
 *
 * Both sites' robots.txt permits crawling. Requests are serialised with a
 * delay, because being a good citizen of a hobbyist's blog matters more than
 * finishing a minute sooner.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, '..', 'cache');
const UA = 'BigThingsMap/1.0 (open-data research project; respects robots.txt)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchText(next, redirects + 1).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchRetry(url, attempts = 3) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    try { return await fetchText(url); } catch (e) {
      if (i === attempts) throw e;
      await sleep(wait); wait *= 2;
    }
  }
}

const locs = (xml) => (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((s) => s.replace(/<\/?loc>/g, '').trim());

/* ---------------- landofthebigs ---------------- */

const AU_STATE_SUFFIX = /-(vic|nsw|qld|wa|sa|nt|tas|act)\/?$/i;

/**
 * Pull the coordinate out of an embedded Google Maps iframe.
 * The `pb=` parameter encodes `!2d<longitude>!3d<latitude>`.
 */
function coordsFromGoogleEmbed(html) {
  const m = /!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/.exec(html);
  if (!m) return null;
  const lng = parseFloat(m[1]);
  const lat = parseFloat(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** The article's own title, preferred over the slug. */
function titleFrom(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  let t = og ? og[1] : null;
  if (!t) {
    const tt = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    t = tt ? tt[1] : null;
  }
  if (!t) return null;
  return decodeEntities(t)
    .replace(/\s*[|–-]\s*Land of the Bigs\s*$/i, '')
    .replace(/\s*[|–-]\s*Aussie Big Things.*$/i, '')
    .trim();
}

function decodeEntities(s) {
  return s
    // Numeric entities first, decimal and hex — "World&#x27;s Tallest Bin"
    // otherwise keeps its raw entity and fails every name test downstream.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}


/**
 * The catalogue's own taxonomy, which is better evidence of scope than any
 * guess we could make from a name. Land of the Bigs files genuine roadside
 * novelties under a `big-*` category and tags them `big-things` /
 * `roadside-attractions`; civic public art and memorials land in
 * `uncategorized` without those tags.
 */
function taxonomyFrom(html) {
  const categories = [...new Set((html.match(/\/category\/([a-z0-9-]+)\//g) || []).map((m) => m.split('/')[2]))];
  const tags = [...new Set((html.match(/\/tag\/([a-z0-9-]+)\//g) || []).map((m) => m.split('/')[2]))];
  return { categories, tags };
}

/** Split "big-cherry-wyuna-vic" into its state and the rest of the slug. */
function slugParts(url) {
  const slug = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
  const m = AU_STATE_SUFFIX.exec(slug);
  if (!m) return null;
  return { state: m[1].toUpperCase(), rest: slug.slice(0, m.index), slug };
}

async function harvestLandOfTheBigs() {
  const index = await fetchRetry('https://landofthebigs.com/sitemap_index.xml');
  const sitemaps = locs(index).filter((u) => /post-sitemap/i.test(u));
  const urls = [];
  for (const sm of sitemaps) {
    urls.push(...locs(await fetchRetry(sm)));
    await sleep(800);
  }
  const items = urls.filter((u) => AU_STATE_SUFFIX.test(u));
  console.log(`landofthebigs: ${urls.length} posts, ${items.length} look like single Australian big things`);

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const url = items[i];
    const parts = slugParts(url);
    try {
      const html = await fetchRetry(url);
      out.push({
        source: 'landofthebigs',
        url,
        slug: parts.slug,
        state: parts.state,
        title: titleFrom(html),
        coords: coordsFromGoogleEmbed(html),
        ...taxonomyFrom(html),
      });
    } catch (e) {
      out.push({ source: 'landofthebigs', url, slug: parts.slug, state: parts.state, title: null, coords: null, error: e.message });
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${items.length}\n`);
    await sleep(900);
  }
  return out;
}

/* ---------------- aussiebigthings ---------------- */

function coordsFromPayload(html) {
  // The page ships its own data; latitude/longitude appear as escaped JSON.
  const lat = /latitude\\?":\s*(-?\d+\.\d+)/.exec(html);
  const lng = /longitude\\?":\s*(-?\d+\.\d+)/.exec(html);
  if (!lat || !lng) return null;
  const a = parseFloat(lat[1]);
  const b = parseFloat(lng[1]);
  return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lng: b } : null;
}

/** The state is not in every slug, so read it from the page text. */
function stateFromText(html) {
  const pairs = [
    [/\bNew South Wales\b/i, 'NSW'], [/\bVictoria\b/i, 'VIC'], [/\bQueensland\b/i, 'QLD'],
    [/\bSouth Australia\b/i, 'SA'], [/\bWestern Australia\b/i, 'WA'],
    [/\bTasmania\b/i, 'TAS'], [/\bNorthern Territory\b/i, 'NT'],
    [/\bAustralian Capital Territory\b/i, 'ACT'],
  ];
  for (const [re, code] of pairs) if (re.test(html)) return code;
  return null;
}

async function harvestAussieBigThings() {
  const xml = await fetchRetry('https://www.aussiebigthings.com.au/sitemap.xml');
  const items = locs(xml).filter((u) => /\/explore\/[^/]+$/.test(u));
  console.log(`aussiebigthings: ${items.length} item pages`);

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const url = items[i];
    try {
      const html = await fetchRetry(url);
      out.push({
        source: 'aussiebigthings',
        url,
        slug: url.split('/').pop(),
        state: stateFromText(html),
        title: titleFrom(html),
        coords: coordsFromPayload(html),
      });
    } catch (e) {
      out.push({ source: 'aussiebigthings', url, slug: url.split('/').pop(), state: null, title: null, coords: null, error: e.message });
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${items.length}\n`);
    await sleep(700);
  }
  return out;
}

async function main() {
  const which = process.argv[2] || 'all';
  const results = [];
  if (which === 'all' || which === 'lotb') results.push(...await harvestLandOfTheBigs());
  if (which === 'all' || which === 'abt') results.push(...await harvestAussieBigThings());

  const outPath = path.join(CACHE, 'discovery-raw.json');
  const prior = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : [];
  const byUrl = new Map(prior.map((r) => [r.url, r]));
  for (const r of results) byUrl.set(r.url, r);
  const merged = [...byUrl.values()];
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 1));

  const withCoords = merged.filter((r) => r.coords).length;
  const failed = merged.filter((r) => r.error).length;
  console.log(`discovery-raw.json: ${merged.length} pages, ${withCoords} with coordinates, ${failed} failed`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { coordsFromGoogleEmbed, coordsFromPayload, titleFrom, slugParts, stateFromText, decodeEntities, taxonomyFrom };
