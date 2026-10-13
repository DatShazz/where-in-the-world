/**
 * curate-images.js — one-off curation helper.
 * For each question ID + Commons search term, picks the first candidate whose
 * individual file licence is CC0 / Public domain / CC BY / CC BY-SA, downloads a
 * 960px rendition to assets/images/<id>-clue.jpg (neutral file name that does not
 * reveal the answer) and records the licence metadata in tools/image-candidates.json.
 * Every downloaded image was then visually reviewed by hand; rejected files are
 * re-curated with `skip` counts or removed (see tools/image-review.json).
 *
 * Usage: node tools/curate-images.js [onlyId] [skipN]
 */
const fs = require('fs');
const path = require('path');

const UA = { 'User-Agent': 'WhereInTheWorldGame/1.0 (asset curation script)' };
const ALLOWED = /^(CC0|Public domain|PD|CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0))/i;
const OUT_DIR = path.join(__dirname, '..', 'assets', 'images');
const META = path.join(__dirname, 'image-candidates.json');

const WANT = {
  Q023: 'kente cloth', Q034: 'intitle:Steelpan.jpeg', Q036: 'charango instrument', Q037: 'intitle:"Mongolian horse violin"',
  Q056: 'Pharomachrus mocinno', Q057: 'Okapia johnstoni', Q058: 'Ambystoma mexicanum',
  Q059: 'Varanus komodoensis', Q061: 'Raphus cucullatus skeleton', Q062: 'Ornithorhynchus anatinus swimming',
  Q063: 'Mellisuga helenae', Q064: 'Oryx leucoryx', Q078: 'Great Mosque of Djenne',
  Q081: 'Batad rice terraces', Q083: 'trulli Alberobello', Q085: 'Fujian tulou',
  Q087: 'Borgund stave church', Q089: 'intitle:"Honolulu Museum of Art, 3740.1"', Q090: 'matryoshka dolls',
  Q092: 'batik motif kain', Q093: 'kintsugi bowl', Q100: 'Salar de Uyuni',
  Q101: 'Dracaena cinnabari', Q102: 'Pamukkale travertine', Q103: 'Caño Cristales',
  Q104: 'Ha Long Bay karst', Q106: 'Deadvlei', Q107: 'Great Blue Hole',
  Q108: "Giant's Causeway basalt columns", Q109: 'Okavango Delta aerial', T12: 'Budorcas taxicolor',
};

async function search(term) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
    gsrsearch: 'filetype:bitmap ' + term, gsrlimit: '12',
    prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '960',
  });
  const r = await fetch(url, { headers: UA });
  const t = await r.text();
  if (!t.startsWith('{')) { console.log('rate limited, waiting 30s'); await new Promise((ok) => setTimeout(ok, 30000)); return search(term); }
  const j = JSON.parse(t);
  return Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index);
}

const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  const only = process.argv[2];
  const skip = Number(process.argv[3] || 0);
  const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8')) : {};
  for (const [id, term] of Object.entries(WANT)) {
    if (only && only !== id) continue;
    if (!only && meta[id]) continue;
    const pages = await search(term);
    let skipped = 0;
    let chosen = null;
    for (const p of pages) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii || ii.mime !== 'image/jpeg') continue;
      const m = ii.extmetadata || {};
      const lic = strip(m.LicenseShortName && m.LicenseShortName.value);
      if (!ALLOWED.test(lic)) continue;
      if (ii.width < 640) continue;
      if (skipped++ < skip) continue;
      chosen = {
        id, title: p.title.replace(/^File:/, ''), licence: lic,
        licenceUrl: strip(m.LicenseUrl && m.LicenseUrl.value) || '',
        creator: strip(m.Artist && m.Artist.value) || 'Unknown',
        credit: strip(m.Credit && m.Credit.value),
        attributionRequired: (m.AttributionRequired && m.AttributionRequired.value) === 'true',
        restrictions: strip(m.Restrictions && m.Restrictions.value),
        sourcePage: ii.descriptionurl, thumb: ii.thumburl,
      };
      break;
    }
    if (!chosen) { console.log(id, 'NO CANDIDATE'); continue; }
    const res = await fetch(chosen.thumb, { headers: UA });
    const buf = Buffer.from(await res.arrayBuffer());
    const file = `${id.toLowerCase()}-clue.jpg`;
    fs.writeFileSync(path.join(OUT_DIR, file), buf);
    chosen.file = 'assets/images/' + file;
    chosen.bytes = buf.length;
    chosen.downloaded = new Date().toISOString().slice(0, 10);
    meta[id] = chosen;
    console.log(id, '|', chosen.licence, '|', chosen.creator, '|', chosen.title, '|', buf.length);
    fs.writeFileSync(META, JSON.stringify(meta, null, 2));
    await new Promise((r) => setTimeout(r, 4000));
  }
  fs.writeFileSync(META, JSON.stringify(meta, null, 2));
})();
