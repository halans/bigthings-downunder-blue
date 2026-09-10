#!/usr/bin/env node
'use strict';
/**
 * `bigthings` — query the same dataset the map renders, from a terminal.
 *
 * This is a thin surface over src/query.js, which the web app's filter logic
 * mirrors field-for-field. test/equivalence.test.js diffs the two for the same
 * inputs so the CLI and the map can never disagree about what matches.
 *
 * Exit codes:  0 results found · 1 no results · 2 usage error
 */

const fs = require('fs');
const path = require('path');
const Q = require('./query');

const DATASET = path.join(__dirname, '..', 'data', 'bigthings.json');

const USAGE = `bigthings — Australia's giant roadside sculptures, from the command line

USAGE
  bigthings [query] [options]

OPTIONS
  -s, --state <ST>        ACT NSW NT QLD SA TAS VIC WA (repeatable)
  -c, --category <CAT>    fruit-and-veg fauna seafood food-and-drink
                          machinery-and-transport tools-and-industry
                          sport-and-leisure people-and-culture oddity
                          sculpture
      --status <S>        standing demolished removed relocated replaced
      --era <E>           pioneer boom late-century revival modern unknown
      --exact-only        only pins located to the sculpture, not the town
      --gone              only the demolished / removed ones
      --near <lat,lng>    sort by distance from a point
      --within <km>       with --near, keep only things inside this radius
  -l, --limit <n>         cap results (default 40, 0 = all)
      --sort <field>      name | year | size | state | distance
  -f, --format <fmt>      table | json | csv | geojson | tsv
      --stats             print dataset statistics instead of rows
      --sources           include source URLs in table output
  -h, --help              this text

EXAMPLES
  bigthings prawn
  bigthings --state QLD --category seafood
  bigthings --near -33.87,151.21 --within 300 --sort distance
  bigthings --gone --format csv > lost-big-things.csv
  bigthings --stats
`;

function parseArgs(argv) {
  const o = { terms: [], states: [], cats: [], statuses: [], eras: [], limit: 40, sort: null, format: 'table' };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) { throw new UsageError(`${flag} needs a value`); }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-s': case '--state': o.states.push(need(i, a).toUpperCase()); i++; break;
      case '-c': case '--category': o.cats.push(need(i, a).toLowerCase()); i++; break;
      case '--status': o.statuses.push(need(i, a).toLowerCase()); i++; break;
      case '--era': o.eras.push(need(i, a).toLowerCase()); i++; break;
      case '--exact-only': o.exactOnly = true; break;
      case '--gone': o.gone = true; break;
      case '--near': o.near = need(i, a); i++; break;
      case '--within': o.within = Number(need(i, a)); i++; break;
      case '-l': case '--limit': o.limit = Number(need(i, a)); i++; break;
      case '--sort': o.sort = need(i, a).toLowerCase(); i++; break;
      case '-f': case '--format': o.format = need(i, a).toLowerCase(); i++; break;
      case '--stats': o.stats = true; break;
      case '--sources': o.sources = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
        o.terms.push(a);
    }
  }
  if (o.near) {
    const m = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(o.near);
    if (!m) throw new UsageError('--near expects lat,lng (e.g. -33.87,151.21)');
    o.near = { lat: Number(m[1]), lng: Number(m[2]) };
  }
  if (o.within !== undefined && !o.near) throw new UsageError('--within requires --near');
  if (!Number.isFinite(o.limit) || o.limit < 0) throw new UsageError('--limit expects a non-negative number');
  if (!['table', 'json', 'csv', 'geojson', 'tsv'].includes(o.format)) throw new UsageError(`unknown format: ${o.format}`);
  if (o.sort && !['name', 'year', 'size', 'state', 'distance'].includes(o.sort)) throw new UsageError(`unknown sort: ${o.sort}`);
  return o;
}

class UsageError extends Error {}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function renderTable(rows, opts) {
  if (!rows.length) return 'No big things match.';
  const lines = [];
  for (const t of rows) {
    const bits = [];
    if (t.builtYear) bits.push(String(t.builtYear));
    if (t.sizeRaw) bits.push(t.sizeRaw);
    if (t.status !== 'standing') bits.push(t.status.toUpperCase());
    if (t.precision === 'town') bits.push('town-level pin');
    if (t._km !== undefined) bits.push(`${Math.round(t._km)} km away`);
    lines.push(`${t.name}`);
    lines.push(`  ${[t.location, t.state].filter(Boolean).join(', ')}${bits.length ? '  ·  ' + bits.join(' · ') : ''}`);
    if (t.lat != null) lines.push(`  ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}  (${t.precision})`);
    if (opts.sources) lines.push(`  ${t.sources.map((s) => s.url).filter(Boolean).join('  ')}`);
    lines.push('');
  }
  lines.push(`${rows.length} shown.`);
  return lines.join('\n');
}

function render(rows, opts, dataset) {
  switch (opts.format) {
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'geojson':
      return JSON.stringify({
        type: 'FeatureCollection',
        features: rows.filter((t) => t.lat != null).map((t) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
          properties: { ...t, _km: undefined },
        })),
      }, null, 2);
    case 'csv': case 'tsv': {
      const sep = opts.format === 'csv' ? ',' : '\t';
      const cols = ['id', 'name', 'state', 'location', 'lat', 'lng', 'precision', 'builtYear', 'sizeRaw', 'category', 'status'];
      const esc = opts.format === 'csv' ? csvCell : (v) => String(v == null ? '' : v).replace(/[\t\n]/g, ' ');
      return [cols.join(sep), ...rows.map((t) => cols.map((c) => esc(t[c])).join(sep))].join('\n');
    }
    default:
      return renderTable(rows, opts);
  }
}

function renderStats(dataset) {
  const s = dataset.meta.stats;
  const pad = (k) => String(k).padEnd(26);
  const out = [
    `Big Things dataset — built ${dataset.meta.generated}`,
    '',
    `${pad('mapped here')}${s.total}`,
    `${pad('claimed nationally')}${dataset.meta.claimedNationalTotal}  (${dataset.meta.claimedTotalSource})`,
    `${pad('placed on the map')}${s.mapped}`,
    `${pad('located to the sculpture')}${s.total - (s.byPrecision.town || 0)}`,
    `${pad('located to the town only')}${s.byPrecision.town || 0}`,
    '',
    'By state', ...Object.entries(s.byState).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${pad(k)}${v}`),
    '', 'By category', ...Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${pad(k)}${v}`),
    '', 'By status', ...Object.entries(s.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${pad(k)}${v}`),
    '', 'Sources', ...dataset.meta.sources.map((x) => `  ${x.name} — ${x.licence}`),
  ];
  return out.join('\n');
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`bigthings: ${e.message}\n\n${USAGE}`); return 2; }
    throw e;
  }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (!fs.existsSync(DATASET)) {
    process.stderr.write(`bigthings: data/bigthings.json not found — run \`npm run build\` first\n`);
    return 2;
  }
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));

  if (opts.stats) { process.stdout.write(renderStats(dataset) + '\n'); return 0; }

  const rows = Q.query(dataset.things, {
    q: opts.terms.join(' '),
    states: opts.states, cats: opts.cats, statuses: opts.statuses, eras: opts.eras,
    exactOnly: !!opts.exactOnly, goneOnly: !!opts.gone,
    near: opts.near, within: opts.within,
    sort: opts.sort, limit: opts.limit,
  });
  process.stdout.write(render(rows, opts, dataset) + '\n');
  return rows.length ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, render, renderStats, USAGE, UsageError };
