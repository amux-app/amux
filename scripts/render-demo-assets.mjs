#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEMO_DIR = resolve(ROOT_DIR, '.tmp/demo');
const HERO_INPUT = join(DEMO_DIR, 'hero.webm');
const HERO_OUTPUT = resolve(ROOT_DIR, 'docs/assets/amux-demo.webp');
const HERO_MP4_OUTPUT = resolve(ROOT_DIR, 'docs/public/amux-demo-hero.mp4');
const FULL_INPUT = join(DEMO_DIR, 'full.webm');
const FULL_OUTPUT = join(DEMO_DIR, 'amux-demo-full.mp4');

const TARGET_WIDTH = 1600;
const TARGET_HEIGHT = 900;
const OUTPUT_FPS = 25;
const HERO_FRAME_FPS = 12.5;
const HERO_DENOISE_FILTER = 'hqdn3d=1.5:1.5:4:4';
const HERO_QUALITY_STEPS = [72, 68, 64];
const HERO_MAX_BYTES = 9 * 1024 * 1024;
const TRIM_PAD_SEC = 0.15;

function assertInputExists(path, label) {
  if (existsSync(path)) return;
  throw new Error(`Missing ${label}: ${path}. Run 'make demo-record' first.`);
}

function tempPathFor(outputPath) {
  const ext = extname(outputPath);
  return `${outputPath.slice(0, outputPath.length - ext.length)}.tmp${ext}`;
}

function buildScaleFilter(width, height) {
  if (width === TARGET_WIDTH && height === TARGET_HEIGHT) return null;
  return `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:flags=lanczos`;
}

function resolveTrim(inputPath, cutLabel) {
  const sidecarPath = inputPath.replace(/\.webm$/, '.meta.json');
  if (!existsSync(sidecarPath)) {
    console.warn(`Warning: no trim sidecar for ${cutLabel} cut (${sidecarPath}); encoding untrimmed`);
    return 0;
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Corrupt trim sidecar for ${cutLabel} cut (${sidecarPath}): ${reason}. Run 'make demo-record' to regenerate it.`);
  }
  if (!Number.isFinite(meta.revealEpochMs) || !Number.isFinite(meta.videoStartEpochMs)) {
    throw new Error(
      `Trim sidecar for ${cutLabel} cut (${sidecarPath}) is missing or has non-numeric `
      + `revealEpochMs/videoStartEpochMs. Run 'make demo-record' to regenerate it.`,
    );
  }
  return Math.max(0, (meta.revealEpochMs - meta.videoStartEpochMs) / 1000 + TRIM_PAD_SEC);
}

function encodeFull(inputPath, outputPath, trimStartSec = 0) {
  assertInputExists(inputPath, 'recording');
  const probe = probeVideo(inputPath);
  const scaleFilter = buildScaleFilter(probe.width, probe.height);
  const tempOutput = tempPathFor(outputPath);
  try {
    const args = ['-y'];
    if (trimStartSec > 0) args.push('-ss', String(trimStartSec));
    args.push('-i', inputPath);
    if (scaleFilter) args.push('-vf', scaleFilter);
    args.push(
      '-r', String(OUTPUT_FPS),
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tempOutput,
    );
    runFfmpeg(args);
    const size = statSync(tempOutput).size;
    renameSync(tempOutput, outputPath);
    return { path: outputPath, probe, size, trimStartSec };
  } finally {
    rmSync(tempOutput, { force: true });
  }
}

function encodeHero(inputPath, outputPath, trimStartSec = 0, maxBytes = HERO_MAX_BYTES) {
  assertInputExists(inputPath, 'recording');
  assertImg2webpAvailable();
  const probe = probeVideo(inputPath);
  const scaleFilter = buildScaleFilter(probe.width, probe.height);
  const tempOutput = tempPathFor(outputPath);

  const framesDir = mkdtempSync(join(tmpdir(), 'amux-demo-frames-'));
  try {
    const frames = extractFrames(inputPath, framesDir, scaleFilter, trimStartSec);

    let size = 0;
    let usedQuality = HERO_QUALITY_STEPS[0];
    for (const quality of HERO_QUALITY_STEPS) {
      assembleWebp(frames, tempOutput, quality);
      size = statSync(tempOutput).size;
      usedQuality = quality;
      console.log(`  hero encode @ q${quality}: ${formatBytes(size)}`);
      if (size < maxBytes) break;
    }
    if (size >= maxBytes) {
      throw new Error(
        `Hero WebP is still ${formatBytes(size)} after stepping quality down to `
        + `${HERO_QUALITY_STEPS.at(-1)}; exceeds the ${formatBytes(maxBytes)} budget`,
      );
    }
    renameSync(tempOutput, outputPath);
    return {
      path: outputPath, probe, quality: usedQuality, size, trimStartSec, frameCount: frames.length,
    };
  } finally {
    rmSync(tempOutput, { force: true });
    rmSync(framesDir, { force: true, recursive: true });
  }
}

function assertImg2webpAvailable() {
  try {
    execFileSync('img2webp', ['-version'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('img2webp not found on PATH. Install it via: brew install webp');
    }
    throw error;
  }
}

function extractFrames(inputPath, framesDir, scaleFilter, trimStartSec = 0) {
  const filters = [`fps=${HERO_FRAME_FPS}`, HERO_DENOISE_FILTER];
  if (scaleFilter) filters.push(scaleFilter);
  const args = ['-y'];
  if (trimStartSec > 0) args.push('-ss', String(trimStartSec));
  args.push('-i', inputPath, '-vf', filters.join(','), join(framesDir, 'frame-%05d.png'));
  runFfmpeg(args);

  const frames = readdirSync(framesDir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => join(framesDir, name));
  if (frames.length === 0) throw new Error(`ffmpeg extracted no frames from ${inputPath}`);
  return frames;
}

function assembleWebp(frames, outputPath, quality) {
  const frameDurationMs = Math.round(1000 / HERO_FRAME_FPS);
  execFileSync('img2webp', [
    '-loop', '0',
    '-lossy',
    '-q', String(quality),
    '-m', '6',
    '-d', String(frameDurationMs),
    ...frames,
    '-o', outputPath,
  ], { stdio: 'inherit' });
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function probeVideo(path) {
  const output = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    path,
  ], { encoding: 'utf8' });
  const data = JSON.parse(output);
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${path}`);
  return {
    duration: Number(data.format?.duration ?? 0),
    height: stream.height,
    width: stream.width,
  };
}

