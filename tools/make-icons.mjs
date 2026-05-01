// Generates the extension's PNG icons (16, 32, 48, 128) from raw pixel
// data. No external deps — Node ships zlib + Buffer, which is enough to
// build a valid PNG file by hand.
//
// Design: dark background (#0a0a0d) with the gold ring + filled disc
// from the brand mark. Matches the popup brand-mark gradient.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'src/icons');
mkdirSync(outDir, { recursive: true });

// Brand colors — kept in sync with src/popup.css :root vars.
const BG = [0x0a, 0x0a, 0x0d, 0xff];
const GOLD = [0xd4, 0xa0, 0x4c, 0xff];
const GOLD_DEEP = [0xb9, 0x86, 0x3a, 0xff];
const HIGHLIGHT = [0xf5, 0xd2, 0x8a, 0xff];

// CRC32 — table-driven, taken from the PNG spec appendix.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

function blend(over, under) {
  const a = over[3] / 255;
  return [
    Math.round(over[0] * a + under[0] * (1 - a)),
    Math.round(over[1] * a + under[1] * (1 - a)),
    Math.round(over[2] * a + under[2] * (1 - a)),
    255,
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Per-pixel renderer. Coords are in [0,size)×[0,size).
function shade(x, y, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Outer rounded square — ~12% corner radius.
  const outer = size * 0.5 - size * 0.04;
  const inner = size * 0.34;

  // Background fill — dark bg, with a subtle top-left vignette so the
  // icon doesn't look flat at large sizes.
  const vignetteT = smoothstep(size * 0.0, size * 0.9, x + y);
  const bg = lerp([0x14, 0x14, 0x1a, 0xff], BG, vignetteT);

  // Outside the outer disc → transparent (rounded corners). Antialiased
  // by linear ramp over 1px.
  if (dist > outer + 1.2) return [0, 0, 0, 0];

  let pixel = bg;

  // Gold ring band between outer*0.78 and outer*0.94.
  const ringInner = outer * 0.78;
  const ringOuter = outer * 0.94;
  if (dist >= ringInner - 1 && dist <= ringOuter + 1) {
    const ringAlpha = smoothstep(ringInner - 1, ringInner, dist) * (1 - smoothstep(ringOuter, ringOuter + 1, dist));
    const ringColor = lerp(GOLD, GOLD_DEEP, smoothstep(ringInner, ringOuter, dist));
    pixel = blend([ringColor[0], ringColor[1], ringColor[2], Math.round(ringAlpha * 255)], pixel);
  }

  // Inner gold disc — the brand mark itself.
  if (dist <= inner + 1) {
    const a = 1 - smoothstep(inner - 1, inner + 1, dist);
    // Top-left highlight gradient on the disc.
    const t = smoothstep(-size * 0.3, size * 0.3, dx + dy);
    const discColor = lerp(HIGHLIGHT, GOLD_DEEP, t);
    pixel = blend([discColor[0], discColor[1], discColor[2], Math.round(a * 255)], pixel);
  }

  // Overall outer-edge antialiasing → fade to transparent.
  if (dist > outer) {
    const a = 1 - smoothstep(outer, outer + 1.2, dist);
    pixel = [pixel[0], pixel[1], pixel[2], Math.round(pixel[3] * a)];
  }

  return pixel;
}

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);    // bit depth
  ihdr.writeUInt8(6, 9);    // color type RGBA
  ihdr.writeUInt8(0, 10);   // compression
  ihdr.writeUInt8(0, 11);   // filter
  ihdr.writeUInt8(0, 12);   // interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter byte (none)
    for (let x = 0; x < size; x++) {
      const px = shade(x, y, size);
      raw[o++] = px[0];
      raw[o++] = px[1];
      raw[o++] = px[2];
      raw[o++] = px[3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 32, 48, 128];

// Prefer the brand logo if it's been dropped into the icon dir. Resample
// via `sips` (macOS) or `magick`/`convert` (ImageMagick on Linux) — both
// preserve the alpha channel, which the synthetic generator can't easily
// match for the real shield artwork.
const SOURCE = resolve(outDir, 'source-logo.png');

function tryResample(src, size, dest) {
  try {
    execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), src, '--out', dest], { stdio: 'ignore' });
    return true;
  } catch (_) { /* sips not available — fall through */ }
  try {
    execFileSync('magick', [src, '-resize', `${size}x${size}`, dest], { stdio: 'ignore' });
    return true;
  } catch (_) { /* magick not available */ }
  try {
    execFileSync('convert', [src, '-resize', `${size}x${size}`, dest], { stdio: 'ignore' });
    return true;
  } catch (_) { /* convert not available */ }
  return false;
}

const useSource = existsSync(SOURCE);

for (const s of sizes) {
  const path = resolve(outDir, `icon-${s}.png`);
  if (useSource && tryResample(SOURCE, s, path)) {
    console.log(`resampled icon-${s}.png from source-logo.png`);
    continue;
  }
  const png = makePng(s);
  writeFileSync(path, png);
  console.log(`wrote synthetic icon-${s}.png (${png.length} bytes)`);
}

if (!useSource) {
  console.log('\nTip: drop a square PNG at src/icons/source-logo.png and re-run');
  console.log('     to use your real brand artwork instead of the synthetic placeholder.');
}
