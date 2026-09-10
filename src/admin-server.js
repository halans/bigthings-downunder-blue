'use strict';
/**
 * Local-only admin UI for hand-editing records: fix a field, pin a better
 * lat/lng, or attach your own photo — all in a way that survives the next
 * `npm run build` instead of being silently overwritten by it.
 *
 * This is not part of the app. It never ships: nothing here is read by
 * src/build-web.js, src/build-about.js or src/build-public.js, it isn't in
 * web/ or public/, and it's deliberately bound to 127.0.0.1 so it isn't
 * reachable from anything but this machine. See docs/ADMIN.md.
 *
 * Every write goes through the same mechanism a human editor already uses:
 * data/overrides.json (see src/build.js's applyOverrides/applyAdditions) and,
 * for photos, data/custom-photos.json (see src/image-credits.js). Nothing
 * bypasses that — this UI just saves you hand-editing JSON and remembering
 * the id.
 *
 *   node src/admin-server.js [--port 8098]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const N = require('./normalise');
const { stableId } = require('./build');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');
const CUSTOM_IMG_DIR = path.join(WEB, 'img', 'custom');
const UI_PATH = path.join(__dirname, 'admin-ui.html');

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 8098;
})();

/** Vocabularies the UI renders as dropdowns — one place, so they can't drift. */
const META = {
  states: ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'],
  categories: [
    'fruit-and-veg', 'fauna', 'seafood', 'food-and-drink', 'machinery-and-transport',
    'tools-and-industry', 'sport-and-leisure', 'people-and-culture', 'oddity',
  ],
  statuses: ['standing', 'demolished', 'removed', 'relocated', 'replaced'],
  precisions: ['exact-article', 'exact-wikivoyage', 'exact-osm', 'exact-verified', 'exact-inline', 'town', 'none'],
  editableFields: [
    'name', 'state', 'stateName', 'location', 'town', 'lat', 'lng', 'precision', 'coordSource',
    'builtYear', 'builtRaw', 'category', 'status', 'notes', 'blurb',
  ],
  // additions[] (a brand-new record — see applyAdditions() in src/build.js)
  // takes a slightly different shape than a correction's `set`: no id, no
  // stateName/blurb, plus heightM/sizeRaw which a correction doesn't use.
  additionFields: [
    'name', 'state', 'location', 'town', 'lat', 'lng', 'precision', 'coordSource',
    'builtYear', 'heightM', 'sizeRaw', 'category', 'status', 'notes',
  ],
};

const STATE_NAMES = {
  ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory',
  QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
};

const readJSON = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 1));

function loadDataset() {
  return readJSON(path.join(DATA, 'bigthings.json'), { things: [] });
}

function searchThings(query) {
  const dataset = loadDataset();
  const q = (query || '').trim().toLowerCase();
  const rows = q
    ? dataset.things.filter((t) => [t.name, t.town, t.location, t.state, t.stateName]
      .filter(Boolean).join(' ').toLowerCase().includes(q))
    : dataset.things;
  return rows.slice(0, 60).map((t) => ({
    id: t.id, name: t.name, state: t.state, town: t.town, location: t.location,
    lat: t.lat, lng: t.lng, precision: t.precision, status: t.status, image: t.image,
    hasOverride: false,
  }));
}

function findThing(id) {
  return loadDataset().things.find((t) => t.id === id) || null;
}

function loadOverrides() {
  return readJSON(path.join(DATA, 'overrides.json'), { _readme: '', corrections: [], additions: [], removals: [] });
}

function existingCorrection(id) {
  const o = loadOverrides();
  return (o.corrections || []).find((c) => c.match && c.match.id === id) || null;
}

/** Add or merge a correction for `id`. Every write needs a `why` — no exceptions. */
function upsertCorrection(id, set, why, source) {
  if (!why || !why.trim()) throw new Error('a reason ("why") is required for every manual correction');
  const o = loadOverrides();
  o.corrections = o.corrections || [];
  const idx = o.corrections.findIndex((c) => c.match && c.match.id === id);
  if (idx >= 0) {
    o.corrections[idx].set = { ...o.corrections[idx].set, ...set };
    o.corrections[idx].why = why;
    if (source) o.corrections[idx].source = source;
  } else {
    o.corrections.push({ match: { id }, set, why, source: source || null });
  }
  writeJSON(path.join(DATA, 'overrides.json'), o);
}

/** The same identity key applyAdditions() dedupes new rows against. */
const dedupeKey = (state, name) => `${state}|${N.slugName(name)}`;

/**
 * Add a brand-new record — something in neither wiki list at all — via
 * overrides.json's `additions` array (see applyAdditions() in src/build.js).
 * Its id is generated at build time from state+name+location, the same way
 * every other record's is, so it isn't known until after the rebuild below.
 */
