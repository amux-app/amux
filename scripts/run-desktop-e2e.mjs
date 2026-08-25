import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_AGENTS = ['claude', 'codex', 'opencode', 'pi'];
const FAKE_AGENT_SCRIPT = [
  '#!/bin/sh',
  'name="$(basename "$0")"',
  'if [ "${1:-}" = "--help" ] && [ "$name" = "pi" ]; then',
  '  printf "%s\\n" "Pi - AI coding assistant" "Usage: pi [options]" "Tools: read bash edit write"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "--version" ]; then',
  '  printf "%s\\n" "$name 2.2.0-muxbase-e2e"',
  '  exit 0',
  'fi',
  'printf "MUXBASE_FAKE_AGENT_READY %s\\n" "$name"',
  'while IFS= read -r line; do printf "MUXBASE_FAKE_AGENT_INPUT %s %s\\n" "$name" "$line"; done',
  '',
].join('\n');

const separator = process.argv.indexOf('--');
const filesFlag = process.argv.indexOf('--files');
const hasFilesMode = filesFlag >= 0 && filesFlag < separator;
const command = separator >= 0 ? process.argv[separator + 1] : undefined;
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
const files = hasFilesMode
  ? process.argv.slice(filesFlag + 1, separator)
  : [];

if (!command || (hasFilesMode && files.length === 0)) {
  console.error('Usage: node scripts/run-desktop-e2e.mjs [--files <file>...] -- <command> [args...]');
  process.exit(2);
}

let child;
let forwardedSignal;
const forwardSignal = (signal) => {
  forwardedSignal = signal;
  child?.kill(signal);
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

function configureFakeAgents(childEnv) {
  if (childEnv.MUXBASE_E2E_FAKE_AGENTS !== '1') return undefined;

  const isolatedHome = mkdtempSync(join(tmpdir(), 'muxbase-home-e2e-'));
  const fakeBin = join(isolatedHome, 'bin');
  mkdirSync(fakeBin, { recursive: true });

  for (const agent of FAKE_AGENTS) {
    const target = join(fakeBin, agent);
    writeFileSync(target, FAKE_AGENT_SCRIPT);
    chmodSync(target, 0o755);
  }

  childEnv.HOME = isolatedHome;
  childEnv.PATH = `${fakeBin}:${childEnv.PATH ?? ''}`;
  childEnv.SHELL = '/bin/sh';
  return isolatedHome;
}

async function runIsolated(runArgs) {
  const tmuxDirectory = mkdtempSync(join(tmpdir(), 'muxbase-tmux-e2e-'));
  const childEnv = { ...process.env, TMUX_TMPDIR: tmuxDirectory };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  const isolatedHome = configureFakeAgents(childEnv);

  if (childEnv.MUXBASE_E2E_RUNNER_TMPDIR_FILE) {
    writeFileSync(childEnv.MUXBASE_E2E_RUNNER_TMPDIR_FILE, tmuxDirectory);
  }

  const killPrivateTmuxServer = () => {
    spawnSync('tmux', ['-f', '/dev/null', 'kill-server'], {
      env: childEnv,
      stdio: 'ignore',
    });
  };

  spawnSync('tmux', ['-f', '/dev/null', 'start-server'], {
    env: childEnv,
    stdio: 'ignore',
  });

  try {
    return await new Promise((resolve) => {
      child = spawn(command, runArgs, { env: childEnv, stdio: 'inherit' });
      child.on('error', (error) => {
        console.error(`Failed to start desktop E2E command: ${error.message}`);
        resolve(1);
      });
      child.on('exit', (code, signal) => {
        const exitSignal = forwardedSignal || signal;
        if (exitSignal) resolve(exitSignal === 'SIGINT' ? 130 : exitSignal === 'SIGTERM' ? 143 : 1);
        else resolve(code ?? 1);
      });
    });
  } finally {
    child = undefined;
    killPrivateTmuxServer();
    rmSync(tmuxDirectory, { force: true, recursive: true });
    if (isolatedHome) rmSync(isolatedHome, { force: true, recursive: true });
  }
}

const invocations = files.length > 0
  ? files.map((file) => [...args, file])
  : [args];

for (const runArgs of invocations) {
  const exitCode = await runIsolated(runArgs);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
