/**
 * Posts one random Big Thing to Bluesky, once a day.
 *
 * Reads data/bigthings.json and the two photo-credit files straight from
 * GitHub's raw content — not bundled into the Worker — so a new correction
 * or a new record shows up here without ever redeploying this script.
 *
 * State (which things have already been posted this cycle, and whether
 * today's post already went out) lives in a single Workers KV namespace —
 * see wrangler.toml.
 *
 * Required secrets (wrangler secret put <name>):
 *   BSKY_IDENTIFIER   — your handle, e.g. bigthings.bsky.social
 *   BSKY_APP_PASSWORD — an app password from Bluesky settings, NOT your main
 *                       account password (Settings → App Passwords)
 *   TRIGGER_SECRET    — any random string, used to gate the manual /?key=
 *                       test endpoint below
 */

const REPO = 'halans/bigthings-downunder-blue';
const BRANCH = 'master';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const SITE = 'https://bigthings.downunder.blue';
const BSKY = 'https://bsky.social/xrpc';
const MAX_GRAPHEMES = 300;

const isGone = (t) => t.status === 'demolished' || t.status === 'removed';

async function fetchJson(url) {
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

/** Grapheme count via code-point iteration — an approximation (a combined
 * emoji sequence counts as more than one), but close enough for plain-text
 * captions, and cheap without pulling in Intl.Segmenter. */
const graphemeLength = (s) => [...s].length;
const utf8Length = (s) => new TextEncoder().encode(s).length;

function buildCaption(t) {
  const place = [t.town || t.location, t.stateName].filter(Boolean).join(', ');
  const desc = (t.blurb || t.notes || '').trim();
  const link = `${SITE}/#thing=${t.id}`;
  const linkLine = `\n\n${link}`;
  let head = `${t.name} — ${place}`;
  let body = desc ? `\n\n${desc}` : '';
  const budget = MAX_GRAPHEMES - graphemeLength(linkLine);
  let text = head + body;
  if (graphemeLength(text) > budget) {
    // Trim the description first, then the head, if it's somehow still long.
    const headLen = graphemeLength(head);
    const bodyBudget = Math.max(0, budget - headLen - 1);
    const chars = [...body];
    body = bodyBudget < chars.length ? chars.slice(0, bodyBudget).join('') + '…' : body;
    text = head + body;
    if (graphemeLength(text) > budget) text = [...text].slice(0, budget - 1).join('') + '…';
  }
  return { text: text + linkLine, link };
}

/** A clickable link needs a "facet" spanning its UTF-8 byte range — Bluesky
 * does not auto-linkify plain text the way some other networks do. */
function buildFacets(fullText, link) {
  const idx = fullText.lastIndexOf(link);
  if (idx === -1) return undefined;
  const byteStart = utf8Length(fullText.slice(0, idx));
  const byteEnd = byteStart + utf8Length(link);
  return [{
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
  }];
}

function altText(t, credits) {
  const c = credits[t.image] || {};
  const where = t.town || t.location || t.stateName;
  const credit = c.author ? ` Photo: ${c.author}${c.licence ? ` (${c.licence})` : ''}.` : '';
  return `${t.name}, ${where}.${credit}`;
}

async function alreadyPostedToday(env) {
  const today = new Date().toISOString().slice(0, 10);
  const last = await env.POSTED.get('lastDate');
  if (last === today) return true;
  await env.POSTED.put('lastDate', today);
  return false;
}

/**
 * Cycles through every eligible thing before repeating any of them, tracked
 * as a plain list of already-posted ids in KV. Starts a fresh cycle (and
 * picks from the reset pool) once everything has had a turn.
 */
async function pickThing(env, things) {
  const eligible = things.filter((t) => t.lat != null && t.image && !isGone(t));
  const raw = await env.POSTED.get('cycle');
  const state = raw ? JSON.parse(raw) : { ids: [] };
  let pool = eligible.filter((t) => !state.ids.includes(t.id));
  if (!pool.length) { state.ids = []; pool = eligible; }
  const choice = pool[Math.floor(Math.random() * pool.length)];
  state.ids.push(choice.id);
  await env.POSTED.put('cycle', JSON.stringify(state));
  return choice;
}

async function login(env) {
  const res = await fetch(`${BSKY}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: env.BSKY_IDENTIFIER, password: env.BSKY_APP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadBlob(session, bytes, mimeType) {
  const res = await fetch(`${BSKY}/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType, Authorization: `Bearer ${session.accessJwt}` },
    body: bytes,
  });
  if (!res.ok) throw new Error(`uploadBlob failed: ${res.status} ${await res.text()}`);
  const { blob } = await res.json();
  return blob;
}

async function createPost(session, text, facets, blob, alt) {
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    embed: { $type: 'app.bsky.embed.images', images: [{ image: blob, alt }] },
  };
  if (facets) record.facets = facets;
  const res = await fetch(`${BSKY}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
  });
  if (!res.ok) throw new Error(`createRecord failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function run(env, { force } = {}) {
  if (!force && await alreadyPostedToday(env)) return { skipped: 'already posted today' };

  const [dataset, credits, custom] = await Promise.all([
    fetchJson(`${RAW}/data/bigthings.json`),
    fetchJson(`${RAW}/data/image-credits.json`).then((d) => d.images || {}),
    fetchJson(`${RAW}/data/custom-photos.json`).then((d) => d.images || {}).catch(() => ({})),
  ]);
  const allCredits = { ...credits, ...custom };

  const thing = await pickThing(env, dataset.things);
  const imgMeta = allCredits[thing.image];
  const imgUrl = `${SITE}/${imgMeta ? imgMeta.local : `img/${thing.image}`}`;
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`image fetch failed: ${imgUrl} → ${imgRes.status}`);
  const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const session = await login(env);
  const blob = await uploadBlob(session, imgBytes, mimeType);
  const { text, link } = buildCaption(thing);
  const facets = buildFacets(text, link);
  await createPost(session, text, facets, blob, altText(thing, allCredits));

  return { posted: thing.name, id: thing.id };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // A manual trigger for testing — cron jobs can't be invoked from a browser
  // or curl directly. Visiting this URL with the right key runs the exact
  // same logic scheduled() would. Not linked from anywhere; keep the key secret.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('key') !== env.TRIGGER_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const force = url.searchParams.get('force') === '1';
    try {
      const result = await run(env, { force });
      return Response.json(result);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
