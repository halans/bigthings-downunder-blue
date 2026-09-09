'use strict';
/**
 * Run the OSM proximity matcher over every town-level record and write the
 * proposals to cache/osm-matches.json for audit.
 *
 * Nothing here touches data/bigthings.json — build.js consumes the audited
 * file. Run with --report to print a human-readable listing.
 */

const fs = require('fs');
const path = require('path');
const M = require('./match-osm');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');

function main() {
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bigthings.json'), 'utf8'));
  const candidates = JSON.parse(fs.readFileSync(path.join(CACHE, 'osm-attractions.json'), 'utf8'));

  // Merge, never replace. Once a match has been applied the record is no
  // longer town-level, so a fresh run would find nothing for it and dropping
  // the file's contents would silently un-upgrade every earlier match.
  const outPath = path.join(CACHE, 'osm-matches.json');
  const prior = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { matches: {}, ambiguous: [] };
  const matches = { ...(prior.matches || {}) };
  const priorCount = Object.keys(matches).length;

  const townLevel = dataset.things.filter((t) => t.precision === 'town');
  const ambiguous = [];
  let none = 0;

  for (const t of townLevel) {
    const m = M.bestMatch(t, candidates);
    if (!m) { none++; continue; }
    if (m.ambiguous) { ambiguous.push({ id: t.id, name: t.name, state: t.state, ...m }); continue; }
    matches[t.id] = {
      name: t.name,
      state: t.state,
      location: t.location,
      townLat: t.lat,
      townLng: t.lng,
      lat: m.cand.lat,
      lng: m.cand.lng,
      km: Math.round(m.km * 100) / 100,
      kind: m.kind,
      confidence: m.confidence,
      why: m.why,
      osmName: m.cand.name,
      osmId: m.cand.osmId,
      osmTags: [m.cand.tourism, m.cand.artwork, m.cand.manMade, m.cand.historic].filter(Boolean).join('/'),
      source: `https://www.openstreetmap.org/${m.cand.osmId}`,
    };
  }

  fs.writeFileSync(outPath, JSON.stringify({ matches, ambiguous }, null, 1));

  const byKind = {};
  const byConf = {};
  for (const m of Object.values(matches)) {
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    byConf[m.confidence] = (byConf[m.confidence] || 0) + 1;
  }
  console.log(`town-level records: ${townLevel.length}`);
  console.log(`matches on file:    ${Object.keys(matches).length} (${Object.keys(matches).length - priorCount} new this run)`);
  console.log(`ambiguous (skipped):${ambiguous.length}`);
  console.log(`no candidate:       ${none}`);
  console.log('by kind:', byKind);
  console.log('by confidence:', byConf);

  if (process.argv.includes('--report')) {
    console.log('\n--- proposed matches, furthest first (audit these) ---');
    for (const m of Object.values(matches).sort((a, b) => b.km - a.km)) {
      console.log(`${String(m.km).padStart(6)} km  [${m.kind}/${m.confidence}]  "${m.name}" (${m.location}, ${m.state})`);
      console.log(`              → OSM "${m.osmName}" [${m.osmTags}] ${m.osmId}`);
    }
    if (ambiguous.length) {
      console.log('\n--- ambiguous, left at town level ---');
      for (const a of ambiguous) console.log(`  ${a.name} (${a.state}): ${a.candidates.join(' | ')}`);
    }
  }
}

if (require.main === module) main();
