#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmuxBin = getFlagValue('--tmux-bin') ?? 'tmux';
const expectedVersion = getFlagValue('--expected-version');
const socketPath = `/tmp/aumx-tmux-smoke-${process.pid}-${randomUUID().slice(0, 8)}.sock`;
const target = 'aumx-compat:0.0';

try {
  const version = await run(['-V']);
  if (expectedVersion && version !== `tmux ${expectedVersion}`) {
    throw new Error(`Expected tmux ${expectedVersion}, got ${version || 'no version output'}`);
  }

  await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'aumx-compat', '-x', '80', '-y', '24']);
  expectEqual(await run(['display-message', '-p', '-t', target, '#{alternate_on}']), '0', 'alternate-screen probe');
  expectEqual(
    await run([
      'if-shell', '-F', '-t', target, '#{alternate_on}',
      'display-message -p ALT',
      'display-message -p NORMAL',
    ]),
    'NORMAL',
    'scroll ownership marker',
  );
  await run(['capture-pane', '-p', '-t', target, '-S', '-']);
  await run(['copy-mode', '-t', target]);
  await run(['send-keys', '-X', '-t', target, '-N', '1', 'scroll-up']);
  await run(['copy-mode', '-q', '-t', target]);
  await run(['resize-window', '-t', target, '-x', '100', '-y', '30']);
  expectEqual(
    await run(['display-message', '-p', '-t', target, '#{window_width}x#{window_height}']),
    '100x30',
    'window resize',
  );

  console.log(`ok ${version}: live command contract passed`);
} finally {
  await run(['kill-server']).catch(() => undefined);
  await rm(socketPath, { force: true });
}

function run(args) {
  return execFileAsync(tmuxBin, ['-S', socketPath, ...args], {
    timeout: 10_000,
  }).then(({ stdout }) => stdout.trim());
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} returned ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
  }
}

function getFlagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
