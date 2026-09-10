'use strict';
/**
 * Vendor the Wikimedia Commons photographs, with their licences.
 *
 * Two jobs, and the second is the important one:
 *
 *   1. Download a 480px-wide copy of each photo into web/img/ so the app
 *      serves it from this domain instead of hotlinking Commons.
 *   2. Capture, per file, the licence and the photographer — because most of
 *      these are CC BY or CC BY-SA, which *require* naming both. The app
 *      previously displayed them bare, which was a licence breach.
 *
 * Anything whose licence we cannot confidently call free is skipped and
 * logged, never shipped. A card falling back to its emoji placeholder is a far
 * better outcome than distributing a file we have no right to.
 *
 * Commons' own thumbnails are used as-is rather than re-encoded locally: that
 * keeps a rebuild a Node-only operation with no image toolchain, which is
 * what makes it reproducible from cache/ with no network at all.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const IMG_DIR = path.join(ROOT, 'web', 'img');
const WIDTH = 480;
const UA = 'BigThingsMap/1.0 (open-data research project; vendoring CC images with attribution)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Licence codes we are confident are free for redistribution.
 * Matched against Commons' `License` extmetadata value, lower-cased.
 */
const FREE_LICENCE = /^(cc0|cc-by(-sa)?(-\d(\.\d)?)?([-a-z]*)?|pd|pd-.*|public[ -]?domain.*|attribution|gfdl.*|fal|no restrictions)$/i;

/** Licence markers that mean "do not redistribute". */
const NON_FREE = /fair[ -]?use|non[- ]?free|copyright|all rights reserved/i;

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return get(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function getRetry(url, attempts = 4) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    try { return await get(url); } catch (e) {
      if (i === attempts) throw e;
      await sleep(wait); wait = Math.min(wait * 2, 20000);
    }
  }
}

const stripHtml = (s) => String(s == null ? '' : s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Batch `imageinfo` for up to 50 Commons file titles. */
async function fetchMetadata(filenames, host = 'commons.wikimedia.org') {
  const out = {};
  for (let i = 0; i < filenames.length; i += 50) {
    const batch = filenames.slice(i, i + 50);
    const url = `https://${host}/w/api.php?action=query&format=json&formatversion=2`
      + '&prop=imageinfo&iiprop=url|size|mime|extmetadata'
      + `&iiurlwidth=${WIDTH}`
      + '&titles=' + batch.map((f) => encodeURIComponent('File:' + f)).join('|');
    const { body } = await getRetry(url);
    const json = JSON.parse(body.toString('utf8'));
    const q = json.query || {};
    const norm = {};
    for (const n of q.normalized || []) norm[n.from] = n.to;
    for (const r of q.redirects || []) norm[r.from] = r.to;

    const byTitle = {};
    for (const p of q.pages || []) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii) { byTitle[p.title] = { missing: true }; continue; }
      const m = ii.extmetadata || {};
      const v = (k) => (m[k] ? stripHtml(m[k].value) : null);
      byTitle[p.title] = {
        title: p.title,
        thumbUrl: ii.thumburl || null,
        thumbWidth: ii.thumbwidth || null,
        mime: ii.mime || null,
        filePage: ii.descriptionurl || `https://${host}/wiki/${encodeURIComponent(p.title)}`,
        host,
        licence: v('License'),
        licenceName: v('LicenseShortName'),
        licenceUrl: m.LicenseUrl ? stripHtml(m.LicenseUrl.value) : null,
        artist: v('Artist'),
        credit: v('Credit'),
        usageTerms: v('UsageTerms'),
        attributionRequired: v('AttributionRequired'),
        restrictions: v('Restrictions'),
      };
    }
    for (const f of batch) {
      let t = 'File:' + f;
      const seen = new Set();
      while (norm[t] && !seen.has(t)) { seen.add(t); t = norm[t]; }
      out[f] = byTitle[t] || { missing: true };
    }
    process.stderr.write(`  metadata ${Math.min(i + 50, filenames.length)}/${filenames.length} (${host})\n`);
    await sleep(700);
  }
  return out;
}

/** Is this file's licence one we can redistribute? */
function assessLicence(meta) {
  const code = (meta.licence || '').toLowerCase().trim();
  const terms = `${meta.usageTerms || ''} ${meta.licenceName || ''}`;
  if (NON_FREE.test(terms) && !/creative commons|public domain/i.test(terms)) {
    return { free: false, why: `usage terms look non-free: ${terms.slice(0, 80)}` };
  }
  if (!code) {
    // No machine-readable licence. Accept only if the human-readable terms are
    // unambiguously a CC or public-domain statement.
    if (/creative commons|public domain|cc0/i.test(terms)) return { free: true, why: `no licence code, but terms say: ${terms.slice(0, 60)}` };
    return { free: false, why: 'no licence code and no recognisable free-licence statement' };
  }
  if (FREE_LICENCE.test(code)) return { free: true, why: null };
  return { free: false, why: `unrecognised licence code "${code}"` };
}

