'use strict';
/**
 * Extract `{{see|name=…|address=…|lat=…|long=…|content=…}}` listings and bare
 * bullet entries from the cached Wikivoyage page. Wikivoyage supplies precise
 * surveyed coordinates for its numbered markers, and travel-guide voice for
 * the ones it bothered to write up.
 */

const fs = require('fs');
const path = require('path');
const W = require('./wikitext');
const N = require('./normalise');

const STATE_HEADINGS = {
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
  const records = [];
  for (const section of W.sectionsByHeading(wikitext, 2)) {
    const state = STATE_HEADINGS[section.title];
    if (!state) continue;

    for (const t of W.findTemplates(section.body, 'see')) {
      const kv = {};
      for (const p of t.params) {
        const i = p.indexOf('=');
        if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
      }
      if (!kv.name) continue;
      const lat = parseFloat(kv.lat);
      const lng = parseFloat(kv.long !== undefined ? kv.long : kv.lon);
      records.push({
        name: W.toPlainText(kv.name),
        state,
        address: kv.address ? W.toPlainText(kv.address) : null,
        addressLinks: kv.address ? W.links(kv.address).map((l) => l.target) : [],
        coords: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
        blurb: kv.content ? W.toPlainText(kv.content) || null : null,
        url: kv.url || null,
      });
    }

    // Plain bullets: "- Big Cheese, Bodalla." (no marker template)
    for (const line of section.body.split('\n')) {
      const m = /^\*\s*(?!\{\{)([^,.]+?)(?:,\s*([^.]+))?\.?\s*$/.exec(line.trim());
      if (!m) continue;
      const name = W.toPlainText(m[1]);
      if (!/^(the\s+)?(big|giant|world|large)/i.test(name)) continue;
      records.push({
        name,
        state,
        address: m[2] ? W.toPlainText(m[2]) : null,
        addressLinks: m[2] ? W.links(m[2]).map((l) => l.target) : [],
        coords: null,
        blurb: null,
        url: null,
      });
    }
  }

  // Dedup within Wikivoyage, preferring the record that carries coordinates.
  const byKey = new Map();
  for (const r of records) {
    const key = `${r.state}|${N.slugName(r.name)}|${N.slugPlace(r.address || '')}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.coords && r.coords) || (!prev.blurb && r.blurb)) {
      byKey.set(key, { ...prev, ...r, coords: r.coords || (prev && prev.coords) || null, blurb: r.blurb || (prev && prev.blurb) || null });
    }
  }
  return [...byKey.values()];
}

if (require.main === module) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cache', 'wikivoyage-bigthings.wikitext'), 'utf8');
  const records = extract(src);
  fs.writeFileSync(path.join(__dirname, '..', 'cache', 'stage-wikivoyage.json'), JSON.stringify(records, null, 1));
  console.log('wikivoyage records:', records.length);
  console.log('with coords:', records.filter((r) => r.coords).length);
  console.log('with blurb:', records.filter((r) => r.blurb).length);
  const byState = {};
  for (const r of records) byState[r.state] = (byState[r.state] || 0) + 1;
  console.log(byState);
}

module.exports = { extract };
