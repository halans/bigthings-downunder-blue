# Building

The pipeline is six stages. Stage 1 touches the network; everything after it is a pure
function over the files in `cache/`, so a rebuild from a shipped bundle needs no connectivity.

```
1. fetch     ──▶ cache/*.wikitext, cache/*-coords.json, cache/osm-*.json
2. extract   ──▶ cache/stage-wikipedia.json, cache/stage-wikivoyage.json
3. build     ──▶ data/bigthings.json          (the canonical dataset)
4. match     ──▶ cache/osm-matches.json       (town pins upgraded, for audit)
5. build     ──▶ data/bigthings.json          (again, applying the matches)
6. build-web ──▶ web/index.html               (generated from the dataset)
7. test      ──▶ 171 assertions, incl. map-vs-CLI, self-hosted-asset and layout checks
```

Stage 4 needs a built dataset to read and feeds the next build, so the
coordinate-upgrade loop is `build → match → build`. It is idempotent: matches
accumulate in `cache/osm-matches.json` and re-running finds only what is new.

## Commands

```bash
npm run build      # extract → build → build-web, offline. The usual command.
npm run match      # build → match → build: try to upgrade town-level pins
npm run discover   # harvest the community catalogues (network), then rebuild
npm run rebuild    # re-fetch every upstream source, then build
npm run fetch      # stage 1 only
npm run fetch:ev   # refresh cache/ev-chargers.json only (stage 4d, optional)
npm test           # the test suite
npm run verify     # checksum the cache, then run the tests
npm run serve      # http://localhost:8099
npm run checksums  # rewrite cache/CHECKSUMS.txt after a deliberate re-fetch
```

`npm run build` never hits the network. If you edit a parser, run `npm run build && npm test`
and you will know within a second whether you broke anything.

## Stage 1 — fetch (`src/fetch-coords.js`, `src/fetch-places.js`)

`fetch-coords.js` does two things:

1. Collects every Wikipedia article title referenced by the big-things table — the sculpture's
   own article, and its town — and batches them through the MediaWiki API 50 at a time with
   `prop=coordinates|pageprops`. This yields both coordinates and Wikidata QIDs for free.
2. Queries Overpass for every Australian node/way/relation whose name starts with
   `Big`/`Giant`/`Large`/`World's Largest`, as an independent coordinate source.

`fetch-places.js` resolves the free-text `Location` strings that carry no wikilink
("Pokolbin", "Picton, at Saddleworld, 20/15 Henry Street"). It reduces each to candidate place
names, tries direct title lookups in bulk, then falls back to full-text search for the
stragglers.

**Rate limits are real.** Wikimedia returns `429` under a batch run, so `getRetry()` wraps
every GET in exponential backoff (2s → 30s, six attempts) and there is a 1.2s pause between
batches. Overpass has two endpoints configured and falls through to the second on failure.
Both fetchers are incremental — `place-coords.json` is merged, not overwritten, so a partial
run is safe to resume.

## Stage 2 — extract (`src/extract-*.js`)

`src/wikitext.js` is a deliberately narrow wikitext parser covering only the constructs that
actually appear in these two pages:

- `sectionsByHeading()` splits on `=== State ===`
- `extractTables()` pulls `{| ... |}` bodies
- `parseRows()` handles multi-line cells, inline `||` separators and `style="…"|` attributes,
  splitting **only at nesting depth zero** so `{{convert|7|*|4|m}}` survives intact
- `findTemplates()` finds balanced `{{name|…}}` by brace counting — including when a newline
  follows the template name, which is how Wikivoyage writes its `{{see}}` listings
- `toPlainText()` renders prose: refs stripped, `{{convert}}` rendered to `13 × 5 m`, links
  reduced to their labels

The Wikipedia tables are uniform six-column `Name | Location | Built | Size | Notes | Image`
with no rowspans, which is why the parser can stay this small. Columns are located by header
text rather than index, so a reordered column will not silently corrupt the output.

`src/normalise.js` holds the domain logic and is where the interesting judgements live — see
[DATA.md](DATA.md) for the size, status and category rules and the bugs that shaped them.

## Stage 3 — build (`src/build.js`)

Merges everything into one array, resolving coordinates through the precision tiers documented
in [DATA.md](DATA.md), then applies, **in this order**:

