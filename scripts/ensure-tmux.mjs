#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REQUIREMENTS_PATH = resolve(ROOT_DIR, 'config/system-requirements.json');
const VERSION_PATTERN = /^(?:tmux\s+)?(\d+)\.(\d+)([a-z])?$/;

const requirements = JSON.parse(readFileSync(REQUIREMENTS_PATH, 'utf8'));
const MINIMUM = requirements.tmux.minimum;
const FORMULA = requirements.tmux.homebrewFormula;

const mode = process.argv.includes('--provision') ? 'provision' : 'check';

main(mode).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(runMode) {
  const detected = await detectTmux();
  const current = detected.status === 'ok' ? detected.version : null;

  if (current && isSupported(current)) {
    console.log(`ok tmux ${current} (>= ${MINIMUM})`);
    await checkRunningServer();
    return;
  }

  if (detected.status === 'unparseable') {
    fail(`Amux could not verify tmux version ${detected.raw || 'empty output'}. Install stable tmux >= ${MINIMUM} manually.`);
    return;
  }

  if (detected.status === 'unverifiable') {
    fail(`Amux could not execute the selected tmux binary. Install stable tmux >= ${MINIMUM} manually.`);
    return;
  }

  if (runMode === 'check') {
    if (!current) fail(`tmux is required. Install it with: brew install ${FORMULA}`);
    else fail(`tmux ${current} is below Amux's minimum ${MINIMUM}. Run: brew upgrade ${FORMULA}`);
    return;
  }

  await provision(current);
}

async function provision(current) {
  const brew = await hasBrew();
  if (!brew) {
    fail(current
      ? `tmux ${current} is below ${MINIMUM} and Homebrew is not available. Upgrade tmux to >= ${MINIMUM} manually.`
      : `tmux is missing and Homebrew is not available. Install tmux >= ${MINIMUM} manually.`);
    return;
  }

  if (current && !(await isHomebrewOwnedTmux())) {
    fail(`tmux ${current} is below ${MINIMUM}, but the selected tmux is not managed by Homebrew. Upgrade it to >= ${MINIMUM} manually.`);
    return;
  }

  const action = current ? 'upgrade' : 'install';
  console.log(`Running: brew ${action} ${FORMULA}`);
  await execFileAsync('brew', [action, FORMULA], { timeout: 300_000 });

  const provisioned = await detectTmux();
  if (provisioned.status !== 'ok' || !isSupported(provisioned.version)) {
    const value = provisioned.status === 'ok'
      ? provisioned.version
      : provisioned.status === 'unparseable'
        ? provisioned.raw || 'unparseable'
        : provisioned.status;
    fail(`tmux is still ${value} after brew ${action}; expected >= ${MINIMUM}.`);
    return;
  }
  console.log(`ok tmux ${provisioned.version} (>= ${MINIMUM})`);
  await checkRunningServer();
}

async function isHomebrewOwnedTmux() {
  const selected = findExecutableOnPath('tmux');
  if (!selected) return false;

  try {
    const { stdout } = await execFileAsync('brew', ['--prefix', FORMULA], { timeout: 5_000 });
    const formulaTmux = join(stdout.trim(), 'bin', 'tmux');
    return realpathSync(selected) === realpathSync(formulaTmux);
  } catch {
    return false;
  }
}

function findExecutableOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the effective PATH.
    }
  }
  return null;
}

async function detectTmux() {
  const selected = findExecutableOnPath('tmux');
  if (!selected) return { status: 'missing' };

  try {
    const { stdout } = await execFileAsync(selected, ['-V'], { timeout: 5_000 });
    const raw = stdout.trim();
    const parsed = parse(raw);
    return parsed
      ? { status: 'ok', version: formatVersion(parsed) }
      : { status: 'unparseable', raw };
  } catch {
    return { status: 'unverifiable' };
  }
}

async function checkRunningServer() {
  try {
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '#{version}'], { timeout: 5_000 });
    const server = stdout.trim();
    if (!parse(server)) {
      fail(`Amux could not verify the running tmux server version ${server || 'empty output'}; restart tmux completely before starting Amux.`);
    } else if (!isSupported(server)) {
      fail(`tmux server ${server} is still running below ${MINIMUM}. Save and close active tmux sessions, then restart tmux completely before starting Amux.`);
    } else {
      console.log(`ok tmux server ${server} (>= ${MINIMUM})`);
    }
  } catch (error) {
    const detail = error && typeof error === 'object'
      ? `${'stderr' in error ? String(error.stderr ?? '') : ''} ${'message' in error ? String(error.message ?? '') : ''}`.toLowerCase()
      : String(error).toLowerCase();
    if (detail.includes('no server running') || detail.includes('no such file or directory')) return;
    fail('Amux could not verify the running tmux server. Restart tmux completely before starting Amux.');
  }
}

async function hasBrew() {
  try {
    await execFileAsync('brew', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function parse(raw) {
  const match = raw.match(VERSION_PATTERN);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), suffix: match[3] ?? '' };
}

function formatVersion(v) {
  return `${v.major}.${v.minor}${v.suffix}`;
}

function suffixRank(suffix) {
  return suffix === '' ? 0 : suffix.charCodeAt(0) - 96;
}

function isSupported(raw) {
  const parsed = parse(raw);
  const required = parse(MINIMUM);
  if (!parsed || !required) return false;
  if (parsed.major !== required.major) return parsed.major > required.major;
  if (parsed.minor !== required.minor) return parsed.minor > required.minor;
  return suffixRank(parsed.suffix) >= suffixRank(required.suffix);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}
