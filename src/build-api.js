'use strict';
/**
 * The app-facing copy of the dataset, published under /data/ (see docs/DATA.md,
 * "For app developers"). It is derived from data/bigthings.json at deploy time;
 * nothing in data/ is modified.
 *
 *   bigthings.json         every record, plus imageUrl and imageCredit resolved
 *   bigthings-au.geojson   the same enriched records as GeoJSON points
 *   version.json           generated / count / bytes / sha256 of bigthings.json,
 *                          a cheap "has anything changed?" check
 *
 * The GeoJSON is generated here rather than copied from data/, which is not
 * rebuilt by `npm run build` and can lag behind bigthings.json.
 */

const crypto = require('crypto');

/** A copy of `thing` plus imageUrl (absolute) and imageCredit; both null without a credited photo. */
function enrichThing(thing, credits, siteUrl) {
  const credit = thing.image ? credits[thing.image] : null;
  if (!credit) return { ...thing, imageUrl: null, imageCredit: null };
  return {
    ...thing,
    imageUrl: `${siteUrl}/${credit.local}`,
    imageCredit: {
      author: credit.author,
      licence: credit.licence,
      licenceUrl: credit.licenceUrl,
      filePage: credit.filePage,
    },
  };
}

function buildApi({ dataset, credits, siteUrl }) {
  const things = dataset.things.map((t) => enrichThing(t, credits, siteUrl));
  const json = JSON.stringify({ ...dataset, things });
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: things.filter((t) => t.lat != null && t.lng != null).map((t) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
      properties: t,
    })),
  });
  const version = {
    generated: dataset.meta.generated,
    count: things.length,
    bytes: Buffer.byteLength(json),
    sha256: crypto.createHash('sha256').update(json).digest('hex'),
  };
  return { json, geojson, version };
}

module.exports = { enrichThing, buildApi };
