import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const desktopDir = resolve(rootDir, 'desktop');
const vitestArgs = [
  '--dir',
  desktopDir,
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.config.ts',
  '--no-file-parallelism',
  '__tests__/e2e/app.e2e.test.ts',
];

const env = {
  ...process.env,
  AUMX_E2E: '1',
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

if (process.platform === 'linux' && !process.env.DISPLAY) {
  const xvfbCheck = spawnSync('which', ['xvfb-run'], { stdio: 'ignore' });
  if (xvfbCheck.status !== 0) {
    console.error('xvfb-run is required to execute the desktop smoke test on Linux without DISPLAY.');
    process.exit(1);
  }

  run('xvfb-run', ['-a', 'pnpm', ...vitestArgs]);
}

run('pnpm', vitestArgs);