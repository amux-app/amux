import { getRawHeader } from '@electron/asar';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const LOCAL_MAC_SIGN_IDENTITY = '-';
export const SYSTEM_APPLICATIONS_DIR = '/Applications';
const ASAR_HEADER_PREFIX_BYTES = 8;
const REQUIRED_APP_FILES = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
];
const SHA256 = 'SHA256';

export function buildPackageArgs(buildNumber, buildVersion) {
  return [
    'exec',
    'electron-builder',
    '--dir',
    '--publish',
    'never',
    `-c.mac.identity=${LOCAL_MAC_SIGN_IDENTITY}`,
    `-c.buildNumber=${buildNumber}`,
    `-c.extraMetadata.aumxBuild.number=${buildNumber}`,
    `-c.extraMetadata.aumxBuild.version=${buildVersion}`,
  ];
}

export function resolveInstallDir({ canWriteSystemApplications, envInstallDir, homeDir }) {
  const configuredInstallDir = envInstallDir?.trim();

  if (configuredInstallDir) {
    return {
      installDir: configuredInstallDir,
      source: 'environment',
    };
  }

  if (canWriteSystemApplications) {
    return {
      installDir: SYSTEM_APPLICATIONS_DIR,
      source: 'system',
    };
  }

  return {
    installDir: join(homeDir, 'Applications'),
    source: 'user',
  };
}

/**
 * Verifies the bytes electron-builder wrote against the per-file hashes in the
 * ASAR header. The header is created before payload streaming, so this detects a
 * concurrent build changing `out/` while packaging is in progress.
 */
export async function validatePackagedArchive(archivePath) {
  const { header, headerSize } = getRawHeader(archivePath);
  const records = collectFileRecords(header);
  const recordPaths = new Set(records.map(({ path }) => path));
  for (const requiredPath of REQUIRED_APP_FILES) {
    if (!recordPaths.has(requiredPath)) {
      throw new Error(`Packaged app is missing required file: ${requiredPath}`);
    }
  }

  const archiveSize = statSync(archivePath).size;
  const payloadStart = ASAR_HEADER_PREFIX_BYTES + headerSize;
  for (const { path, record } of records) {
    const source = resolveRecordSource(archivePath, payloadStart, archiveSize, path, record);
    // electron-builder signs unpacked native executables after writing the ASAR
    // header, so their pre-signing hashes and sizes are intentionally stale.
    // codesign verifies those bundle resources; here we verify every packed byte.
    if (!source) continue;

    const actualHash = await sha256(source.path, source.start, source.size);
    if (record.integrity?.algorithm !== SHA256 || actualHash !== record.integrity.hash) {
      throw new Error(
        `Archive integrity check failed for ${path}. ` +
        'Build inputs changed during packaging; wait for other builds to finish and retry.',
      );
    }
  }
}

/**
 * Requires several consecutive running observations so a process that starts
 * and immediately exits is not reported as a successful launch.
 */
export async function waitForAppLaunch(
  isRunning,
  wait,
  attempts = 20,
  requiredConsecutiveObservations = 4,
) {
  let consecutiveObservations = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isRunning()) {
      consecutiveObservations += 1;
      if (consecutiveObservations >= requiredConsecutiveObservations) return;
    } else {
      consecutiveObservations = 0;
    }

    if (attempt + 1 < attempts) await wait();
  }

  throw new Error('Amux exited during startup. The installed app was not left running.');
}

function collectFileRecords(directory, prefix = '') {
  const records = [];
  for (const [name, record] of Object.entries(directory.files)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if ('files' in record) {
      records.push(...collectFileRecords(record, path));
    } else if (!('link' in record)) {
      records.push({ path, record });
    }
  }
  return records;
}

function resolveRecordSource(archivePath, payloadStart, archiveSize, relativePath, record) {
  if (record.unpacked) {
    const unpackedRoot = resolve(`${archivePath}.unpacked`);
    const path = resolve(unpackedRoot, relativePath);
    if (path !== unpackedRoot && !path.startsWith(`${unpackedRoot}${sep}`)) {
      throw new Error(`Unsafe unpacked ASAR path: ${relativePath}`);
    }
    if (!existsSync(path)) throw new Error(`Packaged app is missing unpacked file: ${relativePath}`);
    return null;
  }

  const offset = Number(record.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(record.size) || record.size < 0) {
    throw new Error(`Invalid ASAR file bounds for ${relativePath}`);
  }

  const start = payloadStart + offset;
  if (start + record.size > archiveSize) {
    throw new Error(`Archive integrity check failed for ${relativePath}: payload exceeds archive`);
  }
  return { path: archivePath, start, size: record.size };
}

async function sha256(path, start, size) {
  const hash = createHash('sha256');
  if (size === 0) return hash.digest('hex');

  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path, { start, end: start + size - 1 });
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return hash.digest('hex');
}
