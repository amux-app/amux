import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tagName = process.argv[2]?.trim();
if (!tagName) {
  console.error('Usage: node scripts/check-release-tag.mjs <tag>');
  process.exit(1);
}

const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const PACKAGES = [
  { label: 'root',    path: resolve(ROOT_DIR, 'package.json') },
  { label: 'desktop', path: resolve(ROOT_DIR, 'desktop/package.json') },
];
const MANIFEST_PATH = resolve(ROOT_DIR, '.release-please-manifest.json');

const expectedVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;
const expectedTag = `v${expectedVersion}`;

const mismatches = [];
const seen = [];

for (const pkg of PACKAGES) {
  const { version } = JSON.parse(readFileSync(pkg.path, 'utf8'));
  seen.push({ ...pkg, version });
  if (version !== expectedVersion) {
    mismatches.push({ ...pkg, version });
  }
}

const manifestVersion = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))['.'];
seen.push({ label: 'release manifest', path: MANIFEST_PATH, version: manifestVersion });
if (manifestVersion !== expectedVersion) {
  mismatches.push({ label: 'release manifest', path: MANIFEST_PATH, version: manifestVersion });
}

if (tagName !== expectedTag) {
  console.error(`Release tag format invalid. Expected vX.Y.Z, received ${tagName}.`);
  process.exit(1);
}

if (mismatches.length > 0) {
  console.error(`Release tag ${tagName} does not match release version sources:`);
  for (const m of mismatches) {
    console.error(`  - ${m.label} (${m.path}): ${m.version}`);
  }
  console.error(`Expected every release version source to be at ${expectedVersion}.`);
  process.exit(1);
}

console.log(`Release tag ${tagName} matches all release version sources:`);
for (const s of seen) console.log(`  - ${s.label}: ${s.version}`);
