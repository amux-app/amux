import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * node-pty 1.1.0's macOS npm prebuilds omit the executable bit from
 * spawn-helper. Keep development and E2E PTYs on the native path until the
 * upstream fix is available in a stable release.
 */
export function ensureNodePtyHelpersExecutable(
  packageRoot,
  { platform = process.platform } = {},
) {
  if (platform !== 'darwin') return [];

  const helperPaths = [
    join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(packageRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ];
  const repaired = [];

  for (const helperPath of helperPaths) {
    if (!existsSync(helperPath)) continue;
    const mode = statSync(helperPath).mode & 0o777;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helperPath, mode | 0o111);
    repaired.push(helperPath);
  }

  return repaired;
}

function resolveNodePtyPackageRoot() {
  const requireFromDesktop = createRequire(new URL('../desktop/package.json', import.meta.url));
  return dirname(requireFromDesktop.resolve('node-pty/package.json'));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repaired = ensureNodePtyHelpersExecutable(resolveNodePtyPackageRoot());
  if (repaired.length > 0) {
    console.log(`Repaired node-pty spawn-helper permissions: ${repaired.join(', ')}`);
  }
}
