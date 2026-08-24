#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHITECTURES = new Set(['arm64', 'x64']);
const CHANNELS = new Set(['beta', 'stable']);
const SCREENSHOT_KINDS = new Set(['wrong-location', 'ready', 'after-restart']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const REQUIRED_PROOFS = [
  'afterRestartVersionMatches',
  'applicationsGateCleared',
  'backgroundDownloadVisible',
  'dirtyRestartGuardPassed',
  'laterKeptUpdateReady',
  'noCheckOutsideApplications',
  'normalRelaunchPassed',
  'signaturePassed',
  'staplingPassed',
  'wrongLocationNoticeVisible',
];

export function validateUpdateRehearsalRecord(record, options = {}) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['Evidence must be a JSON object.'];
  }
  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (!ARCHITECTURES.has(record.architecture)) errors.push('architecture must be arm64 or x64.');
  if (!CHANNELS.has(record.channel)) errors.push('channel must be beta or stable.');
  if (record.repository !== 'amux-app/amux') errors.push('repository must be amux-app/amux.');

  const from = parseVersion(record.fromVersion);
  const to = parseVersion(record.toVersion);
  if (!from) errors.push('fromVersion must be semantic version N.');
  if (!to) errors.push('toVersion must be semantic version N+1.');
  if (from && to && compareVersions(from, to) >= 0) errors.push('toVersion must be newer than fromVersion.');
  if (record.channel === 'stable' && (from?.prerelease || to?.prerelease)) {
    errors.push('stable evidence cannot use prerelease versions.');
  }
  if (record.channel === 'beta' && (!from?.prerelease || !to?.prerelease)) {
    errors.push('beta evidence must use explicit prerelease versions.');
  }

  if (typeof record.appPath !== 'string' || !isApplicationsPath(record.appPath)) {
    errors.push('appPath must point to an app inside /Applications or ~/Applications.');
  }
  if (!SHA256_PATTERN.test(record.metadataSha256 ?? '')) {
    errors.push('metadataSha256 must be a lowercase SHA-256 digest.');
  }

  for (const proof of REQUIRED_PROOFS) {
    if (record.proofs?.[proof] !== true) errors.push(`proofs.${proof} must be true.`);
  }

  const screenshots = Array.isArray(record.screenshots) ? record.screenshots : [];
  for (const kind of SCREENSHOT_KINDS) {
    const matches = screenshots.filter((screenshot) => screenshot?.kind === kind);
    if (matches.length !== 1) {
      errors.push(`screenshots must contain exactly one ${kind} entry.`);
      continue;
    }
    const [screenshot] = matches;
    if (typeof screenshot.path !== 'string' || !SHA256_PATTERN.test(screenshot.sha256 ?? '')) {
      errors.push(`screenshots.${kind} must contain path and lowercase SHA-256.`);
      continue;
    }
    if (options.verifyFiles) verifyEvidenceFile(screenshot, kind, errors);
  }

  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt <= startedAt) {
    errors.push('startedAt and completedAt must describe a positive UTC rehearsal interval.');
  }

  return errors;
}

export function validateArchitecturePair(records, options = {}) {
  const errors = records.flatMap((record, index) => (
    validateUpdateRehearsalRecord(record, options).map((error) => `record[${index}]: ${error}`)
  ));
  if (records.length !== 2) return [...errors, 'Exactly two rehearsal records are required.'];

  const architectures = new Set(records.map((record) => record.architecture));
  if (architectures.size !== 2 || !architectures.has('arm64') || !architectures.has('x64')) {
    errors.push('Records must cover exactly one arm64 and one x64 machine.');
  }
  for (const field of ['channel', 'fromVersion', 'repository', 'toVersion']) {
    if (records[0]?.[field] !== records[1]?.[field]) {
      errors.push(`Both records must use the same ${field}.`);
    }
  }

  if (options.requireSoak) {
    for (const [index, record] of records.entries()) {
      const soakStartedAt = Date.parse(record.soak?.startedAt);
      const soakCompletedAt = Date.parse(record.soak?.completedAt);
      const duration = soakCompletedAt - soakStartedAt;
      if (!Number.isFinite(duration) || duration < 3 * 24 * 60 * 60 * 1_000) {
        errors.push(`record[${index}]: beta soak must be at least 3 days.`);
      }
      if (record.soak?.releaseBlockingDefects !== 0) {
        errors.push(`record[${index}]: beta soak must have zero release-blocking defects.`);
      }
    }
  }
  return errors;
}

function verifyEvidenceFile(screenshot, kind, errors) {
  const path = resolve(screenshot.path);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    errors.push(`Screenshot ${kind} does not exist or is empty: ${path}`);
    return;
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== screenshot.sha256) errors.push(`Screenshot ${kind} SHA-256 does not match.`);
}

function isApplicationsPath(path) {
  return /^\/Applications\/[^/]+\.app$/.test(path)
    || /^\/Users\/[^/]+\/Applications\/[^/]+\.app$/.test(path);
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true });
}

function runCli() {
  const args = process.argv.slice(2);
  const requireSoak = args.includes('--require-soak');
  const paths = args.filter((argument) => argument !== '--require-soak');
  if (paths.length !== 2) {
    console.error('Usage: node scripts/rehearse-macos-update.mjs <arm64.json> <x64.json> [--require-soak]');
    process.exitCode = 2;
    return;
  }
  const records = paths.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
  const errors = validateArchitecturePair(records, { requireSoak, verifyFiles: true });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${records[0].channel} ${records[0].fromVersion} → ${records[0].toVersion} on arm64 and x64.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
