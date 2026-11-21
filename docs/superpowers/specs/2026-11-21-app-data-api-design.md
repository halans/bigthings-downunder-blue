# Publish the dataset for the iOS app (design, approved 2026-11-21)

## Intent
An iOS app will use bigthings.downunder.blue as its datasource. The site currently publishes only HTML, `img/` and `vendor/`; the dataset stays in `data/`.

## Goals
- Publish `/data/bigthings.json` and `/data/bigthings-au.geojson` into `public/` at build time.
- Each published record keeps `image` and gains `imageUrl` (absolute, from `data/site.json` `siteUrl`, or `null`) and `imageCredit` (`author`, `licence`, `licenceUrl`, `filePage`, or `null`). Attribution is a licence condition, so the credit travels with the URL.
- Publish `/data/version.json` (`generated`, record count, bytes, sha256 of the JSON) as a cheap update check.
- `_headers`: `/data/*` revalidates every time so ETags decide re-download.
- Test the output; document it in `docs/DATA.md` under "For app developers".

## Non-goals / anti-goals
- No change to `data/` source files or to the pages. The enrichment exists only in `public/`.
- No separate credits file (credit is inline, which is the "merged" option).
- No app-side API, auth, pagination or CORS.
- Compression and ETags are left to Cloudflare Pages.

## Approaches
1. **New `src/build-api.js` called from `build-public.js` (chosen).** Isolated, testable, leaves generated `data/` untouched.
2. Enrich inside `build.js` and write into `data/`. Rejected: bloats the canonical dataset and the CLI and page generators would see the extra fields.
3. Copy files verbatim and let the app join credits. Rejected: it makes the app do the extra lookup.

## Constraints
- Zero runtime dependencies, Node >=18 CommonJS.
- Credit lookup must reuse `loadImageCredits()` from `src/image-credits.js`, which merges Commons and custom photos.
- `imageUrl` must point to a file that exists in `public/img/`.

## Left to the builder
Exact module layout, test file name, and the wording of the docs section.
