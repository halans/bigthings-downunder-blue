# Recreating this from scratch

Everything here is reproducible. Two paths: rebuild from the shipped cache with **no network**,
or re-harvest every upstream source from the live web.

## Path A — rebuild from the bundle with no network (recommended)

The bundle ships `cache/` with an unmodified snapshot of every upstream source. Nothing after the fetch stage
touches the network.

```bash
unzip australian-big-things.zip && cd bigthings

node --version          # needs >= 18. No npm install — there are no dependencies.

npm run verify          # checksum the cached sources, then run the tests
npm run build           # regenerate the dataset and the web app
npm run serve           # http://localhost:8099
npm run serve:about     # http://localhost:8099/about.html
```

**To see the self-hosting:** start `npm run serve`, open the browser's network panel, and
confirm every request but the page itself resolves to `localhost` — the 284 photographs, the
fonts and Leaflet all come from `web/vendor/` and `web/img/`, not Wikimedia Commons or a CDN.
Cut your network entirely (pull the cable, disable Wi-Fi) and the map, every photo, the fonts
and the coastline at the continent view all keep working; the only thing that stops is real
basemap tiles once you zoom in, which are fetched live by design (see the README's "basemap"
section) rather than bundled.

`npm run verify` is the important one. It hashes each file in `cache/` against
`cache/CHECKSUMS.txt` and then runs all 170 tests, so a clean run proves that the inputs are
the ones this dataset was built from **and** that the pipeline still reproduces it.

Expected output, captured from a real run:

```
$ npm run verify

> australian-big-things@1.0.0 verify
> node src/checksums.js --verify && npm test

all 17 cached snapshots match cache/CHECKSUMS.txt

> australian-big-things@1.0.0 test
> node test/run.js

about            ...................
dataset          ........................
discovery        ....................
equivalence      ................................
match            ...................
parse            ......................................
standalone       ..................

170 passed, 0 failed  (421 ms)
```

```
$ npm run build

> australian-big-things@1.0.0 build
> npm run extract && node src/build.js && node src/build-web.js

records: 335
by state: { ACT: 9, NSW: 75, NT: 19, QLD: 81, SA: 34, TAS: 27, VIC: 65, WA: 25 }
with size: 141
with year: 168
with own article: 35
non-standing: 49
wikivoyage records: 150
with coords: 31
with blurb: 7
{
  "total": 477,
  "mapped": 477,
  "exact": 313,
  "byPrecision": {
    "exact-osm": 79,
    "town": 164,
    "exact-verified": 181,
    "exact-article": 20,
    "exact-wikivoyage": 27,
    "exact-inline": 6
  },
  ...
}
wrote web/index.html — 797 KB
wrote docs/IMAGE-CREDITS.md
wrote web/about.html — 33 KB
```

The build is deterministic: same cache in, same `data/bigthings.json` out, byte for byte apart
from `meta.generated`. If `npm run build` changes the dataset on an untouched cache, that is a
bug.

## Upgrading town-level pins

`npm run build` alone will not improve coordinate precision — it only replays what is already
in `cache/`. To try to promote town-level pins to real points:

```bash
npm run match          # build → match → build → build-web
npm run match:report   # print every proposal, furthest first, for audit
```

Audit `match:report` before trusting the result. The matcher is the only stage that can invent
a confidently-wrong coordinate; read the far-away proposals first, since distance is the signal
that a name matched the wrong object.

For the pins OpenStreetMap does not cover — most of them — the only route is research: find a
source that states an address, then write the coordinate into a `cache/verified-coords*.json`
file. Any file matching that glob is merged, so a new batch needs no code change:

```json
{
  "<record id>": {
    "lat": -33.31, "lng": 115.728,
    "source": "https://example.org/page-that-states-the-address",
    "sourceName": "Council attraction page", "confidence": "high"
  },
  "<record id>": { "townOnly": true, "note": "no address found" }
}
```

Use `confidence: "high"` only when the source names the sculpture itself; `"medium"` when you
geocoded a street address or the venue around it. Mark anything you could not place as
`townOnly` rather than guessing — the app labels a town pin honestly, whereas a wrong pin
carries a badge claiming it is trustworthy.

## Re-vendoring the photographs and assets

The bundle already contains them, so this is only needed if you are refreshing from upstream:

```bash
npm run images     # 284 Commons photos at 480px into web/img/, with licences
npm run vendor     # Leaflet, fonts, and the Australia outline into web/vendor/
npm run standalone # both, then regenerate the pages
```

`npm run images` is incremental: a file whose checksum still matches is left alone, so a
re-run costs almost nothing and an interrupted run is safe to resume. Expect roughly 27 MB
across 284 files and a few minutes at one request every 350 ms.

**Licences are captured, not assumed.** Every photo's author and licence come from Commons'
`imageinfo` API and land in `data/image-credits.json`. Anything whose licence cannot be
confidently called free is skipped and recorded with a reason — check the `skipped` array
after a refresh, and check `docs/IMAGE-CREDITS.md` regenerated cleanly.

If a photo 429s, just run it again; Wikimedia rate-limits bursts and the fetcher will pick up
only what is missing.

## Finding big things the wikis do not list

```bash
npm run discover          # harvest both community catalogues, then rebuild
npm run discover:report   # print every accept, reject and held-back row with its reason
```

Read `discover:report` before trusting a run. The duplicate list is the interesting part —
181 of 353 candidates are things we already hold under a different name, and each rejection
prints which record it matched and why. Rows the catalogues list but that do not read as
novelty big things land in `data/discovered-review.json`; promote one by moving it into
`overrides.json` additions with a reason.

