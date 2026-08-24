#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const REQUIREMENTS_PATH = resolve(ROOT_DIR, 'config/system-requirements.json');

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const requirements = JSON.parse(await readFile(REQUIREMENTS_PATH, 'utf8'));
  const { minimum, sourceUrl, sourceSha256 } = requirements.tmux;
  if (!sourceUrl || !sourceSha256) {
    throw new Error('config/system-requirements.json is missing tmux.sourceUrl or tmux.sourceSha256');
  }

  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `tmux-floor-${minimum}`);
  const prefix = join(workDir, 'prefix');
  const archive = join(workDir, `tmux-${minimum}.tar.gz`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });

  console.log(`Downloading tmux ${minimum} from ${sourceUrl}`);
  await download(sourceUrl, archive);
  await verifyChecksum(archive, sourceSha256);

  console.log(`Extracting and building tmux ${minimum} into ${prefix}`);
  const sourceDir = await extract(archive, workDir);
  await build(sourceDir, prefix);

  const tmuxBin = join(prefix, 'bin', 'tmux');
  const version = (await execFileAsync(tmuxBin, ['-V'])).stdout.trim();
  if (version !== `tmux ${minimum}`) {
    throw new Error(`Expected exact-floor tmux ${minimum}, but the built binary reported ${version || 'no version'}`);
  }
  console.log(`Built ${version} at ${tmuxBin}`);

  await exportForGithub(tmuxBin, join(prefix, 'bin'), workDir, minimum);
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status} for ${url}`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

async function verifyChecksum(path, expected) {
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  if (hash !== expected) {
    throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${hash}`);
  }
  console.log(`Verified SHA-256 ${hash}`);
}

async function extract(archive, workDir) {
  await execFileAsync('tar', ['-xzf', archive, '-C', workDir]);
  const listing = (await execFileAsync('tar', ['-tzf', archive])).stdout.split('\n');
  const topDir = listing[0]?.split('/')[0];
  if (!topDir) throw new Error(`Could not determine extracted directory for ${archive}`);
  return join(workDir, topDir);
}

async function build(sourceDir, prefix) {
  const options = { cwd: sourceDir, timeout: 900_000 };
  await execFileAsync('./configure', [`--prefix=${prefix}`, '--disable-utf8proc'], options);
  await execFileAsync('make', ['-j', String(cpuCount())], options);
  await execFileAsync('make', ['install'], options);
}

function cpuCount() {
  const parsed = Number(process.env.NUMBER_OF_PROCESSORS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

async function exportForGithub(tmuxBin, binDir, workDir, version) {
  const socketDir = join(workDir, 'socket');
  await mkdir(socketDir, { recursive: true });
  const outputPath = process.env.GITHUB_OUTPUT;
  const envPath = process.env.GITHUB_ENV;
  if (outputPath) {
    await appendLines(outputPath, [
      `tmux-bin=${tmuxBin}`,
      `bin-dir=${binDir}`,
      `tmux-version=${version}`,
    ]);
  }
  if (envPath) {
    await appendLines(envPath, [`TMUX_TMPDIR=${socketDir}`]);
  }
}

async function appendLines(path, lines) {
  const existing = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${existing}${lines.join('\n')}\n`);
}