function printResult(label, result) {
  console.log(label);
  console.log(`  path:     ${result.path}`);
  console.log(`  input:    ${result.probe.width}x${result.probe.height}, ${result.probe.duration.toFixed(1)}s`);
  console.log(`  trim:     ${result.trimStartSec.toFixed(2)}s`);
  console.log(`  output:   ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
  console.log(`  size:     ${formatBytes(result.size)}`);
  if (result.quality !== undefined) console.log(`  quality:  ${result.quality}`);
}

function runFfmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', ...args], { stdio: 'inherit' });
}

async function selfTest() {
  const tempDir = mkdtempSync(join(tmpdir(), 'amux-demo-selftest-'));
  try {
    for (const [width, height] of [[TARGET_WIDTH, TARGET_HEIGHT], [3200, 1800]]) {
      console.log(`\nSelf-test: ${width}x${height} synthetic source`);
      const sample = join(tempDir, `sample-${width}x${height}.webm`);
      runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `testsrc=size=${width}x${height}:rate=${OUTPUT_FPS}:duration=2`,
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuv420p',
        sample,
      ]);

      console.log('  -- meta-missing path --');
      const noMetaTrim = resolveTrim(sample, 'test');
      if (noMetaTrim !== 0) throw new Error(`Expected 0 trim when sidecar is missing, got ${noMetaTrim}`);

      const heroOut = join(tempDir, `hero-${width}x${height}.webp`);
      const heroResult = encodeHero(sample, heroOut, noMetaTrim);
      printResult('self-test hero (untrimmed)', heroResult);
      if (!existsSync(heroOut) || heroResult.size === 0) {
        throw new Error(`Self-test hero output was not written: ${heroOut}`);
      }

      const fullOut = join(tempDir, `full-${width}x${height}.mp4`);
      const fullResult = encodeFull(sample, fullOut, noMetaTrim);
      printResult('self-test full (untrimmed)', fullResult);
      const fullProbe = probeVideo(fullOut);
      if (fullProbe.width !== TARGET_WIDTH || fullProbe.height !== TARGET_HEIGHT) {
        throw new Error(`Self-test full output is ${fullProbe.width}x${fullProbe.height}, expected ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
      }

      console.log('  -- meta-present path --');
      const sidecarPath = sample.replace(/\.webm$/, '.meta.json');
      const revealOffsetMs = 500;
      writeFileSync(sidecarPath, JSON.stringify({ revealEpochMs: revealOffsetMs, videoStartEpochMs: 0 }));
      const expectedTrim = revealOffsetMs / 1000 + TRIM_PAD_SEC;
      const trim = resolveTrim(sample, 'test');
      if (Math.abs(trim - expectedTrim) > 0.001) {
        throw new Error(`Expected trim ${expectedTrim}s from sidecar, got ${trim}s`);
      }

      const trimmedHeroOut = join(tempDir, `hero-trimmed-${width}x${height}.webp`);
      const trimmedHeroResult = encodeHero(sample, trimmedHeroOut, trim);
      printResult('self-test hero (trimmed)', trimmedHeroResult);
      if (trimmedHeroResult.frameCount >= heroResult.frameCount) {
        throw new Error(
          `Trimmed hero frame count (${trimmedHeroResult.frameCount}) did not shrink below `
          + `untrimmed (${heroResult.frameCount})`,
        );
      }

      const trimmedFullOut = join(tempDir, `full-trimmed-${width}x${height}.mp4`);
      const trimmedFullResult = encodeFull(sample, trimmedFullOut, trim);
      printResult('self-test full (trimmed)', trimmedFullResult);
      const trimmedProbe = probeVideo(trimmedFullOut);
      if (trimmedProbe.duration >= fullProbe.duration - 0.1) {
        throw new Error(
          `Trimmed full duration (${trimmedProbe.duration.toFixed(2)}s) did not shrink from `
          + `untrimmed (${fullProbe.duration.toFixed(2)}s)`,
        );
      }

      console.log('  -- atomic-failure path --');
      const committedPath = join(tempDir, `committed-${width}x${height}.webp`);
      const sentinel = 'sentinel-untouched';
      writeFileSync(committedPath, sentinel);
      let budgetFailed = false;
      try {
        encodeHero(sample, committedPath, noMetaTrim, 1);
      } catch {
        budgetFailed = true;
      }
      if (!budgetFailed) throw new Error('Expected a forced budget failure to throw');
      if (readFileSync(committedPath, 'utf8') !== sentinel) {
        throw new Error(`Committed path was modified despite a budget failure: ${committedPath}`);
      }
      const leftoverTemp = tempPathFor(committedPath);
      if (existsSync(leftoverTemp)) {
        throw new Error(`Leftover temp file was not cleaned up: ${leftoverTemp}`);
      }
    }
    console.log('\nSelf-test passed');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await selfTest();
    return;
  }

  const wantHero = args.includes('--hero');
  const wantFull = args.includes('--full');
  const runHero = wantHero || !wantFull;
  const runFull = wantFull || !wantHero;

  const tasks = [];
  if (runHero) {
    const heroTrim = resolveTrim(HERO_INPUT, 'hero');
    tasks.push(['hero webp', () => encodeHero(HERO_INPUT, HERO_OUTPUT, heroTrim)]);
    tasks.push(['hero mp4', () => encodeFull(HERO_INPUT, HERO_MP4_OUTPUT, heroTrim)]);
  }
  if (runFull) {
    const fullTrim = resolveTrim(FULL_INPUT, 'full');
    tasks.push(['full', () => encodeFull(FULL_INPUT, FULL_OUTPUT, fullTrim)]);
  }

  const failures = [];
  for (const [label, task] of tasks) {
    try {
      printResult(label, task());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FAILED ${label}: ${message}`);
      failures.push(label);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${tasks.length} outputs failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
