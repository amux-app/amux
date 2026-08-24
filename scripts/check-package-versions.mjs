import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const rootPackage = readPackageJson(resolve(rootDir, 'package.json'));
const desktopPackage = readPackageJson(resolve(rootDir, 'desktop', 'package.json'));
const electronBuilderConfig = readFileSync(resolve(rootDir, 'desktop', 'electron-builder.yml'), 'utf8');

const CANONICAL_REPOSITORY = 'amux-app/amux';
const expectedMetadata = {
  bugs: `https://github.com/${CANONICAL_REPOSITORY}/issues`,
  homepage: `https://github.com/${CANONICAL_REPOSITORY}#readme`,
  repository: `git+https://github.com/${CANONICAL_REPOSITORY}.git`,
};

if (rootPackage.version !== desktopPackage.version) {
  console.error('Package version mismatch detected.');
  console.error(`root package.json: ${rootPackage.version}`);
  console.error(`desktop package.json: ${desktopPackage.version}`);
  process.exit(1);
}

const metadataErrors = [];
if (rootPackage.repository?.url !== expectedMetadata.repository) {
  metadataErrors.push(`package.json repository must be ${expectedMetadata.repository}`);
}
if (rootPackage.bugs?.url !== expectedMetadata.bugs) {
  metadataErrors.push(`package.json bugs must be ${expectedMetadata.bugs}`);
}
if (rootPackage.homepage !== expectedMetadata.homepage) {
  metadataErrors.push(`package.json homepage must be ${expectedMetadata.homepage}`);
}
if (desktopPackage.productName !== 'Amux') {
  metadataErrors.push('desktop/package.json productName must be Amux');
}
if (!/^\s*owner:\s*amux-app\s*$/m.test(electronBuilderConfig)) {
  metadataErrors.push('desktop/electron-builder.yml publish owner must be amux-app');
}
if (!/^\s*repo:\s*amux\s*$/m.test(electronBuilderConfig)) {
  metadataErrors.push('desktop/electron-builder.yml publish repo must be amux');
}

if (metadataErrors.length > 0) {
  console.error('Canonical release metadata mismatch detected:');
  for (const error of metadataErrors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Package versions aligned at ${rootPackage.version}; release metadata targets ${CANONICAL_REPOSITORY}`);
