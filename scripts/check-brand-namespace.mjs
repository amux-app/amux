import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OLD_NAMESPACE_TOKENS = [
  ['a', 'u', 'm', 'x'].join(''),
  ['a', 'm', 'u', 'x'].join(''),
  ['d', 'm', 'u', 'x'].join(''),
];
const HISTORICAL_PATHS = new Set(['CHANGELOG.md']);
const SCRIPT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function parseRootArgument(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1) return SCRIPT_ROOT;
  const value = argv[rootIndex + 1];
  if (!value) throw new Error('--root requires a directory');
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function listTrackedFiles(rootDir) {
  const output = execFileSync('git', ['-C', rootDir, 'ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

function containsOldNamespace(value) {
  const lowerValue = value.toLowerCase();
  return OLD_NAMESPACE_TOKENS.some((token) => lowerValue.includes(token));
}

function isReadableText(buffer) {
  return !buffer.includes(0);
}

function main() {
  const rootDir = parseRootArgument(process.argv.slice(2));
  const failures = [];
  const allowlistedMatches = [];

  for (const relativePath of listTrackedFiles(rootDir)) {
    const allowlisted = HISTORICAL_PATHS.has(relativePath);
    if (containsOldNamespace(relativePath)) {
      if (allowlisted) allowlistedMatches.push(relativePath);
      else failures.push(`${relativePath} [filename]`);
      continue;
    }

    let contents;
    try {
      contents = readFileSync(resolve(rootDir, relativePath));
    } catch {
      failures.push(`${relativePath} [unreadable]`);
      continue;
    }
    if (!isReadableText(contents)) continue;

    if (containsOldNamespace(contents.toString('utf8'))) {
      if (allowlisted) allowlistedMatches.push(relativePath);
      else failures.push(`${relativePath} [content]`);
    }
  }

  if (failures.length > 0) {
    console.log('Brand namespace guard FAILED.');
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  const suffix = allowlistedMatches.length > 0
    ? `; allowlisted historical matches: ${allowlistedMatches.length}`
    : '';
  console.log(`Brand namespace guard: clean${suffix}`);
}

try {
  main();
} catch (error) {
  console.error(`Brand namespace guard could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
