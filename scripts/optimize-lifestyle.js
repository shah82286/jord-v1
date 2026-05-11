/**
 * Optimize selected Branson photos for web use.
 * - Source: G:/My Drive/JORD Golf/Content Photography & Video/Branson Golf Shoot
 * - Output: public/img/lifestyle/
 * - Generates 3 sizes (2400w hero, 1600w content, 800w mobile) in JPG + WebP
 *
 * Run: node scripts/optimize-lifestyle.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = 'G:/My Drive/JORD Golf/Content Photography & Video/Branson Golf Shoot';
const OUT = path.join(__dirname, '..', 'public', 'img', 'lifestyle');

// Curated selection: source filename → output basename + crop hint
// Picked to cover: hero landscapes, action, lifestyle, group, product, scenic
const SELECTION = [
  { src: 'Jord_Branson102.jpg', name: 'hero-swing-fairway' },    // CONFIRMED: swing with bag, course backdrop
  { src: 'Jord_Branson138.jpg', name: 'action-1' },
  { src: 'Jord_Branson150.jpg', name: 'editorial-two-walking' }, // CONFIRMED: two players walking
  { src: 'Jord_Branson165.jpg', name: 'action-2' },
  { src: 'Jord_Branson178.jpg', name: 'portrait-rangefinder' },  // CONFIRMED: rangefinder portrait
  { src: 'Jord_Branson195.jpg', name: 'lifestyle-1' },
  { src: 'Jord_Branson210.jpg', name: 'hero-drive-followthrough' }, // CONFIRMED: driver follow-through
  { src: 'Jord_Branson240.jpg', name: 'lifestyle-2' },
  { src: 'Jord_Branson265.jpg', name: 'portrait-2' },
  { src: 'Jord_Branson285.jpg', name: 'lifestyle-scorecard' },   // CONFIRMED: green polo writing
  { src: 'Jord_Branson310.jpg', name: 'detail-pickup' },         // CONFIRMED: club pickup detail
  { src: 'Jord_Branson320.jpg', name: 'scenic-1' },
];

const SIZES = [
  { suffix: '-2400', width: 2400 },  // hero / large
  { suffix: '-1600', width: 1600 },  // content
  { suffix: '-800',  width: 800  },  // mobile / preview
];

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  for (const pick of SELECTION) {
    const srcPath = path.join(SRC, pick.src);
    if (!fs.existsSync(srcPath)) {
      console.log(`  SKIP: ${pick.src} not found`);
      continue;
    }
    console.log(`Processing ${pick.src} → ${pick.name}`);

    for (const sz of SIZES) {
      const base = path.join(OUT, `${pick.name}${sz.suffix}`);
      try {
        // JPG
        await sharp(srcPath)
          .rotate()
          .resize({ width: sz.width, withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(base + '.jpg');
        // WebP (smaller, modern browsers)
        await sharp(srcPath)
          .rotate()
          .resize({ width: sz.width, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(base + '.webp');
        console.log(`  ✓ ${pick.name}${sz.suffix}.jpg + .webp`);
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
      }
    }
  }
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