function addNewThing(body) {
  if (!body.name || !body.name.trim()) throw new Error('a name is required');
  if (!META.states.includes(body.state)) throw new Error(`state must be one of ${META.states.join(', ')}`);
  if (!body.why || !body.why.trim()) throw new Error('a reason ("why") is required for every manual addition');

  const name = body.name.trim();
  const state = body.state;
  const key = dedupeKey(state, name);
  const dataset = loadDataset();
  if (dataset.things.some((t) => dedupeKey(t.state, t.name) === key)) {
    throw new Error(`"${name}" already exists in ${state} — edit that record instead of adding a duplicate`);
  }

  const addition = { name, state, why: body.why.trim(), source: body.source || null };
  for (const f of META.additionFields) {
    if (f === 'name' || f === 'state' || body[f] === undefined || body[f] === '') continue;
    addition[f] = (f === 'lat' || f === 'lng' || f === 'builtYear' || f === 'heightM') ? Number(body[f]) : body[f];
  }

  const o = loadOverrides();
  o.additions = o.additions || [];
  o.additions.push(addition);
  writeJSON(path.join(DATA, 'overrides.json'), o);

  const log = rebuild();
  // applyAdditions() silently skips a name+state collision it finds at
  // rebuild time (the guard above only catches one added moments ago) — the
  // same "wrote it but it didn't take" failure mode upsertCorrection's
  // "matched nothing" check exists for. Confirm it's actually there.
  const after = loadDataset();
  const created = after.things.find((t) => dedupeKey(t.state, t.name) === key);
  if (!created) throw new Error(`added, but couldn't find "${name}" in ${state} after rebuild:\n${log}`);
  return { thing: created, log };
}

/**
 * Remove a record from the catalogue — the counterpart to addNewThing().
 *
 * A record you added yourself (`additions[]`) is deleted outright: there's
 * nothing else that would ever recreate it. A harvested record (from
 * Wikipedia or Wikivoyage) can't be deleted at the source — it'll just come
 * back on the next fetch — so this adds a `removals[]` entry instead, same
 * as the hand-written example in docs/ADMIN.md; `applyRemovals()` drops it
 * on every build, and deleting that one entry brings it straight back. A
 * correction sitting on this id is dropped either way, since it would
 * otherwise "match nothing" on the very next build.
 */
