/**
 * commons-search.js — helper used while curating clue images.
 * Queries the Wikimedia Commons API for candidate files and prints each file's
 * licence metadata so that every asset can be checked individually.
 *
 * Usage: node tools/commons-search.js "search terms" [limit]
 */
const query = process.argv[2];
const limit = process.argv[3] || 6;
const ALLOWED = /^(CC0|Public domain|PD|CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0))/i;
const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
  action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
  gsrsearch: 'filetype:bitmap ' + query, gsrlimit: String(limit),
  prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '960',
});
fetch(url, { headers: { 'User-Agent': 'WhereInTheWorldGame/1.0 (asset curation script)' } })
  .then((r) => r.json())
  .then((j) => {
    const pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index);
    for (const p of pages) {
      const ii = p.imageinfo[0];
      const m = ii.extmetadata || {};
      const lic = (m.LicenseShortName && m.LicenseShortName.value) || '?';
      const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      console.log(JSON.stringify({
        ok: ALLOWED.test(lic),
        title: p.title,
        licence: lic,
        licenceUrl: m.LicenseUrl && m.LicenseUrl.value,
        artist: strip(m.Artist && m.Artist.value),
        credit: strip(m.Credit && m.Credit.value).slice(0, 120),
        attributionRequired: m.AttributionRequired && m.AttributionRequired.value,
        restrictions: m.Restrictions && m.Restrictions.value,
        size: ii.width + 'x' + ii.height,
        thumb: ii.thumburl,
        page: ii.descriptionurl,
      }));
    }
  })
  .catch((e) => console.error('ERR', e.message));
