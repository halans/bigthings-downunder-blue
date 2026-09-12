# The dataset

`data/bigthings.json` is the single source of truth. The map, the CLI and every statistic in
this repository are derived from it.

```json
{
  "meta": {
    "generated": "2026-09-08",
    "claimedNationalTotal": 1075,
    "claimedTotalSource": "Clarke, A. (2023). Making a Mark… Journal of Australian Studies 47(2)",
    "sources": [ { "name": "…", "url": "…", "licence": "…" } ],
    "stats": { "total": 477, "mapped": 477, "byPrecision": {}, "byState": {}, "…": {} }
  },
  "things": [ … ],
  "chargers": [ [-33.865, 151.209], … ]
}
```

`chargers` is every OSM-mapped EV charging point as a `[lat, lng]` pair, at 5dp — the raw
material both `evChargerNearby` (below) and the map's own "Show EV chargers" overlay are built
from. `[]` if `npm run fetch:ev` was never run; see
[BUILDING.md](BUILDING.md#stage-4d--ev-charger-proximity-srcfetch-ev-chargersjs).

## Record schema

| Field | Type | Notes |
|---|---|---|
| `id` | string | 10-hex SHA-1 of `state\|slugName\|slugPlace`. Stable across rebuilds unless the name, state or town changes. |
| `name` | string | As the source writes it, including a leading "The". |
| `state` / `stateName` | string | `QLD` / `Queensland`. Asserted consistent by the test suite. |
| `location` | string \| null | The source's own location text, verbatim. May be an address. |
| `town` | string \| null | The town whose coordinates were used, when `precision` is `town`. |
| `lat` / `lng` | number \| null | 6 decimal places. `null` only when nothing could place it. |
| `precision` | enum | How much to trust the point. See below. |
| `coordSource` | string \| null | URL the coordinate came from. Required whenever `precision` starts with `exact`. |
| `coordMatch` | object \| null | How the pin was placed: `{ kind, confidence, why, osmName }`. Surfaced on the card. |
| `builtYear` | number \| null | First year mentioned. `1915–1916` → `1915`. |
| `builtCirca` | boolean | True for `c. 2014`, "early 1980s", etc. |
| `builtRaw` | string \| null | The original Built cell as prose. |
| `era` | enum | `pioneer (pre-1970)` · `boom (1970s–early 80s)` · `late century (1985–1999)` · `revival (2000s–2014)` · `modern (2015+)` · `unknown` |
| `heightM` | number \| null | **Only when the source supports a height claim.** See below. |
| `lengthM` | number \| null | Set when the source says "long"/"wide"/"diameter". |
| `sizeMaxM` | number \| null | Largest quoted dimension on any axis. Use this for "how big". |
| `sizeKind` | enum | `height` · `length` · `dimensions` · `unknown` |
| `dimsM` | number[] | Every quoted dimension, in metres. |
| `sizeRaw` | string \| null | The rendered size text. |
| `category` | enum | Nine playful categories. See below. |
| `status` | enum | `standing` · `demolished` · `removed` · `relocated` · `replaced` |
| `statusEvidence` | string \| null | The sentence that justified a non-standing status. |
| `notes` | string \| null | The source's Notes prose, cleaned. |
| `blurb` | string \| null | Wikivoyage's travel-guide voice, where it wrote one. |
| `image` | string \| null | Wikimedia Commons filename, used as the key into the vendored copy in `web/img/`. Licence and photographer live in `data/image-credits.json`. |
| `wikipediaArticle` | string \| null | Its own article, when it has one (not a `#section` pointer). |
| `wikidata` | string \| null | QID where known. |
| `osmId` | string \| null | e.g. `way/1019373169`. |
| `sources` | array | `{ source, page, url }` per contributing source. Never empty. |
| `correction` | object \| null | `{ why, source }` when a curated override touched this row. |
| `addedManually` | boolean? | Present on rows absent from both wiki lists — a curated addition or a discovery. |
| `sourceCategories` | string[]? | The community catalogue's own subject categories, when it had them. |
| `evChargerNearby` | boolean? | `true` only when an OSM-mapped EV charger sits within 500 m (walking distance). Optional: absent entirely if `cache/ev-chargers.json` was never fetched (`npm run fetch:ev`). See [BUILDING.md](BUILDING.md#stage-4d--ev-charger-proximity-srcfetch-ev-chargersjs). |

## Coordinate precision

Wikipedia's table names a **town**, not a point. Resolution runs in tiers, best first, and each
candidate must fall inside its state's bounding box before it is accepted:

1. **`exact-article`** — the sculpture's own Wikipedia article carries coordinates. A
   `#section` link into the town's article does *not* count.
2. **`exact-wikivoyage`** — a Wikivoyage `{{see}}` marker matching name + state.
3. **`exact-osm`** — a name-matched OpenStreetMap feature, either a whole-name match anywhere
   in the right state, or a fuzzy match close to the town (see the matcher rules in
   [BUILDING.md](BUILDING.md#stage-4--the-coordinate-upgrade-loop)). Features tagged
   `tourism=attraction|artwork`, `artwork_type`, `man_made=sculpture` or `historic` are
   preferred over generic POIs.
4. **`exact-inline`** — a `{{coord}}` template inline in the table.
5. **`exact-verified`** — independently looked up and confirmed against OSM/Nominatim or an
   operator's own address, or a mapped position published by a community catalogue at four or
   more decimal places.
6. **`town`** — the town's coordinates. **This is not where the sculpture is.** The app draws
   these with a dashed pin border and a `📍 town-level pin` badge, says so in words on the
   card, and offers a filter to hide them.
7. **`none`** — could not be placed at all.

The OSM name index is noisy: an unfiltered Overpass query for Australian features named
"Big *" returns ~2,300 elements, most of them creeks, hills and campgrounds. Anything matching
a physical-geography noise list is dropped unless it also carries a novelty/tourism tag.

## Sizes, and the 250-metre worm

The source article is inconsistent about which axis it quotes. `{{convert|250|*|4|m}}` for
The Giant Worm is a **250 m long** walk-through tunnel, not a 250 m tall worm; treating the
larger dimension as a height invents a structure taller than any building in Australia.

So `parseSize()` only claims a height when the source supports it:

| Source text | `sizeKind` | `heightM` | `lengthM` | `sizeMaxM` |
|---|---|---|---|---|
| `8 m` (lone measurement) | `height` | 8 | — | 8 |
| `3 m tall` | `height` | 3 | — | 3 |
| `119 m long` | `length` | — | 119 | 119 |
| `250 × 4 m` (no qualifier) | `dimensions` | **null** | — | 250 |
| `10-foot-high (3.0 m)` | `height` | 3 | — | 3 |

`dataset.test.js` asserts that no record has a `heightM` while `sizeKind` is `dimensions`.
Use `sizeMaxM` for "biggest" rankings and `heightM` only when you mean height.

## Status, and the Hawaiian water tower

Status is inferred from the Notes prose by keyword, with the matching sentence retained as
`statusEvidence` so any claim can be audited.

The first implementation marked **The Big Pineapple at Woombye** as demolished. Its notes read:

> "…is claimed to be the world's largest pineapple, gaining this title after a large
> pineapple-shaped water tower in Hawaii **was dismantled** in 1993."

The demolition belonged to a *different structure on another continent*, in a subordinate
clause. `inferStatus()` now trims each sentence to its main clause at the first subordinating
conjunction (`after`, `although`, `because`, `while`, `gaining this title`, `see`…) before
testing keywords. The Woombye pineapple is heritage-listed and reopened in June 2024; the
Gympie one really was demolished in 2008, and still reads as such.

Refurbishment is deliberately **not** a lifecycle change. The Ballina Big Prawn survived a 2009
council demolition vote and was refurbished in situ by Bunnings in 2013 — it is `standing`, not
`replaced`. Only `replaced`/`rebuilt`/`remodelled` set that status.

Precedence: `demolished` > `removed` > `relocated` > `replaced` > `standing`.

## Categories

Nine buckets, matched against the name first and the notes second, first rule winning:

`fruit-and-veg` · `fauna` · `seafood` · `food-and-drink` · `machinery-and-transport` ·
`tools-and-industry` · `sport-and-leisure` · `people-and-culture` · `oddity`

Ordering matters. `seafood` precedes `fauna` so a Big Prawn is seafood, not fauna. Musical
instruments live in `people-and-culture` — the Big Golden Guitar was briefly classified as
sport because "guitar" sat in the sport rule.

`oddity` is the honest fallback, not a dumping ground: it holds the genuinely uncategorisable
(Big Peg, Big Rubik's Cube, Big Sundial, Big Periodic Table).

A tenth category, `sculpture`, exists outside this chain — no rule assigns it automatically, only
a hand-written correction does (see docs/ADMIN.md). It's for commissioned or fine-art pieces that
happen to be big, as distinct from roadside novelty advertising built to be a tourist drawcard —
candidates raised so far include Tony Albert's *Yininmadyemi*, *Almost Once*, and The Big Poppies.
Whether something is a "big thing" or a "sculpture" is a judgement call about intent, not
something text-matching can make.

## Where the records come from

| Origin | Rows | Notes |
|---|---|---|
| Wikipedia's big-things tables | 335 | the spine: names, towns, years, sizes, prose |
| Wikivoyage-only entries | ~40 | things the Wikipedia tables omit |
| Community catalogues | 100 | facts only — name, place, coordinate, subject category |
| Curated additions | 2 | named in reporting, absent from every list |

Row counts shift as upstream changes; `node src/cli.js --stats` prints the current split.

## Scope: what counts as a Big Thing

The community catalogues are broader than this dataset. They file civic public art, war
memorials and gallery pieces alongside fibreglass fruit. Absorbing those would quietly
redefine the collection, and putting an Indigenous service memorial on a playful novelty map
is a tonal error as much as a taxonomic one.

The scope test therefore defers to the catalogue's own taxonomy rather than our judgement: a
`big-*` subject category, or a `big-things` / `roadside-attractions` tag. That turned out to
be better than intuition in both directions — it kept "Bigfoot" and "Chickaletta" in, which a
name-based guess dropped, and it also revealed that the catalogue itself considers Brett
Whiteley's giant matchsticks a Big Thing, which is a defensible reading of "giant everyday
object" that we had been ready to overrule.

Anything that fails the test is written to `data/discovered-review.json` with the reason, not
dropped. Exactly one row sits there today.

## Photographs

`data/image-credits.json` holds one entry per vendored photograph:

| Field | Meaning |
|---|---|
| `local` | path within `web/`, e.g. `img/big-banana-5d7f2a.jpg` |
| `sha256` / `bytes` | checksum and size of the local copy; a test fails on drift |
| `licence` / `licenceCode` / `licenceUrl` | human name, machine code, and deed URL |
| `author` | the photographer, as Commons records them |
| `attributionRequired` | true for CC BY and CC BY-SA |
| `filePage` | the Commons (or Wikipedia) file page |
| `host` | which project hosts it — four are on English Wikipedia, not Commons |

The app renders `author · licence · via Wikimedia Commons` under every photo, each part linked.
That is a licence condition for the CC BY and CC BY-SA files, which are the large majority.

Photographs keep their own licences and are **not** covered by this repository's CC BY-SA 4.0
dataset licence. `docs/IMAGE-CREDITS.md` is the full list.

## Geocoding traps

Two failure modes bit hard enough to be worth naming, because both produced a
confidently-wrong pin rather than an obviously-missing one:

**Road names that are also place names.** "Forrest Highway, just north of Bunbury" had its
road type stripped and matched *Forrest, Western Australia* — a real Nullarbor locality
1,200 km away. Fergus the Bull sat there until a sanity sweep of every town-level pin whose
Location names a road caught it. `placeCandidates()` now emits road-derived candidates last,
and a test pins the ordering.

**Same name, different sculpture.** A 30 km match radius paired Latrobe's Big Platypus with a
different Giant Platypus 29 km away. The radius is now 12 km, and where two candidates match
equally well more than 500 m apart, the matcher refuses outright and the record stays at town
level.

The lesson both share: a bounding-box check is not a correctness check. A wrong point inside
the right state passes every structural test in the suite. What actually caught these was
sweeping for *large disagreements* — pins that moved a long way when re-derived — and reading
the outliers.

## Known limitations

- **Coverage is not the census.** 378 verifiable entries against a claimed 1,075. Rural and
  privately-owned big things are systematically under-listed on both wikis.
- **A third of pins are town-level.** 164 of 477. Labelled, filterable, explained on the
  card, never disguised. Bringing this down further is manual work: OpenStreetMap simply does
  not have most of these sculptures, so each remaining one needs a source that states an
  address.
- **`builtYear` is missing for ~45%** of records because the source cell is empty.
- **Status reflects what the sources say**, which lags reality. A big thing demolished last
  month may still read as standing until Wikipedia catches up.
- **Straight-line distances.** The road-trip builder uses haversine at 80 km/h, which is a
  lower bound on real driving. The app says so on the summary card.
- **Duplicate names are real, not errors.** Nine Big Apples, four Big Crocodiles. Dedup keys on
  name **and** town, never name alone.
