'use strict';
/** Unit tests for the wikitext parser and the domain normalisers. */

const { test, eq, ok } = require('./run');
const W = require('../src/wikitext');
const N = require('../src/normalise');
const { parseCoordTemplate } = require('../src/extract-wikipedia');

/* ---------- wikitext ---------- */

test('splits a simple table into rows and cells', () => {
  const table = `|-\n! Name\n! Location\n|-\n|Big Banana\n|Coffs Harbour\n|-\n|Big Prawn\n|Ballina`;
  const rows = W.parseRows(table);
  eq(rows.length, 3);
  eq(rows[0].header, true);
  eq(rows[1].cells, ['Big Banana', 'Coffs Harbour']);
  eq(rows[2].cells, ['Big Prawn', 'Ballina']);
});

test('does not split inside a template or a wikilink', () => {
  const table = `|-\n|Big Thing\n|{{convert|7|*|4|m|ft|abbr=on}}\n|[[Town, State|Town]]`;
  const cells = W.parseRows(table)[0].cells;
  eq(cells.length, 3);
  eq(cells[1], '{{convert|7|*|4|m|ft|abbr=on}}');
  eq(cells[2], '[[Town, State|Town]]');
});

test('handles inline || separators and multi-line cells', () => {
  const table = `|-\n|A||B\n|C\ncontinued`;
  const cells = W.parseRows(table)[0].cells;
  eq(cells, ['A', 'B', 'C\ncontinued']);
});

test('strips cell style attributes', () => {
  const table = `|-\n| style="width:20%;"| Name\n|Value`;
  eq(W.parseRows(table)[0].cells, ['Name', 'Value']);
});

test('finds a template even when a newline follows its name', () => {
  const t = W.findTemplates('* {{see\n| name=Big Ant | lat=-31.9 | long=141.4\n}}', 'see');
  eq(t.length, 1);
  ok(t[0].params.some((p) => p.startsWith('name=Big Ant')), 'name param present');
});

test('extracts links but skips files and categories', () => {
  const l = W.links('[[Big Banana]] at [[Coffs Harbour|the harbour]] [[File:X.jpg|thumb]] [[Category:Y]]');
  eq(l.map((x) => x.target), ['Big Banana', 'Coffs Harbour']);
  eq(l[1].label, 'the harbour');
});

test('renders wikitext to clean plain text', () => {
  const src = "The '''Big Thing''' is {{convert|13|*|5|m|ft|abbr=on}} tall<ref>{{cite web|url=http://x}}</ref> in [[Coffs Harbour]].{{Citation needed|date=2020}}";
  const text = W.toPlainText(src);
  ok(!text.includes('ref'), 'refs removed');
  ok(!text.includes('{{'), 'templates removed');
  ok(text.includes('Coffs Harbour'), 'link label kept');
  ok(text.includes('13 × 5 m'), `convert rendered, got: ${text}`);
});

test('extracts file names from image cells', () => {
  eq(W.fileNames('[[File:Big_Banana.jpg|220px]]'), ['Big Banana.jpg']);
});

/* ---------- sizes ---------- */

test('parses a convert template into metres', () => {
  const s = N.parseSize('{{convert|13|*|5|m|ft|abbr=on}}');
  eq(s.dimsM, [13, 5]);
  eq(s.sizeMaxM, 13);
});

test('parses feet into metres', () => {
  const s = N.parseSize('{{convert|26|ft|m}}');
  ok(Math.abs(s.dimsM[0] - 7.925) < 0.01, `got ${s.dimsM[0]}`);
});

test('parses a bare dimension string', () => {
  eq(N.parseSize('2.4x3.5 m').dimsM, [2.4, 3.5]);
  eq(N.parseSize('15×18 m').dimsM, [15, 18]);
});

test('treats a lone measurement as a height', () => {
  const s = N.parseSize('{{convert|8|m|ft}}');
  eq(s.heightM, 8);
  eq(s.sizeKind, 'height');
});

test('reads "long" as a length, never a height', () => {
  const s = N.parseSize('119 m long');
  eq(s.sizeKind, 'length');
  eq(s.lengthM, 119);
  eq(s.heightM, null);
});

test('a 250 m × 4 m worm is not 250 m tall', () => {
  const s = N.parseSize('{{convert|250|*|4|m|ft|abbr=on}}');
  eq(s.sizeKind, 'dimensions');
  eq(s.heightM, null, 'refuses to claim a height from ambiguous dimensions');
  eq(s.sizeMaxM, 250);
});

test('respects an explicit "tall"', () => {
  const s = N.parseSize('3 m tall.');
  eq(s.heightM, 3);
  eq(s.sizeKind, 'height');
});

test('prefers the metric value in a parenthetical', () => {
  const s = N.parseSize('10-foot-high (3.0 m)');
  eq(s.heightM, 3);
});