Be a good citizen: both harvests serialise their requests with a delay, and both sites'
`robots.txt` permits crawling. Do not parallelise them.

## Path B — full re-harvest from the live web

```bash
npm run rebuild     # = npm run fetch && npm run build
npm run checksums   # record the new snapshot hashes
npm test
```

This takes roughly 8–12 minutes, most of it deliberate rate-limit courtesy.

### What it fetches

| Stage | Endpoint | Volume |
|---|---|---|
| Wikipedia article | `en.wikipedia.org/w/api.php?action=parse&page=Big_things_(Australia)&prop=wikitext` | 1 request, ~160 KB |
| Wikivoyage article | `en.wikivoyage.org/w/api.php?action=parse&page=Australia's_big_things` | 1 request, ~17 KB |
| Article + town coordinates | `…&prop=coordinates|pageprops` | ~7 batched requests (50 titles each) |
| Free-text place lookups | same, plus `list=search` fallback | ~20 batches + ~40 searches |
| OpenStreetMap (named "Big *") | Overpass `interpreter` | 1 request, ~2,300 elements |
| OpenStreetMap (all artwork/attractions) | Overpass `interpreter` | 1 request, ~9,000 named features |
| Land of the Bigs | 258 item pages | ~5 min at 0.9 s/page |
| Aussie Big Things Passport | 95 item pages | ~1 min at 0.7 s/page |

The two `.wikitext` snapshots are the only ones fetched by `curl` in the original run; the rest
come from `src/fetch-coords.js`, `src/fetch-places.js` and `src/fetch-osm-attractions.js`.

### Re-fetching the two article snapshots by hand

```bash
curl -sS --retry 3 --compressed -A "BigThingsMap/1.0" \
  "https://en.wikipedia.org/w/api.php?action=parse&page=Big_things_(Australia)&prop=wikitext&format=json&formatversion=2" \
  -o cache/wikipedia-bigthings.json
node -e 'require("fs").writeFileSync("cache/wikipedia-bigthings.wikitext", require("./cache/wikipedia-bigthings.json").parse.wikitext)'

curl -sS --retry 3 --compressed -A "BigThingsMap/1.0" \
  "https://en.wikivoyage.org/w/api.php?action=parse&page=Australia%27s_big_things&prop=wikitext&format=json&formatversion=2" \
  -o cache/wikivoyage-bigthings.json
node -e 'require("fs").writeFileSync("cache/wikivoyage-bigthings.wikitext", require("./cache/wikivoyage-bigthings.json").parse.wikitext)'
```

### Expect the upstream to have moved

These are live wiki pages. A re-harvest months later will legitimately differ: new big things
get added, demolished ones get updated, table rows get reworded. When counts shift:

1. Run `npm test` first. The regression tests in `dataset.test.js` pin the specific facts we
   verified against independent sources, so if the Woombye pineapple starts reading as
   demolished again, or the Triceratops migrates back to New South Wales, you will know.
2. Diff the new `data/bigthings.json` against the old one before committing.
3. Re-check `data/overrides.json`. If upstream has fixed something we were correcting, remove
   our override rather than leaving two sources of truth. `build.js` warns on the console when
   an override matches no rows — that is the signal.

### Rate limits

Wikimedia returns `429` on sustained batch traffic. `getRetry()` in `src/fetch-coords.js`
handles it with exponential backoff (2s → 30s, six attempts) and there is a 1.2s pause between
batches. If you still get throttled, raise the pause rather than the retry count.

`src/fetch-places.js` merges into the existing `cache/place-coords.json` instead of replacing
it, so an interrupted run is safe to re-run — it only re-requests what is still missing.

Overpass sometimes returns `504` under load. Two endpoints are configured
(`overpass-api.de`, `overpass.kumi.systems`, plus `overpass.private.coffee` for the attraction
harvest) and the fetchers fall through in order.

## Re-creating the packaged bundle

```bash
npm run build && npm run match && npm run standalone && npm test && npm run checksums
cd .. && zip -r australian-big-things.zip bigthings \
  -x 'bigthings/.git/*' -x 'bigthings/node_modules/*'
```

The zip is network-complete on purpose: cached upstream sources with checksums, the built
dataset, the generated web app, the 284 vendored photographs with their licences, the
vendored libraries and fonts, the full source, the docs and the tests. A recipient with Node 18
and no internet can verify, rebuild, serve and actually *look at* the whole thing.

It is about 27 MB, nearly all of it photographs. That is the cost of not depending on someone
else's servers.

## Hosting the map

`web/index.html` needs its siblings — `img/` and `vendor/` — since every photo, font and
library it loads is self-hosted rather than hotlinked. Upload the whole `web/` directory, or use
`npm run build:public` to assemble `public/` (the same pages plus `_headers`, `robots.txt` and
`sitemap.xml`) as a ready-to-deploy static site — see the README's "Deploying `public/`" section.

Photographs are vendored rather than hotlinked from Wikimedia Commons on purpose: inlining 27 MB
of base64 would make a phone chew through it for no benefit, but a plain `img/` folder served
from the same domain costs nothing extra and doesn't depend on Commons staying up or fast.

Basemap tiles are the one asset that's fetched live rather than bundled — no static host can
serve every tile at every zoom for the whole planet. They come from OpenStreetMap's public
servers once you zoom in past the continent view (see the README's "basemap" section). That's
fine for local use and light traffic, but read the
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
before putting this anywhere busy — swap in a paid provider (Mapbox, MapTiler, Thunderforest)
by changing the single `L.tileLayer` URL in `web/template.html`.