function removeThing(id, why, source) {
  if (!why || !why.trim()) throw new Error('a reason ("why") is required to remove a record');
  const thing = findThing(id);
  if (!thing) throw new Error(`no such id: ${id}`);

  const o = loadOverrides();
  o.corrections = o.corrections || [];
  o.additions = o.additions || [];
  o.removals = o.removals || [];

  const additionIdx = thing.addedManually
    ? o.additions.findIndex((a) => stableId(a.state, a.name, a.location) === id)
    : -1;
  if (additionIdx >= 0) {
    o.additions.splice(additionIdx, 1);
  } else {
    o.removals.push({ match: { id }, why: why.trim(), source: source || null });
  }
  o.corrections = o.corrections.filter((c) => !(c.match && c.match.id === id));

  // A custom photo only this record used is now orphaned — clean it up too,
  // unless some other row still points at the same key.
  if (thing.image && thing.image.startsWith('custom:')) {
    const stillUsed = loadDataset().things.some((t) => t.id !== id && t.image === thing.image);
    if (!stillUsed) {
      const store = readJSON(path.join(DATA, 'custom-photos.json'), { images: {} });
      const entry = store.images[thing.image];
      if (entry) {
        delete store.images[thing.image];
        writeJSON(path.join(DATA, 'custom-photos.json'), store);
        const file = path.join(WEB, entry.local);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
  }

  writeJSON(path.join(DATA, 'overrides.json'), o);
  const log = rebuild();
  // Same "wrote it but it didn't take" check as addNewThing() — a removal
  // that silently doesn't apply is worse than one that errors loudly.
  if (loadDataset().things.some((t) => t.id === id)) {
    throw new Error(`removed, but "${thing.name}" (${id}) is still in the dataset after rebuild:\n${log}`);
  }
  return log;
}

/** A filesystem-safe, collision-resistant local name for an uploaded photo. */
function customFileName(thingName, originalName) {
  const ext = (path.extname(originalName || '') || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
  const slug = String(thingName || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = crypto.randomBytes(3).toString('hex');
  return `${slug}-${hash}${ext}`;
}

/**
 * Save an uploaded photo: write the file, record it in custom-photos.json,
 * and point the record's `image` field at it via the same correction
 * mechanism as any other manual edit.
 */
function saveCustomPhoto(id, thing, { filename, dataBase64, author, licence, licenceUrl, sourceUrl }) {
  if (!dataBase64) throw new Error('no photo data received');
  if (!author || !author.trim()) throw new Error('an author/credit is required — even for your own photo, name yourself');
  fs.mkdirSync(CUSTOM_IMG_DIR, { recursive: true });
  const local = customFileName(thing.name, filename);
  const dest = path.join(CUSTOM_IMG_DIR, local);
  fs.writeFileSync(dest, Buffer.from(dataBase64, 'base64'));

  const key = `custom:${local}`;
  const store = readJSON(path.join(DATA, 'custom-photos.json'), { _readme: '', images: {} });
  store.images[key] = {
    local: `img/custom/${local}`,
    author: author.trim(),
    licence: licence && licence.trim() ? licence.trim() : 'All rights reserved',
    licenceUrl: licenceUrl && licenceUrl.trim() ? licenceUrl.trim() : null,
    // Where the card's "via <site>" link on the map points — your own
    // portfolio, a gallery page, wherever the photo can actually be seen in
    // context. Left blank, the card just names the photographer with no
    // "via" clause; it never claims Wikimedia Commons for a photo that isn't.
    filePage: sourceUrl && sourceUrl.trim() ? sourceUrl.trim() : null,
  };
  writeJSON(path.join(DATA, 'custom-photos.json'), store);

  upsertCorrection(id, { image: key }, `Photo added by hand via the local admin UI, replacing whatever (if anything) was there.`, null);
  return key;
}

/** Regenerate the dataset and the two pages. Same three steps as `npm run build`, minus the network-touching extract stage. */
function rebuild() {
  const steps = ['src/build.js', 'src/build-web.js', 'src/build-about.js'];
  const log = [];
  for (const step of steps) {
    log.push(`$ node ${step}`);
    // stderr matters as much as stdout here: build.js warns to stderr (not
    // an exception) when a correction's match hits nothing, which otherwise
    // fails silently — a correction that's quietly never applied is worse
    // than one that errors loudly. spawnSync (unlike execFileSync) hands
    // back stderr even on a clean exit.
    const r = spawnSync('node', [step], { cwd: ROOT, encoding: 'utf8' });
    if (r.stdout) log.push(r.stdout.trim());
    if (r.stderr) log.push(r.stderr.trim());
    if (r.status !== 0) throw new Error(`${step} failed (exit ${r.status}):\n${log.join('\n')}`);
    // "matched nothing" is the one failure mode this whole tool exists to
    // prevent — a correction that silently never applies. Fail loudly.
    if (/matched nothing/.test(r.stderr || '')) {
      throw new Error(`the correction just saved didn't match anything and was NOT applied:\n${log.join('\n')}`);
    }
  }
  return log.join('\n');
}

function send(res, status, body, contentType) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  // No caching, anywhere: this page and its data change on every save, and a
  // browser tab left open across an edit to admin-ui.html has no other way
  // to notice it's running stale JS — a save that silently does nothing is
  // a much worse failure than a page that never caches.
  res.writeHead(status, { 'Content-Type': contentType || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(UI_PATH, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      return send(res, 200, META);
    }
    if (req.method === 'GET' && url.pathname === '/api/things') {
      return send(res, 200, searchThings(url.searchParams.get('q')));
    }
    if (req.method === 'POST' && url.pathname === '/api/things') {
      const body = JSON.parse(await readBody(req));
      const { thing, log } = addNewThing(body);
      return send(res, 200, { ok: true, thing, log });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/things/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/things/'.length));
      const thing = findThing(id);
      if (!thing) return send(res, 404, { error: 'no such id' });
      return send(res, 200, { thing, override: existingCorrection(id) });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/things/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/things/'.length));
      const thing = findThing(id);
      if (!thing) return send(res, 404, { error: 'no such id' });
      const body = JSON.parse(await readBody(req));
      const set = {};
      for (const f of META.editableFields) {
        if (body[f] === undefined || body[f] === '') continue;
        set[f] = (f === 'lat' || f === 'lng' || f === 'builtYear') ? Number(body[f]) : body[f];
      }
      if (set.state && !set.stateName) set.stateName = STATE_NAMES[set.state];
      upsertCorrection(id, set, body.why, body.source);
      const log = rebuild();
      return send(res, 200, { ok: true, log });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/things\/[^/]+\/photo$/)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const thing = findThing(id);
      if (!thing) return send(res, 404, { error: 'no such id' });
      const body = JSON.parse(await readBody(req));
      const key = saveCustomPhoto(id, thing, body);
      const log = rebuild();
      return send(res, 200, { ok: true, key, log });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/things\/[^/]+\/remove$/)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = JSON.parse(await readBody(req));
      const log = removeThing(id, body.why, body.source);
      return send(res, 200, { ok: true, log });
    }
    if (req.method === 'GET' && url.pathname === '/api/overrides') {
      return send(res, 200, loadOverrides().corrections || []);
    }
    if (req.method === 'POST' && url.pathname === '/api/rebuild') {
      return send(res, 200, { ok: true, log: rebuild() });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`admin UI — http://127.0.0.1:${port}`);
  console.log('Local only. This is not part of the app and is never deployed — see docs/ADMIN.md.');
});