test('returns empty for an empty size cell', () => {
  const s = N.parseSize('');
  eq(s.dimsM, []);
  eq(s.heightM, null);
  eq(s.sizeMaxM, null);
});

/* ---------- years ---------- */

test('parses a plain year', () => { eq(N.parseBuilt('1964').year, 1964); });
test('takes the first year of a range', () => { eq(N.parseBuilt('1915–1916').year, 1915); });
test('flags circa dates', () => {
  const b = N.parseBuilt('c. 2014.');
  eq(b.year, 2014);
  eq(b.circa, true);
});
test('ignores a non-year number', () => { eq(N.parseBuilt('unknown').year, null); });

/* ---------- status ---------- */

test('detects demolition and keeps the evidence', () => {
  const s = N.inferStatus('A fine sculpture. The Big Bull was pulled down in October 2007.');
  eq(s.status, 'demolished');
  ok(s.evidence.includes('pulled down'), 'evidence retained');
});

test('detects removal', () => {
  eq(N.inferStatus('As of 2015, the Yabby is no longer there.').status, 'removed');
});

test('detects relocation', () => {
  eq(N.inferStatus('In 2007 the Merino was relocated 800 metres.').status, 'relocated');
});

test('defaults to standing with no evidence', () => {
  const s = N.inferStatus('A banana-themed souvenir shop is on site.');
  eq(s.status, 'standing');
  eq(s.evidence, null);
});

test('prefers demolition over a mere rebuild mention', () => {
  eq(N.inferStatus('It was refurbished in 2001. It was demolished in 2020.').status, 'demolished');
});

/* ---------- classification ---------- */

test('classifies by subject', () => {
  eq(N.classify('Big Banana', ''), 'fruit-and-veg');
  eq(N.classify('Big Prawn', ''), 'seafood');
  eq(N.classify('The Big Merino', ''), 'fauna');
  eq(N.classify('Big Tractor', ''), 'machinery-and-transport');
  eq(N.classify('The Big Golden Guitar', ''), 'people-and-culture');
  eq(N.classify('Big Tennis Racquet', ''), 'sport-and-leisure');
  eq(N.classify('The Big Axe', ''), 'tools-and-industry');
  eq(N.classify('Big Beer Can', ''), 'food-and-drink');
});

test('falls back to oddity for the unclassifiable', () => {
  eq(N.classify('Big Zorgle', 'A mysterious shape.'), 'oddity');
});

test('buckets eras', () => {
  eq(N.era(1964), 'pioneer (pre-1970)');
  eq(N.era(1977), 'boom (1970s–early 80s)');
  eq(N.era(1990), 'late century (1985–1999)');
  eq(N.era(2009), 'revival (2000s–2014)');
  eq(N.era(2022), 'modern (2015+)');
  eq(N.era(null), 'unknown');
});

test('slugs names for dedup, dropping leading articles', () => {
  eq(N.slugName('The Big Merino'), 'big merino');
  eq(N.slugName('Big  Merino'), 'big merino');
});

/* ---------- coordinates ---------- */

test('parses a decimal coord template', () => {
  eq(parseCoordTemplate(['-33.86', '151.21']), { lat: -33.86, lng: 151.21 });
});

test('parses a DMS coord template with hemispheres', () => {
  const c = parseCoordTemplate(['33', '52', 'S', '151', '12', 'E']);
  ok(Math.abs(c.lat + 33.8667) < 0.01, `lat ${c.lat}`);
  ok(Math.abs(c.lng - 151.2) < 0.01, `lng ${c.lng}`);
});

test('returns null for junk', () => {
  eq(parseCoordTemplate(['display=inline']), null);
});

test('detects a sculpture that was disassembled', () => {
  // The Big Redback: "The business has since moved to Underwood and
  // disassembled the Big Redback… unlikely to be reassembled."
  const s = N.inferStatus('The business has since moved to Underwood and disassembled the Big Redback.');
  eq(s.status, 'removed');
  ok(s.evidence.includes('disassembled'), 'evidence retained');
});

test('a sculpture put into storage is not still standing', () => {
  eq(N.inferStatus('It was taken apart in 2019 and put into storage.').status, 'removed');
});

test('"has since" is adverbial, not a clause boundary', () => {
  // Cutting at "since" here discards the only word that says it is gone.
  const s = N.inferStatus('The business has since moved to Underwood and disassembled the Big Redback.');
  eq(s.status, 'removed');
});

test('a genuine subordinate clause is still trimmed', () => {
  // The Hawaiian water tower, not our pineapple.
  const s = N.inferStatus("It is claimed to be the world's largest pineapple, gaining this title after a water tower in Hawaii was dismantled in 1993.");
  eq(s.status, 'standing');
});

test('"since" as a real subordinator is still trimmed', () => {
  const s = N.inferStatus('The site has been vacant since the shed was demolished.');
  eq(s.status, 'standing', 'the demolished shed is not our big thing');
});