1. `applyAdditions()` — big things documented elsewhere but absent from both wiki lists
2. `applyOverrides()` — curated corrections, which refuse to downgrade an exact pin
3. `applyRemovals()` — rows that duplicate another row under a different name
4. `applyOsmMatches()` — the audited OSM proximity upgrades
5. `applyVerifiedCoords()` — human-researched points, which outrank an OSM name match

The order is load-bearing, twice over. Overrides and additions between them supply town points
for rows whose Location cell was blank, and the matcher ran against the finished dataset — so it
has to see those points. An earlier version ran the matcher first and silently skipped every such
row. Additions also have to run *before* overrides, not after: a correction that targets an added
or discovered record (by `id`, or by name+state) needs that record to already exist when
`applyOverrides()` looks for it, or its `match` finds nothing and the correction is silently
never applied — exactly the failure `npm run admin` (see [ADMIN.md](ADMIN.md)) exists to prevent.

Every candidate coordinate is bounds-checked against its state's bounding box before being
accepted, which is what catches a name collision like an OSM "Big Rock" in the wrong state.

## Stage 4 — the coordinate upgrade loop (`src/match-osm.js`)

Most records only name a town, so they land at `town` precision. This stage
tries to promote them to a real point.

`src/fetch-osm-attractions.js` harvests every Australian OSM feature that could
plausibly be a big thing — `tourism=artwork`, `artwork_type`, `man_made=sculpture`,
`tourism=attraction`, named `historic=memorial` — about 9,000 named, located
features. The original query only matched names beginning "Big"/"Giant", which
missed every sculpture mapped under its proper name: Larry the Lobster, Rambo,
Ploddy the Dinosaur, Krys the Savannah King. Those are the famous ones.

`src/match-osm.js` then matches on **name similarity AND distance from the town
we already trust**. Proximity is what makes fuzzy names safe: "Big Apple" is
ambiguous nationally — there are nine — but "an OSM artwork called Big Apple
within 5 km of Thulimbah, Queensland" is not ambiguous at all.

| Match kind | Rule | Max distance |
|---|---|---|
| `name-exact` | core tokens identical | 12 km |
| `name-superset` | OSM name adds detail, our core has ≥2 tokens | 8 km |
| `name-subset` | OSM name is a shorter form, its core has ≥2 tokens | 8 km |
| `name-fuzzy` | Jaccard ≥ 0.7, our core has ≥2 tokens | 8 km |
| `name-artwork` | single-token core, candidate tagged as artwork | 3 km |
| `venue` | only venue words differ (cafe, visitor centre, orchard…) | 2 km |

"Core tokens" are the name with articles and size words removed — `The Big
Banana` → `{banana}` — then crudely singularised so `Big Wool Bales` matches
`Wool Bale`.

Two guards do the real work:

- **Ambiguity refusal.** If two distinct candidates match equally well and are
  more than 500 m apart, the matcher returns `ambiguous` and the record stays at
  town level. Guessing between two Big Apples is worse than admitting we don't
  know.
- **A 12 km ceiling.** An audit run at 30 km paired Latrobe's Big Platypus with
  a different Giant Platypus 29 km away. A sculpture is essentially never that
  far from the centre of the town it is credited to.

Run `node src/run-osm-match.js --report` to print every proposal, furthest
first. **Audit that output before rebuilding** — the matcher is the only stage
that can invent a confidently-wrong coordinate, and a wrong pin is worse than an
honest town pin because it wears a badge saying it is trustworthy.

Manual research passes write `cache/verified-coords*.json` (any file matching
that glob is merged), which outranks an automated OSM match but defers to a
coordinate published on the sculpture's own article.

## Stage 4b — discovery (`src/fetch-discovery.js`, `src/extract-discovery.js`)

Wikipedia's own article cites 1,075 big things nationally but tabulates a few hundred. Two
community catalogues enumerate far more, and both publish the facts we need in
machine-readable form:

