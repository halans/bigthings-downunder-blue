'use strict';
/**
 * Minimal, dependency-free wikitext helpers: table splitting, template-aware
 * cell splitting, link extraction, and plain-text rendering.
 *
 * These are deliberately narrow — they handle the constructs that actually
 * appear in the source pages (see docs/BUILDING.md), not all of wikitext.
 */

/** Split a page into `=== Heading ===` sections at the given depth. */
function sectionsByHeading(wikitext, depth = 3) {
  const marker = '='.repeat(depth);
  const re = new RegExp(`^${marker}([^=].*?)${marker}\\s*$`, 'gm');
  const out = [];
  let m;
  const hits = [];
  while ((m = re.exec(wikitext)) !== null) {
    hits.push({ title: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : wikitext.length;
    out.push({ title: hits[i].title, body: wikitext.slice(hits[i].bodyStart, end) });
  }
  return out;
}

/** Extract every `{| ... |}` table body from a chunk of wikitext. */
function extractTables(wikitext) {
  const tables = [];
  let depth = 0;
  let start = -1;
  const lines = wikitext.split('\n');
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{|')) {
      depth++;
      if (depth === 1) { start = 0; buf = []; continue; }
    }
    if (t === '|}' || t.startsWith('|}')) {
      depth--;
      if (depth === 0) { tables.push(buf.join('\n')); buf = []; start = -1; continue; }
    }
    if (depth >= 1) buf.push(line);
  }
  return tables;
}

/**
 * Parse a table body into rows of raw cell wikitext.
 * Handles multi-line cells and `||` inline separators, while respecting
 * template/link nesting so `{{convert|7|*|4|m}}` is never split.
 */
function parseRows(tableBody) {
  const rawRows = [];
  let current = null;
  for (const line of tableBody.split('\n')) {
    const t = line.replace(/\s+$/, '');
    if (t.trim().startsWith('|-')) {
      if (current) rawRows.push(current);
      current = { header: false, cellLines: [] };
      continue;
    }
    if (current === null) continue;
    if (/^\s*!/.test(t)) { current.header = true; current.cellLines.push(t); continue; }
    current.cellLines.push(t);
  }
  if (current) rawRows.push(current);

  return rawRows.map((row) => {
    const cells = [];
    let cur = null;
    for (const line of row.cellLines) {
      const isNew = /^\s*[|!]/.test(line) && !/^\s*\|\}/.test(line);
      if (isNew) {
        const body = line.replace(/^\s*[|!]+/, '');
        for (const piece of splitInline(body, row.header ? '!!' : '||')) {
          if (cur !== null) cells.push(cur);
          cur = piece;
        }
      } else if (cur !== null) {
        cur += '\n' + line;
      }
    }
    if (cur !== null) cells.push(cur);
    return { header: row.header, cells: cells.map(stripCellAttrs) };
  }).filter((r) => r.cells.length > 0);
}

/** Split on a separator only at nesting depth zero. */
function splitInline(str, sep) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.startsWith('{{', i) || str.startsWith('[[', i)) { depth++; i++; continue; }
    if (str.startsWith('}}', i) || str.startsWith(']]', i)) { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && str.startsWith(sep, i)) {
      out.push(str.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
    }
  }
  out.push(str.slice(last));
  return out;
}

/** Drop leading `style="..."|` style attributes from a cell. */
function stripCellAttrs(cell) {
  const m = /^\s*((?:[a-zA-Z-]+\s*=\s*"[^"]*"\s*)+)\|(?!\|)/.exec(cell);
  return (m ? cell.slice(m[0].length) : cell).trim();
}

/** Find balanced `{{name|...}}` templates by name (case-insensitive). */
function findTemplates(wikitext, name) {
  const out = [];
  const lower = wikitext.toLowerCase();
  const needle = '{{' + name.toLowerCase();
  let idx = 0;
  while ((idx = lower.indexOf(needle, idx)) !== -1) {
    const after = wikitext[idx + needle.length];
    if (after !== '|' && after !== '}' && !/\s/.test(after || '')) { idx += needle.length; continue; }
    let depth = 0;
    let end = -1;
    for (let i = idx; i < wikitext.length; i++) {
      if (wikitext.startsWith('{{', i)) { depth++; i++; continue; }
      if (wikitext.startsWith('}}', i)) { depth--; i++; if (depth === 0) { end = i + 1; break; } continue; }
    }
    if (end === -1) break;
    const inner = wikitext.slice(idx + 2, end - 2);
    out.push({ raw: wikitext.slice(idx, end), params: splitInline(inner, '|').slice(1).map((s) => s.trim()) });
    idx = end;
  }
  return out;
}

/** All `[[Target|label]]` link targets in order. */
function links(wikitext) {
  const out = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
  let m;
  while ((m = re.exec(wikitext)) !== null) {
    const target = m[1].trim();
    if (/^(File|Image|Category):/i.test(target)) continue;
    out.push({ target: target.replace(/^\.\//, ''), label: (m[2] || target).trim() });
  }
  return out;
}

/** `[[File:Foo.jpg|220px]]` → `Foo.jpg` */
function fileNames(wikitext) {
  const out = [];
  const re = /\[\[(?:File|Image):([^\]|]+)/gi;
  let m;
  while ((m = re.exec(wikitext)) !== null) out.push(m[1].trim().replace(/_/g, ' '));
  return out;
}

/** Render wikitext to readable plain text, dropping refs/templates/markup. */
function toPlainText(wikitext) {
  let s = wikitext;
  s = s.replace(/<ref[^>]*\/>/gi, '');
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // convert / cvt → "7 × 4 m"
  s = replaceTemplates(s, ['convert', 'cvt'], (params) => {
    const nums = [];
    for (const p of params) {
      if (/^[\d.,]+$/.test(p)) nums.push(p);
      else if (p === '*' || p === 'x' || p === 'by') nums.push('×');
      else break;
    }
    const unit = params.find((p) => /^(m|ft|cm|km|mm|in|kg|t|lb)$/.test(p)) || '';
    return (nums.join(' ') + ' ' + unit).trim();
  });
  s = replaceTemplates(s, ['as of'], (p) => 'As of ' + p.filter((x) => !x.includes('=')).join(' '));
  s = replaceTemplates(s, ['citation needed', 'cn'], () => '');
  s = replaceTemplates(s, ['coord'], () => '');
  s = s.replace(/\{\{[^{}]*\}\}/g, '');
  s = s.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '');
  s = s.replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/\[(?:https?:)\/\/\S+\s+([^\]]+)\]/g, '$1');
  s = s.replace(/\[(?:https?:)\/\/\S+\]/g, '');
  s = s.replace(/'''([^']+)'''/g, '$1');
  s = s.replace(/''([^']+)''/g, '$1');
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;/g, '–').replace(/&quot;/g, '"');
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  s = s.replace(/\s+([,.;:])/g, '$1');
  return s.trim();
}

function replaceTemplates(str, names, fn) {
  let out = str;
  for (const name of names) {
    for (const t of findTemplates(out, name)) {
      out = out.split(t.raw).join(fn(t.params));
    }
  }
  return out;
}

module.exports = {
  sectionsByHeading, extractTables, parseRows, splitInline,
  findTemplates, links, fileNames, toPlainText,
};
