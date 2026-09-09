'use strict';
/**
 * Turn the cached Wikipedia "Big things (Australia)" wikitext into structured
 * records. Output is intentionally coordinate-free — geocoding is a separate,
 * cacheable stage (see src/geocode.js).
 */

const fs = require('fs');
const path = require('path');
const W = require('./wikitext');
const N = require('./normalise');

const STATE_CODES = {
  'Australian Capital Territory': 'ACT',
  'New South Wales': 'NSW',
  'Northern Territory': 'NT',
  Queensland: 'QLD',
  'South Australia': 'SA',
  Tasmania: 'TAS',
  Victoria: 'VIC',
  'Western Australia': 'WA',
};

function extract(wikitext) {
  const listSection = /==\s*List of big things[\s\S]*?(?=\n==[^=])/.exec(wikitext);
  const scope = listSection ? listSection[0] : wikitext;
  const records = [];
  const warnings = [];

  for (const section of W.sectionsByHeading(scope, 3)) {
    const state = STATE_CODES[section.title];
    if (!state) { warnings.push(`unknown state heading: ${section.title}`); continue; }

    for (const table of W.extractTables(section.body)) {
      const rows = W.parseRows(table);
      const header = rows.find((r) => r.header);
      if (!header) { warnings.push(`${state}: table with no header`); continue; }
      const cols = header.cells.map((c) => W.toPlainText(c).toLowerCase());
      const idx = {
        name: cols.findIndex((c) => c.startsWith('name')),
        location: cols.findIndex((c) => c.startsWith('location')),
        built: cols.findIndex((c) => c.startsWith('built')),
        size: cols.findIndex((c) => c.startsWith('size')),
        notes: cols.findIndex((c) => c.startsWith('notes')),
        image: cols.findIndex((c) => c.startsWith('image')),
      };
      if (idx.name < 0 || idx.location < 0) { warnings.push(`${state}: table missing name/location columns (${cols.join('|')})`); continue; }

      for (const row of rows) {
        if (row.header) continue;
        const cell = (i) => (i >= 0 && i < row.cells.length ? row.cells[i] : '');
        const nameRaw = cell(idx.name);
        const name = W.toPlainText(nameRaw);
        if (!name) continue;

        const locationRaw = cell(idx.location);
        const notesRaw = cell(idx.notes);
        const notes = W.toPlainText(notesRaw);
        const size = N.parseSize(cell(idx.size));
        const built = N.parseBuilt(cell(idx.built));
        const status = N.inferStatus(notes);
        const nameLinks = W.links(nameRaw);
        const locLinks = W.links(locationRaw);
        const coordTemplates = [...W.findTemplates(locationRaw, 'coord'), ...W.findTemplates(notesRaw, 'coord')];

        records.push({
          name,
          state,
          location: W.toPlainText(locationRaw) || null,
          locationLinks: locLinks.map((l) => l.target),
          articleTitle: nameLinks.length ? nameLinks[0].target : null,
          builtYear: built.year,
          builtCirca: built.circa,
          builtRaw: built.text,
          heightM: size.heightM,
          lengthM: size.lengthM,
          sizeMaxM: size.sizeMaxM,
          sizeKind: size.sizeKind,
          dimsM: size.dimsM,
          sizeRaw: size.text,
          notes: notes || null,
          status: status.status,
          statusEvidence: status.evidence,
          category: N.classify(name, notes),
          era: N.era(built.year),
          images: W.fileNames(cell(idx.image)).concat(W.fileNames(notesRaw)),
          coordTemplate: coordTemplates.length ? parseCoordTemplate(coordTemplates[0].params) : null,
        });
      }
    }
  }
  return { records, warnings };
}

/** {{coord|-33.86|151.21}} or {{coord|33|52|S|151|12|E}} → {lat,lng} */
function parseCoordTemplate(params) {
  const p = params.filter((x) => !x.includes('=') && x !== '');
  const nums = p.filter((x) => /^-?[\d.]+$/.test(x)).map(Number);
  const hasNS = p.some((x) => /^[NSns]$/.test(x));
  if (!hasNS && nums.length >= 2) return { lat: nums[0], lng: nums[1] };
  if (hasNS) {
    const nsIdx = p.findIndex((x) => /^[NSns]$/.test(x));
    const ewIdx = p.findIndex((x) => /^[EWew]$/.test(x));
    if (nsIdx > 0 && ewIdx > nsIdx) {
      const dms = (arr) => arr.reduce((a, v, i) => a + Number(v) / 60 ** i, 0);
      const lat = dms(p.slice(0, nsIdx)) * (/^[Ss]$/.test(p[nsIdx]) ? -1 : 1);
      const lng = dms(p.slice(nsIdx + 1, ewIdx)) * (/^[Ww]$/.test(p[ewIdx]) ? -1 : 1);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

if (require.main === module) {
  const cache = path.join(__dirname, '..', 'cache', 'wikipedia-bigthings.wikitext');
  const { records, warnings } = extract(fs.readFileSync(cache, 'utf8'));
  const out = path.join(__dirname, '..', 'cache', 'stage-wikipedia.json');
  fs.writeFileSync(out, JSON.stringify(records, null, 1));
  const byState = {};
  for (const r of records) byState[r.state] = (byState[r.state] || 0) + 1;
  console.log('records:', records.length);
  console.log('by state:', byState);
  console.log('with size:', records.filter((r) => r.heightM).length);
  console.log('with year:', records.filter((r) => r.builtYear).length);
  console.log('with own article:', records.filter((r) => r.articleTitle).length);
  console.log('non-standing:', records.filter((r) => r.status !== 'standing').length);
  const cats = {};
  for (const r of records) cats[r.category] = (cats[r.category] || 0) + 1;
  console.log('categories:', cats);
  if (warnings.length) console.log('warnings:', warnings);
}

module.exports = { extract, parseCoordTemplate, STATE_CODES };