/** A filesystem-safe, readable, collision-free local name. */
function localName(filename) {
  const ext = (path.extname(filename) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  // Short hash keeps two similarly-named files apart.
  const h = crypto.createHash('sha1').update(filename).digest('hex').slice(0, 6);
  return `${stem}-${h}${ext}`;
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  // A `custom:`-prefixed image is one added by hand (see docs/ADMIN.md) —
  // it isn't on Commons at all, so there's nothing here to fetch or check.
  const filenames = [...new Set(dataset.things.map((t) => t.image).filter((f) => f && !f.startsWith('custom:')))];
  console.log(`${filenames.length} unique Commons files referenced`);

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const manifestPath = path.join(ROOT, 'data', 'image-credits.json');
  const prior = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { images: {} };

  const metaCachePath = path.join(CACHE, 'commons-imageinfo.json');
  let meta;
  if (fs.existsSync(metaCachePath) && !process.argv.includes('--refresh')) {
    meta = JSON.parse(fs.readFileSync(metaCachePath, 'utf8'));
    const missing = filenames.filter((f) => !meta[f]);
    if (missing.length) {
      console.log(`fetching metadata for ${missing.length} new files…`);
      Object.assign(meta, await fetchMetadata(missing));
      fs.writeFileSync(metaCachePath, JSON.stringify(meta, null, 1));
    } else {
      console.log('metadata served from cache/commons-imageinfo.json');
    }
  } else {
    console.log('fetching Commons metadata…');
    meta = await fetchMetadata(filenames);
    fs.writeFileSync(metaCachePath, JSON.stringify(meta, null, 1));
  }

  // Some files live on English Wikipedia rather than Commons. Same free
  // licences, different host — worth a second look before giving up on them.
  const notOnCommons = filenames.filter((f) => !meta[f] || meta[f].missing);
  if (notOnCommons.length) {
    console.log(`${notOnCommons.length} not on Commons — trying en.wikipedia.org…`);
    const local = await fetchMetadata(notOnCommons, 'en.wikipedia.org');
    let found = 0;
    for (const [f, m] of Object.entries(local)) {
      if (m && !m.missing) { meta[f] = m; found++; }
    }
    console.log(`  recovered ${found}`);
    fs.writeFileSync(metaCachePath, JSON.stringify(meta, null, 1));
  }

  const images = {};
  const skipped = [];
  let downloaded = 0;
  let reused = 0;

  for (const f of filenames) {
    const m = meta[f];
    if (!m || m.missing) { skipped.push({ file: f, why: 'not found on Commons' }); continue; }

    const verdict = assessLicence(m);
    if (!verdict.free) { skipped.push({ file: f, why: verdict.why, licence: m.licence, terms: m.usageTerms }); continue; }

    const local = localName(f);
    const dest = path.join(IMG_DIR, local);
    const existing = prior.images && prior.images[f];

    if (fs.existsSync(dest) && existing && existing.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (actual === existing.sha256) {
        images[f] = existing;
        reused++;
        continue;
      }
    }

    const host = m.host || 'commons.wikimedia.org';
    const src = m.thumbUrl || `https://${host}/wiki/Special:FilePath/${encodeURIComponent(f)}?width=${WIDTH}`;
    try {
      const { body, contentType } = await getRetry(src);
      if (!/^image\//.test(contentType)) throw new Error(`not an image (${contentType})`);
      fs.writeFileSync(dest, body);
      images[f] = {
        local: `img/${local}`,
        bytes: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        width: m.thumbWidth || WIDTH,
        licence: m.licenceName || m.licence,
        licenceCode: m.licence,
        licenceUrl: m.licenceUrl,
        author: m.artist || m.credit || 'Unknown',
        attributionRequired: m.attributionRequired === 'true' || /by/i.test(m.licence || ''),
        filePage: m.filePage,
        remote: `https://${host}/wiki/Special:FilePath/${encodeURIComponent(f)}?width=${WIDTH}`,
        host,
      };
      downloaded++;
      if (downloaded % 25 === 0) process.stderr.write(`  downloaded ${downloaded}\n`);
      await sleep(350);
    } catch (e) {
      skipped.push({ file: f, why: `download failed: ${e.message}` });
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    _readme: 'Per-photo licence and attribution for the vendored Wikimedia Commons images. Generated by src/fetch-images.js. Every entry names the photographer and the licence because most of these files require it. Do not hand-edit.',
    generated: new Date().toISOString().slice(0, 10),
    width: WIDTH,
    images,
    skipped,
  }, null, 1));

  const totalBytes = Object.values(images).reduce((a, i) => a + (i.bytes || 0), 0);
  const byLicence = {};
  for (const i of Object.values(images)) byLicence[i.licence || '?'] = (byLicence[i.licence || '?'] || 0) + 1;

  console.log(`\nvendored: ${Object.keys(images).length} images (${downloaded} downloaded, ${reused} already local)`);
  console.log(`total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('by licence:', byLicence);
  console.log(`skipped: ${skipped.length}`);
  for (const s of skipped.slice(0, 15)) console.log(`   ${s.file} — ${s.why}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { assessLicence, localName, stripHtml, FREE_LICENCE, NON_FREE, WIDTH };
