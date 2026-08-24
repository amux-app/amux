import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export function readManagedToolchainRequirements(rootDir = ROOT_DIR) {
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const runtime = packageJson.devEngines?.runtime;
  const packageManagerMatch = /^pnpm@(.+)$/.exec(packageJson.packageManager ?? '');

  if (runtime?.name !== 'node' || typeof runtime.version !== 'string') {
    throw new Error('package.json must declare an exact devEngines.runtime Node.js version.');
  }
  if (!packageManagerMatch) {
    throw new Error('package.json must pin pnpm through the packageManager field.');
  }

  const requirements = {
    nodeVersion: runtime.version,
    pnpmVersion: packageManagerMatch[1],
  };

  if (packageJson.engines?.node !== `>=${requirements.nodeVersion}`) {
    throw new Error('engines.node must match the managed Node.js runtime floor.');
  }
  if (packageJson.engines?.pnpm !== requirements.pnpmVersion) {
    throw new Error('engines.pnpm must match the pinned pnpm version.');
  }

  return requirements;
}

export function validateManagedToolchain(actual, expected) {
  if (actual.nodeVersion !== expected.nodeVersion) {
    throw new Error(
      `Managed Node.js mismatch: running ${actual.nodeVersion}, expected ${expected.nodeVersion}. ` +
      'Run "pnpm install" and execute project commands through pnpm.',
    );
  }

  if (actual.pnpmVersion !== expected.pnpmVersion) {
    throw new Error(
      `Managed pnpm mismatch: running ${actual.pnpmVersion}, expected ${expected.pnpmVersion}. ` +
      'Run "corepack enable" and retry.',
    );
  }
}

function main() {
  const expected = readManagedToolchainRequirements();
  const actual = {
    nodeVersion: process.versions.node,
    pnpmVersion: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
  };

  validateManagedToolchain(actual, expected);
  console.log(`ok managed node ${actual.nodeVersion}`);
  console.log(`ok managed pnpm ${actual.pnpmVersion}`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
