# Bluesky daily poster

A Cloudflare Worker that posts one random Big Thing to Bluesky once a day, with its photo and a
link back to its map card. Runs entirely on Cloudflare's free tier — a cron-triggered Worker plus
one small KV namespace for state.

It has no dependency on this repo being deployed anywhere in particular: it reads
`data/bigthings.json` and the photo-credit files straight from GitHub's raw content at run time,
so a new correction or a newly added thing shows up here without ever touching this folder. The
photo bytes themselves come from `https://bigthings.downunder.blue/img/...` — update `SITE` in
`src/index.js` if that domain ever changes (see `data/site.json` in the repo root, which the main
site's build already treats as the one place that matters).

## One-time setup

1. **A Bluesky account to post from**, and an **app password** for it: Settings → App Passwords →
   Add App Password, in the Bluesky app or bsky.app. Use this, not your real account password —
   it can be revoked independently if this Worker's secrets ever leak.

2. **Install dependencies and log in to Cloudflare**:

   ```bash
   cd bluesky
   npm install
   npx wrangler login
   ```

3. **Create the KV namespace** that tracks which things have already been posted, and which day
   was last posted (so a retried cron run can't double-post):

   ```bash
   npx wrangler kv namespace create POSTED
   ```

   Paste the `id` it prints into `wrangler.toml`'s `[[kv_namespaces]]` block, replacing
   `REPLACE_WITH_KV_NAMESPACE_ID`.

4. **Set the secrets** (each prompts for a value — nothing is typed on the command line, and
   nothing here should ever be pasted into a chat with an AI assistant):

   ```bash
   npx wrangler secret put BSKY_IDENTIFIER    # your handle, e.g. bigthings.bsky.social
   npx wrangler secret put BSKY_APP_PASSWORD  # the app password from step 1
   npx wrangler secret put TRIGGER_SECRET     # any random string — for manual testing, see below
   ```

5. **Deploy**:

   ```bash
   npm run deploy
   ```

That's it — the cron trigger in `wrangler.toml` (`0 22 * * *`, i.e. 22:00 UTC) fires daily from
here on. Cron is always UTC; there's no per-Worker timezone setting, so pick a time and do the UTC
conversion yourself (22:00 UTC is 8am AEST / 9am AEDT).

## Testing before you trust the cron

Cloudflare cron triggers can't be invoked from a browser or `curl` — there's no URL for them. So
`src/index.js` also exports a `fetch` handler that runs the exact same posting logic, gated behind
the `TRIGGER_SECRET` you set above:

```bash
curl "https://bigthings-bluesky-poster.<your-subdomain>.workers.dev/?key=YOUR_TRIGGER_SECRET"
```

This **will actually post** if today hasn't been posted yet. Add `&force=1` to post again even if
today's post already went out — useful for iterating, less useful for your followers' timelines if
you forget to remove it. Local iteration without touching the real KV state or posting for real:

```bash
npm run dev
```

(`wrangler dev` runs against a local KV emulation, not your production namespace, unless you pass
`--remote`.)

## How it decides what to post

- **Selection** (`pickThing`): cycles through every thing that has a photo, a map coordinate, and
  isn't marked demolished/removed, without repeating one until the whole set has had a turn — then
  starts over. State is a plain list of already-posted ids in KV, key `cycle`.
- **Caption** (`buildCaption`): `Name — Town, State`, then the thing's `blurb` (or `notes` if it
  has no blurb) trimmed to fit Bluesky's 300-grapheme limit, then the map link
  (`https://bigthings.downunder.blue/#thing=<id>`) on its own line, turned into a clickable link
  via a `facet` — Bluesky doesn't auto-linkify plain text.
- **Alt text** (`altText`): names the photographer and licence, the same credit the map card
  itself carries — this project takes photo attribution seriously (see the main repo's
  `docs/ADMIN.md`), and there's no reason that should stop at the edge of the map.
- **Idempotency**: `alreadyPostedToday` checks/sets a `lastDate` key in KV first, so a cron retry
  (or a stray extra invocation) on the same UTC day is a no-op rather than a duplicate post.

## Known limitations

- The link in the post opens the live map (a single-page app), not a per-thing page — there's no
  server-rendered route per thing, so Bluesky's own link-preview card will show the site's generic
  title/image, not this specific thing's. The photo is still posted directly as an image embed, so
  the post itself looks right either way; it's only the link-card underneath that's generic.
- Demolished/removed things are excluded from the daily rotation by design (`isGone()` in
  `src/index.js`) — posting "here's a great big thing" about something that no longer exists felt
  like the wrong default. Delete that filter if you'd rather include them (the map's own honesty
  about what's gone is half the point of this project, after all).
- Grapheme counting for the 300-character budget is an approximation (`[...string].length`, not a
  full `Intl.Segmenter` count) — fine for the plain-text blurbs in this dataset, but a caption with
  complex emoji could in principle be undercounted by a character or two.