| Source | Item pages | What it exposes |
|---|---|---|
| [Land of the Bigs](https://landofthebigs.com/) | 258 Australian | a Google Maps iframe whose `pb=` parameter carries `!2d<lng>!3d<lat>`, plus a subject taxonomy (`big-fruit`, `big-insects`, …) |
| [Aussie Big Things Passport](https://www.aussiebigthings.com.au/) | 95 | latitude/longitude in the page's own hydration payload |

`npm run discover` harvests both, then `extract-discovery.js` filters hard. What it rejects
matters more than what it accepts:

- **Duplicates** (181 of 353). Name alone is useless — there are nine Big Apples — so a
  candidate is a duplicate when its name overlaps an existing record *and* the town matches,
  or the normalised names are identical, or one name contains the other within 8 km, or it
  sits within 2 km of a same-ish name.
- **The NSW/ACT enclave.** The ACT lies wholly inside the NSW bounding box, so a bbox test
  cannot separate them: Belconnen's Big Powerful Owl arrives labelled NSW and duplicates the
  ACT record we hold. Two attempts to fix this by *reclassifying* the state were both worse
  (see [DATA.md](DATA.md#geocoding-traps)); the enclave relationship is now used only to widen
  the dedup search, where proximity decides.
- **Out of scope.** Both catalogues list civic public art and memorials next to novelty
  sculpture. Rather than guessing from names — which mis-sorted "Bigfoot" as art and could not
  distinguish "Almost Once" from a giant clam — the scope test defers to the catalogue's own
  taxonomy: a `big-*` category or a `big-things` / `roadside-attractions` tag. A name marker
  works as a second positive signal. Anything failing both lands in
  `data/discovered-review.json` with the reason, rather than being dropped silently.
- **Coordinates that overstate themselves.** Two decimal places is about a kilometre, so those
  rows are labelled `town`, not `exact-verified`.

The stage is **idempotent**: because a build folds discovered rows into the dataset, the
extractor excludes rows it previously contributed when deduplicating. Without that it matched
its own output on a second run and emptied itself.

Output goes to `data/discovered.json`, which `build.js` merges alongside the small curated
list in `overrides.json` — curated entries win any collision.

## Stage 4c — vendoring the assets (`src/fetch-images.js`, `src/fetch-vendor.js`)

Run once with `npm run standalone`; cached afterwards.

**`fetch-images.js`** pulls every referenced Wikimedia Commons photograph at 480px into
`web/img/`, and — more importantly — captures the licence and photographer for each. Commons'
`imageinfo` API returns `License`, `LicenseShortName`, `Artist`, `UsageTerms` and an explicit
`AttributionRequired`, all of which land in `data/image-credits.json` beside a SHA-256 of the
local copy.

Three things worth knowing:

- **Nothing ships without a free licence.** `assessLicence()` allow-lists CC0, CC BY, CC BY-SA,
  public domain and a few others, and refuses anything else. A card falling back to its emoji
  placeholder beats distributing a file we have no right to.
- **Some files live on English Wikipedia, not Commons.** Four did. The fetcher retries misses
  against `en.wikipedia.org` before giving up.
- **Commons' own thumbnails are used as-is, never re-encoded.** WebP would save ~40%, but that
  puts an image toolchain in the rebuild path, and a Node-only, network-free rebuild is the
  whole point.

**`fetch-vendor.js`** takes Leaflet, MarkerCluster, their stylesheets and sprites, the two
webfonts, and a simplified Australia outline into `web/vendor/`, with checksums in
`data/vendor-manifest.json`.

Two traps it documents:

- The 1:110m Natural Earth admin-1 file is a tempting 180 KB but contains only the United
  States. Australia first appears in the 1:50m set — 2.3 MB before filtering, 20 KB after
  Douglas–Peucker simplification.
- Google Fonts content-negotiates on User-Agent. A research UA is served legacy TTF, which made
  `web/vendor/` 1.6 MB; a browser UA is served woff2, which brings it to 467 KB.

## Stage 4d — EV charger proximity (`src/fetch-ev-chargers.js`)

Optional, and independent of everything above: `npm run fetch:ev` harvests every
`amenity=charging_station` node/way/relation in Australia from Overpass into
`cache/ev-chargers.json` (~1,600 points as of this writing). `build.js`'s `applyEvChargers()`
then flags any thing within 500 m (walking distance) of one of them with `evChargerNearby:
true` — a straight-line haversine check, bounding-box-filtered first so it stays cheap however
large the charger set grows. The card shows it as a 🔌 badge.

If `cache/ev-chargers.json` was never fetched, this step silently does nothing — the flag is
never set, not falsely set. Refresh it independently of everything else with `npm run fetch:ev`,
since charging infrastructure changes far faster than sculpture locations.

The map surfaces this as a filter, not an overlay: a "🔌 EV charging nearby" switch under
"Map display" (only offered at all if at least one thing has the flag) narrows the results to
things with `evChargerNearby: true`, the same way "Only pinpointed pins" narrows on precision.
It doesn't plot the ~1,600 chargers themselves — the flag on each thing is all the page ships.

## Stage 5 — generate the pages (`src/build-web.js`, `src/build-about.js`)

Two HTML files from two templates, one each:

| Generator | Template | Output |
|---|---|---|
| `build-web.js` | `web/template.html` | `web/index.html` |
| `build-about.js` | `web/about-template.html` | `web/about.html` |

Everything is self-hosted — photos from `web/img/`, Leaflet and the fonts from `web/vendor/` —
rather than hotlinked from Wikimedia Commons or pulled from a CDN. There used to be a second,
"offline" variant of each page for exactly this purpose; there's no reason to hand-maintain two
builds when self-hosting can just be the only build, so that's what these generators produce now.

`build-about.js` reads `data/bigthings.json`, `data/overrides.json`,
`data/image-credits.json` and `data/downloads.json`, and injects every number on the landing
page. Nothing on it is typed by hand — including the prose superlatives ("the largest along any
axis is…"), which are computed and then asserted against the dataset in the tests.

A judgement call worth knowing: **correction cards are ranked, not sliced.** Taking the first
six alphabetically surfaced three records that share one override about the Sapphire gemfields.
The generator now dedupes on the explanation text and ranks by how much explanation there is,
which puts Fergus the Bull and the misfiled Triceratops first.

## Stage 5b — generate the map (`src/build-web.js`)

The page is **generated, not maintained**. The shell lives in `web/template.html`, and
`generate()` fills three placeholders:

| Placeholder | Content |
|---|---|
| `__DATA__` | the slimmed dataset (fields in `FIELDS`) |
| `__CREDITS__` | per-photo author/licence/local path |
| `__OUTLINE__` | the inlined Natural Earth coastline |

`photoUrl()` always resolves to the local vendored copy in `CREDITS`, returning `null` for
anything not vendored rather than quietly reaching for Commons. The basemap itself — vector
coastline vs real OpenStreetMap tiles — is decided at runtime by zoom, not at build time: see
`TILE_ZOOM`/`syncBasemap()` in `web/template.html`.

JSON payloads are escaped for `<`, U+2028 and U+2029 so they are safe to inline in a
`<script>`.

Edit `web/template.html`, never `web/index.html` — it's overwritten on every build.

## Stage 5c — SEO and AEO (`src/seo.js`)

The app is a client-rendered single page: without this stage, a crawler that never executes the
JS sees a title, a description, and nothing else — none of the 477 things is independently
citable. `src/seo.js` is the one shared module both generators use to close that gap, driven by
`data/site.json` (`siteUrl`, `shareImage`):

- **Canonical link + Open Graph + Twitter Card tags** (`metaTags()`) on both pages, built from
  the same `TITLE`/`DESCRIPTION` constants that fill `<title>` and `<meta name="description">`
  — one string per page, never typed twice.
- **`WebSite` + `Dataset` + `ItemList` JSON-LD** on the map page (`buildJsonLd()` in
  `build-web.js`): every thing's name, coordinates, address, photo, `#thing=<id>` deep link and
  (if present) Wikipedia link, sitting in the raw HTML independent of the app's own inline JSON.
  `additionalProperty` only appears for the things that aren't `standing`, since misrepresenting
  a demolished sculpture as extant is exactly the kind of error the rest of this project exists
  to avoid.
- **`FAQPage` + `BreadcrumbList` JSON-LD** on the about page: the same superlatives already
  computed for the visible prose (oldest, newest, biggest, tallest, the lost count, the
  exact-placement percentage), reused as answer text rather than retyped — so an answer engine
  citing "how many big things are demolished" and the visible page can never disagree.

`jsonLd()` escapes `<`, U+2028 and U+2029 the same way `build-web.js`'s own `inlineJson()` does,
so a `</script>` or a line-separator inside a name or blurb can't break out of the block.

## Stage 5d — package for deployment (`src/build-public.js`)

`web/index.html` and `web/about.html` already load nothing but self-hosted assets (that's the
whole point of Stage 5, and `standalone.test.js` enforces it), so packaging `public/` is just
gathering the pieces: regenerate both pages straight from `data/bigthings.json` (it doesn't just
copy `web/`), and copy `img/` and `vendor/` verbatim — every path inside those two folders is
already relative, so nothing needs rewriting. It also writes:

- `public/_headers` — long-lived immutable caching for the content-hashed photos in `img/` and
  the unhashed libraries/fonts in `vendor/`; no explicit rule for the HTML, so Pages applies its
  default (short-lived) caching.
- `public/robots.txt` and `public/sitemap.xml`, both built from `data/site.json`'s `siteUrl` —
  the sitemap's two URLs get `<lastmod>` from `data/bigthings.json`'s `meta.generated`.

Requires `web/img/` and `web/vendor/` to already exist (`npm run standalone`, once — cached
afterwards). Preview it with `npm run serve:public` before deploying.

`public/` is disposable — it's regenerated in full on every run, never hand-edited, and needs no
separate test suite: it's the same build `standalone.test.js` already covers, just copied.

## Stage 6 — test (`test/run.js`)

A 50-line zero-dependency runner. Seven suites:

- **`parse.test.js`** — the wikitext parser and normalisers, unit level
- **`dataset.test.js`** — schema, uniqueness, coordinate bounds (in Australia *and* in the
  right state), stats consistency, plus a named regression test for every data bug already
  fixed once
- **`match.test.js`** — the OSM proximity matcher: what it accepts, and more importantly what
  it refuses. Includes the real false positives that shaped the rules (the 29 km platypus, the
  `tennis` → `tenni` singulariser bug) so they cannot come back.
- **`discovery.test.js`** — the discovery pipeline, which is mostly a set of refusals. Every
  case is a mistake it actually made: the parenthesised nickname, the NSW/ACT enclave
  duplicate, the un-decoded HTML entity, the non-idempotent re-run.
- **`about.test.js`** — the About page's contract. It exists to stop the landing page drifting
  away from the data it describes: every headline figure, bar and superlative is checked against
  the dataset, the precision tiers must sum to the total, each correction card must be a real
  sourced override, and each photo must name its photographer. It also pins two layout traps that
  bit in review — the UA `figure` margin, and the phone header crowding the wordmark.
- **`standalone.test.js`** — the build's self-hosting contract: no image, font or script loads
  from anywhere but this domain (real map tiles, loaded live once you zoom in, are the one
  intentional exception), every local reference exists, every photo names its photographer and
  licence, and each vendored file matches its recorded checksum. The key distinction it encodes
  is between assets the browser *loads* (all local, tiles excepted) and links the user *clicks*
  (necessarily external).
  It also guards a layout trap: a `<span>` given an inline `width` is still an inline element,
  and width/height do not apply to those — which rendered every Superlatives bar as an empty
  outline while the numbers beside them stayed correct. Neither a data test nor a render
  health check can see that, so the suite asserts any inline-sized span is blockified.
- **`equivalence.test.js`** — extracts `matches()` out of the *generated* HTML, runs it in a
  `vm` sandbox with no DOM, and diffs its id list against `src/query.js` across 16 filter
  permutations. If someone changes the map's filter logic without changing the library, this
  fails.

Adding a test: drop a `*.test.js` in `test/` and `require('./run')` for `test`, `eq`, `ok`,
`close`. The runner discovers files alphabetically and exits non-zero on any failure.

## Extending it

**A new field on every record.** Add it in `extract-wikipedia.js`, carry it through
`build.js`'s record literal, add it to `FIELDS` in `build-web.js` if the app needs it, then
add an assertion in `dataset.test.js`.

**A new category.** Add the rule to `CATEGORY_RULES` in `src/normalise.js` (order matters —
first match wins), add the label/emoji/colour to `CATS` in `web/template.html`, and add the
label to `CATEGORY_LABELS` in `src/query.js`. The equivalence suite will fail if the two label
tables disagree, which is the point.

**A new filter.** Add it to `matches()` in `src/query.js` *and* to `matches()` in
`web/template.html`, then add a case to `CASES` in `equivalence.test.js`. Skipping either half
fails the build.

**A new source.** Write a `src/extract-<source>.js` that emits a `cache/stage-<source>.json`,
merge it in `build.js` the way the Wikivoyage records are merged, and add the file to `TRACKED`
in `src/checksums.js` with its licence.

**A correction.** Prefer `data/overrides.json` over editing a parser, unless the parser is
systematically wrong — in which case fix the parser and add a regression test. Every override
needs a `why`; ones asserting a fact need a `source`.
