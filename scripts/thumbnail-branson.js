/**
 * Generate small thumbnails for all Branson photos so we can browse them quickly.
 * Outputs to scripts/_branson_thumbs/ (gitignored).
 *
 * Run: node scripts/thumbnail-branson.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = 'G:/My Drive/JORD Golf/Content Photography & Video/Branson Golf Shoot';
const OUT = path.join(__dirname, '_branson_thumbs');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const files = fs.readdirSync(SRC).filter(f => /\.jpe?g$/i.test(f)).sort();
  console.log(`Generating ${files.length} thumbnails...`);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const outFile = path.join(OUT, f.replace(/\.jpe?g$/i, '.jpg'));
    if (fs.existsSync(outFile)) continue;
    try {
      await sharp(path.join(SRC, f))
        .rotate() // respect EXIF orientation
        .resize({ width: 320, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(outFile);
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${files.length}`);
    } catch (e) {
      console.log(`  skipped ${f}: ${e.message}`);
    }
  }
  console.log(`Done. Thumbnails in ${OUT}`);
})();
