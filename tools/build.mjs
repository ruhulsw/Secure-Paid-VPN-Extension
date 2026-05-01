// Builds a flat extension folder for each browser target. We keep one
// source tree under `src/` and emit:
//   dist/chrome/   — Manifest V3 with `service_worker` background entry
//   dist/firefox/  — Manifest V3 with `scripts` background entry + gecko id
//
// No bundler. Browser extensions don't need one — we just merge manifests
// and copy files. Run via `npm run build` or `node tools/build.mjs [target]`.

import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const ICONS = resolve(SRC, 'icons');
const DIST = resolve(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox'];

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function ensureIcons() {
  if (existsSync(resolve(ICONS, 'icon-128.png'))) return;
  console.log('icons missing — generating...');
  const { default: _ } = await import('./make-icons.mjs');
}

async function rmrf(path) {
  await fs.rm(path, { recursive: true, force: true });
}

async function copyTree(srcDir, destDir, filter) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (filter && !filter(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath, filter);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

function mergeManifest(base, override) {
  const out = JSON.parse(JSON.stringify(base));

  for (const [k, v] of Object.entries(override)) {
    if (k === 'permissions_append') {
      out.permissions = (out.permissions || []).concat(v);
      continue;
    }
    if (k === 'host_permissions_append') {
      out.host_permissions = (out.host_permissions || []).concat(v);
      continue;
    }
    if (k === 'background') {
      out.background = v; // replace wholesale — Chrome and Firefox use different shapes
      continue;
    }
    out[k] = v;
  }

  // De-dupe permission arrays — overrides may overlap with base.
  if (Array.isArray(out.permissions)) out.permissions = Array.from(new Set(out.permissions));
  if (Array.isArray(out.host_permissions)) out.host_permissions = Array.from(new Set(out.host_permissions));

  return out;
}

async function buildTarget(target) {
  const targetDist = resolve(DIST, target);
  await rmrf(targetDist);
  await fs.mkdir(targetDist, { recursive: true });

  // Copy everything in src/ except the per-browser manifest files and
  // build-time-only source assets (the high-res brand logo lives in the
  // repo so the icon generator can reach for it, but the extension only
  // needs the resampled PNGs).
  await copyTree(SRC, targetDist, (p, entry) => {
    if (entry.isFile() && /^manifest\.(base|chrome|firefox)\.json$/.test(entry.name)) return false;
    if (entry.name === '.DS_Store') return false;
    if (entry.isFile() && entry.name === 'source-logo.png') return false;
    return true;
  });

  const base = await readJson(resolve(SRC, 'manifest.base.json'));
  const override = await readJson(resolve(SRC, `manifest.${target}.json`));
  const manifest = mergeManifest(base, override);

  await fs.writeFile(
    resolve(targetDist, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  // Sanity check: required entry points exist.
  const required = ['popup.html', 'popup.js', 'background.js', 'options.html', 'options.js'];
  for (const f of required) {
    if (!existsSync(resolve(targetDist, f))) {
      throw new Error(`[${target}] missing built file: ${f}`);
    }
  }

  const size = await dirSize(targetDist);
  console.log(`✓ ${target}: ${relative(ROOT, targetDist)} (${(size / 1024).toFixed(1)} KB)`);
}

async function dirSize(p) {
  let total = 0;
  for (const entry of await fs.readdir(p, { withFileTypes: true })) {
    const child = join(p, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

async function main() {
  const wanted = process.argv.slice(2).filter(Boolean);
  const targets = wanted.length ? wanted : TARGETS;
  for (const t of targets) {
    if (!TARGETS.includes(t)) {
      console.error(`unknown target: ${t}. Use one of: ${TARGETS.join(', ')}`);
      process.exit(2);
    }
  }

  await ensureIcons();
  await fs.mkdir(DIST, { recursive: true });

  for (const t of targets) await buildTarget(t);
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
