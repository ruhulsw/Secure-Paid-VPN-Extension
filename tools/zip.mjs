// Packages each built target as a .zip (one per browser store upload).
// Uses `zip` from the host machine — every dev box that can run a browser
// extension already has it. Output: dist/securepaidvpn-<target>-<version>.zip
//
// The version suffix matches src/manifest.base.json so the artifact
// name is self-describing on the store dashboards and in our own
// uploads/ folder. Bump the version before running `npm run package`.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DIST = resolve(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox', 'edge'];

const manifestVersion = (() => {
  try {
    return JSON.parse(readFileSync(resolve(SRC, 'manifest.base.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

for (const t of TARGETS) {
  const dir = resolve(DIST, t);
  if (!existsSync(dir)) {
    console.warn(`skip ${t}: ${dir} not built — run \`npm run build\` first`);
    continue;
  }
  const out = resolve(DIST, `securepaidvpn-${t}-${manifestVersion}.zip`);
  execSync(`rm -f "${out}"`);
  // -X strips macOS extended attributes / __MACOSX folders so the
  // zip Chrome Web Store sees is clean on macOS dev boxes.
  execSync(`cd "${dir}" && zip -r -q -X "${out}" .`);
  console.log(`✓ ${out}`);
}
