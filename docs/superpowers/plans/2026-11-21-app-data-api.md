# App Data API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an app-friendly copy of the dataset (`/data/bigthings.json`, `/data/bigthings-au.geojson`, `/data/version.json`) in `public/` at build time, with image URLs and credits resolved inline.

**Architecture:** A new pure-ish module `src/build-api.js` turns `data/bigthings.json` + the merged credit map into three output strings; `build-public.js` writes them to `public/data/` and adds a `/data/*` rule to `_headers`. Nothing in `data/` changes. GeoJSON is generated from the dataset, not copied (see Review Focus).

**Tech Stack:** Node >=18 CommonJS, zero dependencies, the repo's own `test/run.js` runner.

**Spec:** `docs/superpowers/specs/2026-11-21-app-data-api-design.md`

## Global Constraints

- Zero runtime dependencies; Node >=18 CommonJS.
- `data/` source files are never modified; enrichment exists only in `public/`.
- `imageUrl` is absolute: `${siteUrl}/${credit.local}` with `siteUrl` from `SEO.loadSite()`; `credit.local` looks like `img/foo.jpg` or `img/custom/foo.jpeg`.
- Credits come from `loadImageCredits()` in `src/image-credits.js` (merges Commons and `custom:` photos).
- Each record keeps its `image` key and gains `imageUrl` and `imageCredit` (`{author, licence, licenceUrl, filePage}`); both are `null` when there is no photo.
- `version.json` fields: `generated`, `count`, `bytes`, `sha256` (of the published `bigthings.json` bytes).
- `_headers`: `/data/*` revalidates on every request.
- No separate credits file; no CORS, auth or pagination.
- `npm test` is the only trustworthy pass/fail (running one test file directly prints dots only).

## Review Focus

- `data/bigthings-au.geojson` is stale (Sep 13, 477 features vs 481 records) and nothing in `src/` regenerates it; the published GeoJSON must therefore be built from `bigthings.json`, never copied. Test: feature count equals records with non-null `lat`.
- Records with `lat == null` must not become features with `[null, null]` coordinates. Test: every feature has finite numeric coordinates.
- A record whose `image` has no credit entry must publish `imageUrl: null` and `imageCredit: null`, not `undefined` or a broken URL. Test with a synthetic record; assert on the real dataset that no record with an `image` ends up with a null `imageUrl`.
- `imageUrl` must point at a file that exists (`web/img/...`, which `build-public` copies to `public/img/`). Test: every real `imageUrl` maps to an existing file.
- `version.json` `sha256`/`bytes` must match the file actually written (the app uses it as the update signal). Test: recompute from the written string.

---

### Task 1: `src/build-api.js` and its tests

**Files:**
- Create: `src/build-api.js`
- Create: `test/api.test.js`

**Interfaces:**
- Produces:
  - `enrichThing(thing: object, credits: object, siteUrl: string) -> object` — returns a copy of `thing` plus `imageUrl: string|null`, `imageCredit: {author, licence, licenceUrl, filePage}|null`.
  - `buildApi({ dataset, credits, siteUrl }) -> { json: string, geojson: string, version: {generated, count, bytes, sha256} }` — `json` is the full dataset (`meta` unchanged, `things` enriched) minified; `geojson` is a minified FeatureCollection of enriched records with non-null `lat`, `geometry.coordinates = [lng, lat]`, `properties` = the whole enriched record; `version.count = dataset.things.length`, `bytes = Buffer.byteLength(json)`, `sha256 = hex digest of json`.

