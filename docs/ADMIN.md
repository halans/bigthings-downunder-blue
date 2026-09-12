# Editing records by hand

`data/bigthings.json` is a **build artifact**. Every `npm run build` regenerates it from
scratch — cached upstream sources, the discovery pipeline, then `data/overrides.json` applied on
top — so editing it directly is the one thing guaranteed not to survive the next build. The same
is true of `data/discovered.json` and `data/discovered-review.json`. If you've hand-edited any of
those and wondered why your change vanished, this is why.

`data/overrides.json` is different: it's the one file in the pipeline a human is meant to write
to, and `src/build.js` applies it *after* harvesting, so it always wins and always survives. This
doc covers using it directly, and the local admin UI that saves you doing so by hand.

## The local admin UI (recommended)

```bash
npm run admin
```

Opens on `http://127.0.0.1:8098`. Search for a thing, edit its fields, save — it writes to
`data/overrides.json` and re-runs the build for you, so the dataset and both pages are up to date
before you've switched back to the browser tab. The "＋ Add new thing" button does the same for a
record that doesn't exist yet at all — see [Adding a brand-new record](#adding-a-brand-new-record)
below.

**This is not part of the app.** It's a plain Node HTTP server (`src/admin-server.js`) bound
explicitly to `127.0.0.1`, serving one static page (`src/admin-ui.html`). Nothing in `web/`,
`public/`, or the build scripts that produce them reads either file — `npm run build:public`
never touches `src/`, so there's no path by which this ends up deployed. Nothing here calls out
to the network either; it only shells out to the same `node src/build.js` /
`src/build-web.js` / `src/build-about.js` you'd run yourself. Close the terminal tab and it's
gone until you run `npm run admin` again.

What it does under the hood is exactly what's described below — a correction in
`data/overrides.json`, or a photo in `data/custom-photos.json` plus `web/img/custom/`. Read on if
you want to do either by hand instead, or just want to know what the UI is actually writing.

## Correcting or adding a record by hand

Open `data/overrides.json`. It has three arrays:

### `corrections` — fix a field on a record that already exists

```json
{
  "match": { "id": "d9ec2c880c" },
  "set": { "lat": -33.4310, "lng": 151.3399, "precision": "exact-verified", "coordSource": "https://example.com/where-i-checked" },
  "why": "Walked the site — the sculpture sits about 15m from where the town-level pin had it.",
  "source": "https://example.com/where-i-checked"
}
```

- **`match`** identifies the record. Match on `id` (shown on every card, and in the admin UI) —
  it's unambiguous and, per the note below, stable across rebuilds even if you also change the
  name or location in the same correction. The existing hand-written corrections in this file
  mostly match on `{ "name": ..., "state": ... }` instead, from before the admin UI existed;
  either works, but `id` is simpler to get right.
- **`set`** is any subset of the record's fields — `name`, `state`, `location`, `town`, `lat`,
  `lng`, `precision`, `coordSource`, `builtYear`, `builtRaw`, `category`, `status`, `notes`,
  `blurb`, `image`, `evChargerNearby`, and so on. Only the fields you list change; everything else
  is untouched.
