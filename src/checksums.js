'use strict';
/**
 * Record and verify SHA-256 checksums for the cached upstream snapshots, so a
 * recipient of the offline bundle can prove the inputs are the ones the
 * shipped dataset was built from — and rebuild everything with no network.
 *
 *   node src/checksums.js            write cache/CHECKSUMS.txt
 *   node src/checksums.js --verify   check the cache against it (exit 1 on drift)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const MANIFEST = path.join(CACHE, 'CHECKSUMS.txt');

/** Upstream snapshots and the licence each arrives under. */
const TRACKED = [
  ['wikipedia-bigthings.wikitext', 'en.wikipedia.org/wiki/Big_things_(Australia) — CC BY-SA 4.0'],
  ['wikipedia-bigthings.json', 'MediaWiki API response for the above — CC BY-SA 4.0'],
  ['wikivoyage-bigthings.wikitext', "en.wikivoyage.org/wiki/Australia's_big_things — CC BY-SA 4.0"],
  ['wikivoyage-bigthings.json', 'MediaWiki API response for the above — CC BY-SA 4.0'],
  ['wikipedia-coords.json', 'MediaWiki prop=coordinates for referenced titles — CC BY-SA 4.0'],
  ['place-coords.json', 'MediaWiki town coordinate lookups — CC BY-SA 4.0'],
  ['osm-bigthings.json', 'Overpass API, AU features named "Big *" — ODbL 1.0'],
  ['osm-attractions.json', 'Overpass API, all named AU artwork/sculpture/attraction features — ODbL 1.0'],
  ['osm-matches.json', 'Audited town→point upgrades from the proximity matcher — derived, ODbL 1.0'],
  ['verified-coords.json', 'Independent coordinate verification (OSM/Nominatim/operators) — ODbL 1.0 / cited'],
  ['verified-coords-a.json', 'Independent coordinate verification, batch A — ODbL 1.0 / cited'],
  ['verified-coords-b.json', 'Independent coordinate verification, batch B — ODbL 1.0 / cited'],
  ['verified-coords-c.json', 'Independent coordinate verification, batch C — ODbL 1.0 / cited'],
  ['commons-imageinfo.json', 'Wikimedia Commons/Wikipedia imageinfo: licence + author per photo — CC BY-SA metadata'],
  ['discovery-raw.json', 'Land of the Bigs + Aussie Big Things item pages, facts only — cited per row'],
  ['factcheck.json', 'Independent fact-check against non-wiki sources — cited per row'],
  ['factcheck.md', 'Fact-check working notes'],
];

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function collect() {
  const rows = [];
  for (const [file, note] of TRACKED) {
    const p = path.join(CACHE, file);
    if (!fs.existsSync(p)) { rows.push({ file, missing: true, note }); continue; }
    rows.push({ file, hash: sha256(p), bytes: fs.statSync(p).size, note });
  }
  return rows;
}

function write() {
  const rows = collect();
  const lines = [
    '# Cached upstream sources for the Australian Big Things dataset',
    `# Written ${new Date().toISOString().slice(0, 10)}. Verify with: npm run verify`,
    '#',
    '# Every file here is an unmodified snapshot of an openly-licensed source.',
    '# With these present, `npm run build` reproduces data/bigthings.json and',
    '# web/index.html with no network access at all.',
    '',
  ];
  for (const r of rows) {
    if (r.missing) { lines.push(`MISSING  ${r.file}  (${r.note})`); continue; }
    lines.push(`${r.hash}  ${r.file}  ${r.bytes} bytes`);
    lines.push(`${' '.repeat(64)}  ↳ ${r.note}`);
  }
  fs.writeFileSync(MANIFEST, lines.join('\n') + '\n');
  const present = rows.filter((r) => !r.missing).length;
  console.log(`wrote cache/CHECKSUMS.txt — ${present}/${rows.length} snapshots recorded`);
  for (const r of rows.filter((x) => x.missing)) console.log(`  (absent: ${r.file})`);
  return 0;
}

function verify() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('cache/CHECKSUMS.txt not found — run `npm run checksums` first');
    return 1;
  }
  const expected = new Map();
  for (const line of fs.readFileSync(MANIFEST, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s{2}(\S+)/.exec(line);
    if (m) expected.set(m[2], m[1]);
  }
  let bad = 0;
  let checked = 0;
  for (const [file, hash] of expected) {
    const p = path.join(CACHE, file);
    if (!fs.existsSync(p)) { console.error(`MISSING   ${file}`); bad++; continue; }
    const actual = sha256(p);
    checked++;
    if (actual !== hash) { console.error(`CHANGED   ${file}\n  expected ${hash}\n  actual   ${actual}`); bad++; }
  }
  if (bad) { console.error(`\n${bad} problem(s) across ${expected.size} tracked snapshots.`); return 1; }
  console.log(`all ${checked} cached snapshots match cache/CHECKSUMS.txt`);
  return 0;
}

if (require.main === module) {
  process.exit(process.argv.includes('--verify') ? verify() : write());
}

module.exports = { collect, write, verify, TRACKED };
