// Produces a source-only zip for AMO (addons.mozilla.org) submission.
// Mozilla's reviewer policy requires source for any MV3 extension that
// goes through a build step — reviewers must be able to reproduce the
// uploaded dist/firefox/ from the source tree.
//
// Output: dist/securepaidvpn-firefox-<version>-source.zip
//
// Includes:  src/  tools/  package.json  package-lock.json  README.md  LICENSE  .gitignore
// Excludes:  node_modules/  dist/  .git/  *.DS_Store  STORE-IDS.txt
//            secrets (*.pem, .env*)  build artifacts (*.zip, *.crx, *.xpi)
//
// The reviewer reproduces the build with:
//   unzip securepaidvpn-firefox-<version>-source.zip
//   cd <unpacked>
//   npm install
//   node tools/build.mjs firefox
// → dist/firefox/ should byte-match the addon zip's contents.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

mkdirSync(DIST, { recursive: true });

const version = JSON.parse(
  readFileSync(resolve(ROOT, 'src/manifest.base.json'), 'utf8')
).version;

const out = resolve(DIST, `securepaidvpn-firefox-${version}-source.zip`);
execSync(`rm -f "${out}"`);

// Allowlist — anything not in this list doesn't get zipped, regardless
// of what's in the working tree.
const include = ['src', 'tools', 'package.json', 'README.md', 'LICENSE', '.gitignore'];
if (existsSync(resolve(ROOT, 'package-lock.json'))) include.push('package-lock.json');

// Pattern excludes — applied as `zip -x` so they catch anything that
// sneaks into the include paths (e.g., a stray .DS_Store inside src/).
const exclude = [
  '*.DS_Store',
  '*/.DS_Store',
  'STORE-IDS.txt',
  '*/STORE-IDS.txt',
  '*.pem',
  '*.crx',
  '*.xpi',
  '*.zip',
  '.env',
  '.env.*',
  'node_modules/*',
  'dist/*',
  '.git/*',
  'src/icons/source-logo.png',
];

const includeArg = include.map((p) => `"${p}"`).join(' ');
const excludeArg = exclude.map((p) => `'${p}'`).join(' ');

execSync(
  `cd "${ROOT}" && zip -r -q -X "${out}" ${includeArg} -x ${excludeArg}`,
  { stdio: 'inherit' }
);

console.log(`✓ ${out}`);