- [ ] **Step 1: Write the failing tests in `test/api.test.js`** (use `const { test, eq, ok } = require('./run')`). Tests, with a synthetic dataset of three things (one with a Commons-style key and credit, one `custom:` key, one with `image: null`, one with `lat: null`) and `siteUrl = 'https://example.test'`:
  - `enrichThing` resolves `imageUrl` to `'https://example.test/img/x.jpg'` and `imageCredit` to exactly the four fields, with `image` preserved.
  - `enrichThing` with `image: null` gives `imageUrl: null, imageCredit: null`; with an `image` key missing from `credits` also gives both `null`.
  - `buildApi` geojson has one feature per record with non-null `lat`, `coordinates` equal `[lng, lat]`, and all coordinates finite.
  - `buildApi` version: `eq(version.count, 4)`, `bytes` equals `Buffer.byteLength(json)`, `sha256` equals `crypto.createHash('sha256').update(json).digest('hex')`.
  - `buildApi` does not mutate the input `dataset` (deep-compare a JSON snapshot taken before the call).
  - Real data (read `data/bigthings.json` and `loadImageCredits()`; `siteUrl` from `SEO.loadSite()`): every record with an `image` has a non-null `imageUrl` and `imageCredit.author`; skip the file-existence assertion unless `web/img` exists, then assert `fs.existsSync(path.join(ROOT, 'web', new URL(imageUrl).pathname))` for every non-null `imageUrl`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL (`suite failed to load` for `api.test.js`, cannot find `../src/build-api`).

- [ ] **Step 3: Implement `enrichThing` and `buildApi` in `src/build-api.js`** using `crypto` for the hash; copy the record with a spread; output minified via `JSON.stringify(x)`. Export `{ enrichThing, buildApi, writeApi }` where `writeApi` is added in Task 2.

- [ ] **Step 4: Run `npm test`.** Expected: all suites pass including `api`.

- [ ] **Step 5: Commit** `src/build-api.js test/api.test.js` with message `feat: build app-facing dataset with resolved image URLs and credits`.

---

### Task 2: Wire into the public build, headers and docs

**Files:**
- Modify: `src/build-public.js` (HEADERS constant ~line 29; `main()` ~line 54-88)
- Modify: `src/build-api.js` (add `writeApi`)
- Modify: `docs/DATA.md` (new section "For app developers" before "Known limitations")
- Modify: `docs/BUILDING.md` (one line noting `public/data/` is produced by `build:public`)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `buildApi` from Task 1.
- Produces: `writeApi(publicDir: string) -> { json, geojson, version }` — reads dataset, credits and siteUrl itself, creates `<publicDir>/data/`, writes `bigthings.json`, `bigthings-au.geojson`, `version.json` (version pretty-printed with 2 spaces, trailing newline), returns what `buildApi` returned.

- [ ] **Step 1: Write the failing tests.**
  - `HEADERS` exported from `build-public.js` (add `HEADERS` to its `module.exports`) contains a `/data/*` block with `Cache-Control: public, max-age=0, must-revalidate`, and a `/data/bigthings-au.geojson` block with `Content-Type: application/geo+json`.
  - `writeApi` into a temp dir (`fs.mkdtempSync` under `os.tmpdir()`) writes all three files; `JSON.parse` of each succeeds; the written `bigthings.json` hashes to `version.json`'s `sha256` and its length to `bytes`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL on the new tests.

- [ ] **Step 3: Implement `writeApi` and call it from `main()` in `build-public.js`** after the `img/`/`vendor/` copy (so `public/` exists); extend `HEADERS` with the two blocks above; extend the final `console.log` to mention `data/`. Do not touch any other output.

- [ ] **Step 4: Add the docs.** `DATA.md` section covers: the three URLs, the added `imageUrl`/`imageCredit` fields, `version.json` fields, the revalidate-with-ETag pattern (`If-None-Match`, expect 304), that Cloudflare compresses on the wire, and that photo attribution (`imageCredit`) must be shown wherever `imageUrl` is displayed. Note that the GeoJSON is generated from the dataset at deploy time.

- [ ] **Step 5: Verify end to end.** Run `npm run build:public && npm test`, then `ls -l public/data` (three files; `bigthings.json` about the size of the source or smaller) and `node -e "const v=require('./public/data/version.json');console.log(v)"`. Expected: tests pass, `count` is 481 (current dataset size; compare to `data/bigthings.json`'s `things.length`).

- [ ] **Step 6: Commit** the changes with message `feat: publish /data API files, headers and docs`.
