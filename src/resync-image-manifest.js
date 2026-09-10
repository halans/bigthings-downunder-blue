'use strict';
/**
 * Recompute bytes + SHA-256 for every vendored image already recorded in
 * data/image-credits.json, from whatever is currently on disk in web/img/.
 *
 * Exists for exactly one case: a file was re-encoded locally (recompressed to
 * shrink the image bundle) outside src/fetch-images.js, so its checksum no
 * longer matches what's recorded. Without this, the next `npm run images`
 * would see that mismatch and silently re-download the original from Commons,
 * undoing the recompression. This script never touches web/img/ itself and
 * never contacts the network — it only makes the manifest tell the truth
 * about the bytes that are already there.
 *
 * Nothing else in the record changes: licence, author and file page describe
 * the photograph, not its encoding, and stay put.
 *
 *   node src/resync-image-manifest.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'data', 'image-credits.json');

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let changed = 0;
  let missing = 0;

  for (const [file, meta] of Object.entries(manifest.images || {})) {
    const p = path.join(ROOT, 'web', meta.local);
    if (!fs.existsSync(p)) { missing++; console.log(`  missing on disk, left alone: ${meta.local}`); continue; }
    const body = fs.readFileSync(p);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (sha256 !== meta.sha256 || body.length !== meta.bytes) {
      meta.sha256 = sha256;
      meta.bytes = body.length;
      changed++;
    }
  }

  manifest.generated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`resynced ${changed} of ${Object.keys(manifest.images).length} image records to match web/img/`);
  if (missing) console.log(`${missing} recorded file(s) not found on disk — left unchanged`);
}

if (require.main === module) main();

module.exports = { main };
