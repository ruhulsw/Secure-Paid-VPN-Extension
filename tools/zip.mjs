// Packages each built target as a .zip (one per browser store upload).
// Uses `zip` from the host machine — every dev box that can run a browser
// extension already has it. Output: dist/secure-paid-vpn-<target>.zip

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox'];

for (const t of TARGETS) {
  const dir = resolve(DIST, t);
  if (!existsSync(dir)) {
    console.warn(`skip ${t}: ${dir} not built — run \`npm run build\` first`);
    continue;
  }
  const out = resolve(DIST, `secure-paid-vpn-${t}.zip`);
  execSync(`rm -f "${out}"`);
  execSync(`cd "${dir}" && zip -r -q "${out}" .`);
  console.log(`✓ ${out}`);
}
