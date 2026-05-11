/**
 * Build a single contact sheet image from all thumbnails so we can browse fast.
 * Outputs multiple sheets if there are many photos.
 *
 * Run: node scripts/contact-sheet.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '_branson_thumbs');
const OUT_DIR = path.join(__dirname, '_branson_thumbs');

const TILE_W = 400;
const TILE_H = 300;
const COLS = 5;
const ROWS = 6; // 30 per sheet
const PER_SHEET = COLS * ROWS;
const LABEL_H = 28;

(async () => {
  const files = fs.readdirSync(SRC).filter(f => /\.jpe?g$/i.test(f)).sort();
  const sheets = Math.ceil(files.length / PER_SHEET);
  console.log(`${files.length} thumbnails → ${sheets} contact sheets`);

  for (let s = 0; s < sheets; s++) {
    const batch = files.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const sheetW = COLS * TILE_W;
    const sheetH = Math.ceil(batch.length / COLS) * (TILE_H + LABEL_H);

    const composites = [];
    for (let i = 0; i < batch.length; i++) {
      const x = (i % COLS) * TILE_W;
      const y = Math.floor(i / COLS) * (TILE_H + LABEL_H);
      const num = batch[i].replace(/Jord_Branson|\.jpg/g, '');

      // resized image
      const imgBuf = await sharp(path.join(SRC, batch[i]))
        .resize({ width: TILE_W, height: TILE_H, fit: 'cover' })
        .toBuffer();
      composites.push({ input: imgBuf, left: x, top: y });

      // label
      const labelSvg = Buffer.from(
        `<svg width="${TILE_W}" height="${LABEL_H}">
          <rect width="${TILE_W}" height="${LABEL_H}" fill="black"/>
          <text x="6" y="14" font-family="monospace" font-size="13" fill="white">${num}</text>
        </svg>`
      );
      composites.push({ input: labelSvg, left: x, top: y + TILE_H });
    }

    const outFile = path.join(OUT_DIR, `_sheet_${String(s + 1).padStart(2, '0')}.jpg`);
    await sharp({
      create: { width: sheetW, height: sheetH, channels: 3, background: { r: 0, g: 0, b: 0 } }
    })
      .composite(composites)
      .jpeg({ quality: 80 })
      .toFile(outFile);
    console.log(`  ${outFile}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