- **`why`** is required in spirit (the admin UI enforces it; nothing stops you skipping it by
  hand, but don't). **`source`** should be a URL wherever you're asserting a fact rather than a
  judgement call.
- If you save more than once against the same `id` — by hand or via the UI — merge into the
  *same* entry rather than adding a second one; the UI does this for you. `why` isn't a log: the
  most recent one is what's kept, so if you're editing something a second time for an unrelated
  reason, write a `why` that still makes sense for everything currently in `set`.

**The precision guard.** If a record already has an "exact-\*" precision, a correction that sets
`precision: "town"` has its `lat`/`lng`/`precision`/`coordSource` silently dropped — this stops a
good coordinate being accidentally downgraded. It does **not** block replacing one exact
coordinate with a better one: to correct an already-exact pin, keep `precision` as
`exact-verified` (the standard tag for "a human checked this"), not `town`.

### Flagging an EV charger nearby

`evChargerNearby` is normally computed automatically at build time — see
[BUILDING.md](BUILDING.md#stage-4d--ev-charger-proximity-srcfetch-ev-chargersjs) — from an
Overpass harvest of OSM charging stations. The admin UI's checkbox is for the case OSM hasn't
caught up yet: check it and save, and `applyOverrides()` sets `evChargerNearby: true` on the
record regardless of what the OSM harvest finds.

It's one-directional by design: unchecking the box and saving does **not** write `false`. The
automatic check re-runs on every build and will set the flag back to `true` the moment a charger
*is* mapped nearby, so a manual `false` would only ever last until the next `npm run fetch:ev` —
worse, it'd sit in `overrides.json` as a correction that looks meaningful but does nothing. If you
need to suppress a flag OSM gets wrong, edit `data/overrides.json` directly (or the record's
`evChargerNearby` won't reappear only for as long as OSM doesn't have one there either).

### `additions` — a thing that isn't in either wiki list at all

```json
{
  "name": "The Big Whatever",
  "state": "QLD",
  "location": "Nowhere Creek",
  "lat": -20.123, "lng": 145.456,
  "precision": "exact-verified",
  "coordSource": "https://example.com",
  "category": "oddity",
  "status": "standing",
  "notes": "Optional prose describing it.",
  "why": "I drove past it and it isn't on Wikipedia or Wikivoyage.",
  "source": "https://example.com"
}
```

`id` is generated for you from `state` + `name` + `location`, same as every other record.

### Adding a brand-new record

The admin UI's "＋ Add new thing" button writes exactly an `additions[]` entry like the one above,
then rebuilds and confirms the record actually appears — same "loud failure, not a buried warning"
rule as everything else here. Its form only exposes: `name`, `state`, `location`, `town`, `lat`,
`lng`, `precision`, `coordSource`, `builtYear`, `heightM`, `sizeRaw`, `category`, `status`,
`notes` — a slightly different field set from a correction's `set` (no `id`, no `stateName` or
`blurb`, plus `heightM`/`sizeRaw` which corrections don't use). Only `name`, `state`, and `why` are
required; leave the rest blank and fill them in later with a correction once you know more. It
refuses to create a record that already exists — same `state` + slugified `name` as a real
record — so a rename or a fact you got wrong belongs on the existing card, not a new one.

### `removals` — delete a duplicate

```json
{ "match": { "name": "...", "state": "..." }, "why": "...", "source": "..." }
```

Matches and deletes the first row found — used for the rare case where the wiki lists name the
same sculpture twice under different names.

### Removing a record from the admin UI

Open a record and use the "Remove this record" panel at the bottom — needs a `why`, same as every
other write here, and confirms before it does anything since it rebuilds immediately.

What it actually does depends on where the record came from:

- **A record you added yourself** (via "＋ Add new thing") is deleted outright — its `additions[]`
  entry is removed, so there's nothing left to ever recreate it.
- **A harvested record** (from Wikipedia or Wikivoyage) can't be deleted at the source — the next
  `npm run fetch` would just bring it straight back — so this writes a `removals[]` entry instead,
  exactly the hand-written form above. To undo it, delete that entry from `data/overrides.json` and
  rebuild; the record reappears with all its original data.

Either way, a correction sitting on that same `id` is dropped too — it would otherwise "match
nothing" on the very next build — and if the record had a custom photo nothing else uses, that's
deleted along with it (the file under `web/img/custom/` and its `data/custom-photos.json` entry).

This is what fixed the Wikipedia/Wikivoyage dedup occasionally missing a sculpture named
differently in each list (e.g. "Big Redback Spider" vs "The Big Redback" for the same Eight Mile
Plains sculpture) — remove the thinner duplicate, keep the one with the photo and notes.

After hand-editing `data/overrides.json`, run `npm run build` (or just `node src/build.js` if you
don't need the pages regenerated too) and watch its output: **`override matched nothing`** or
**`removal matched nothing`** printed to the terminal means your `match` block didn't find the
record you meant — a typo in the id or name, most often — and the edit was silently skipped. The
admin UI treats this as a hard failure rather than a buried warning; watching for it by hand is on
you.

## Adding your own photo

A record's `image` field normally holds a Wikimedia Commons filename, vendored by
`src/fetch-images.js` into `web/img/` and credited in `data/image-credits.json` — both of which
that script owns and regenerates. Your own photo doesn't belong in either: it isn't on Commons,
and `fetch-images.js` would just fail to find it there and skip it.

Instead:

1. Put the file in `web/img/custom/` (create the folder if it doesn't exist).
2. Add an entry to `data/custom-photos.json`, keyed with a `custom:` prefix — that prefix is what
   tells `fetch-images.js` to leave it alone entirely (see the filter in its `main()`):

   ```json
   {
     "images": {
       "custom:big-whatever-mine.jpg": {
         "local": "img/custom/big-whatever-mine.jpg",
         "author": "Your Name",
         "licence": "All rights reserved",
         "licenceUrl": null,
         "filePage": "https://your-site.example/gallery/big-whatever"
       }
     }
   }
   ```

   `licence` can be whatever you want — `"All rights reserved"` if it's just yours, or
   `"CC BY-SA 4.0"` to match the dataset's own licence if you're happy sharing it that way.
   `filePage`, if set, is where the card's "via ⟨site⟩" link points — your own portfolio, a gallery
   page, wherever the photo can actually be seen in context. Leave it `null` and the card just
   names the photographer with no "via" clause; it never claims Wikimedia Commons for a photo that
   isn't from there.

3. Point the record at it with a correction: `"set": { "image": "custom:big-whatever-mine.jpg" }`.

The admin UI's photo upload does exactly these three steps from a file picker, with a "Photo's own
page (optional)" field for `filePage` — resizing or optimising the image yourself first is worth
doing since, unlike the Commons pipeline, nothing here does it for you.

`src/build-web.js` and `src/build-about.js` both read `data/image-credits.json` (Commons) and
`data/custom-photos.json` (yours) through one shared helper, `src/image-credits.js`, so a custom
photo is credited on its card exactly like a vendored one — author, licence, and (if you set one)
a licence link.

## Seeing your changes

`npm run build` (or the admin UI, automatically) regenerates `data/bigthings.json`,
`web/index.html` and `web/about.html`. Then:

- `npm run serve` — the map, locally, at `http://localhost:8099`.
- `npm run build:public && npm run serve:public` — the same pages packaged as the static site
  that gets deployed, previewed exactly as a host would serve it.

Nothing about deploying changes: `npm run build:public` still only reads `web/index.html`,
`web/about.html`, `web/img/` and `web/vendor/` — your custom photo, now living under
`web/img/custom/`, is picked up the same way every other file in `web/img/` is.
