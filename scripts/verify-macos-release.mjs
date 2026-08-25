#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ARCHITECTURES = ['arm64', 'x64'];
const APP_NAME = 'MuxBase';
const APP_EXECUTABLE = 'MuxBase';
const LAUNCH_STABILITY_MS = 3_000;
const LAUNCH_TERMINATION_MS = 5_000;
const MINIMUM_MACOS_VERSION = '13.0';
const UPDATE_PROVIDER = Object.freeze({ owner: 'muxbase-app', provider: 'github', repo: 'muxbase' });

export function validateReleaseMetadata(releaseDir, version) {
  if (!version?.trim()) throw new Error('A release version is required');

  const artifacts = ARCHITECTURES.flatMap((arch) => [
    `${APP_NAME}-${version}-${arch}.dmg`,
    `${APP_NAME}-${version}-${arch}.zip`,
  ]);
  for (const artifact of [
    ...artifacts,
    'latest-mac.yml',
    'SHA256SUMS',
    'muxbase-sbom.cdx.json',
  ]) {
    const path = join(releaseDir, artifact);
    if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);
  }

  const metadata = parseYamlMapping(join(releaseDir, 'latest-mac.yml'), 'Updater metadata');
  if (metadata.version !== version) {
    throw new Error(`Updater metadata does not declare version ${version}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== ARCHITECTURES.length) {
    throw new Error(`Updater metadata must contain exactly ${ARCHITECTURES.length} ZIP entries`);
  }

  const releases = ARCHITECTURES.map((arch) => {
    const zipName = `${APP_NAME}-${version}-${arch}.zip`;
    const entries = metadata.files.filter((entry) => entry?.url === zipName);
    if (entries.length !== 1) {
      throw new Error(`Updater metadata must contain exactly one ${zipName} entry`);
    }

    const entry = entries[0];
    const zipPath = join(releaseDir, zipName);
    const actualSize = statSync(zipPath).size;
    if (!Number.isSafeInteger(entry.size) || entry.size !== actualSize) {
      throw new Error(`Updater metadata size does not match ${zipName}`);
    }
    const actualSha512 = createHash('sha512').update(readFileSync(zipPath)).digest('base64');
    if (typeof entry.sha512 !== 'string' || entry.sha512 !== actualSha512) {
      throw new Error(`Updater metadata SHA-512 does not match ${zipName}`);
    }

    return {
      arch,
      dmgPath: join(releaseDir, `${APP_NAME}-${version}-${arch}.dmg`),
      zipPath,
    };
  });

  const expectedZipNames = new Set(releases.map(({ zipPath }) => basename(zipPath)));
  for (const entry of metadata.files) {
    if (!entry || typeof entry.url !== 'string' || !expectedZipNames.has(entry.url)) {
      throw new Error(`Updater metadata references an unexpected file: ${String(entry?.url)}`);
    }
  }
  if (typeof metadata.path !== 'string' || !expectedZipNames.has(metadata.path)) {
    throw new Error('Updater metadata path must reference one of the verified ZIP payloads');
  }
  const defaultEntry = metadata.files.find((entry) => entry.url === metadata.path);
  if (!defaultEntry || metadata.sha512 !== defaultEntry.sha512) {
    throw new Error('Updater metadata top-level SHA-512 does not match its default ZIP');
  }

  return releases;
}

export function validateMachOArchitectures(output, expectedArch, label) {
  const architectures = output.trim().split(/\s+/).filter(Boolean);
  const machOArch = expectedArch === 'x64' ? 'x86_64' : expectedArch;
  if (!architectures.includes(machOArch)) {
    throw new Error(
      `${label} is not compatible with ${expectedArch} (reported: `
      + `${architectures.join(', ') || 'no architectures'})`,
    );
  }
}

async function verifyRelease(releaseDir, version) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release verification must run on macOS');
  }

  const dmgs = validateReleaseMetadata(releaseDir, version);
  run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], releaseDir);
  validateChecksumCoverage(releaseDir, version);

  const mountRoot = mkdtempSync(join(tmpdir(), 'muxbase-release-verify-'));
  try {
    for (const { arch, dmgPath } of dmgs) {
      const mountPoint = join(mountRoot, arch);
      mkdirSync(mountPoint);
      run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
      try {
        const appPath = join(mountPoint, `${APP_NAME}.app`);
        if (!existsSync(appPath)) {
          throw new Error(`${basename(dmgPath)} does not contain ${APP_NAME}.app`);
        }
        verifyApplicationsLink(mountPoint, dmgPath);
        verifyMountedArchitectures(appPath, arch);
        run('codesign', ['--verify', '--deep', '--strict', '--verbose=3', appPath]);
        verifyHardenedRuntime(appPath, arch);
        run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
        run('xcrun', ['stapler', 'validate', appPath]);
        run('xcrun', ['stapler', 'validate', dmgPath]);
        verifyBundleUpdateContract(appPath, arch);
        await verifyAppLaunch(appPath, arch);
      } finally {
        run('hdiutil', ['detach', mountPoint]);
      }
    }
  } finally {
    rmSync(mountRoot, { force: true, recursive: true });
  }
}

function validateChecksumCoverage(releaseDir, version) {
  const manifest = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8');
  const covered = new Set(
    manifest
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter(Boolean),
  );
  const required = [
    'muxbase-sbom.cdx.json',
    'latest-mac.yml',
    ...ARCHITECTURES.flatMap((arch) => [
      `${APP_NAME}-${version}-${arch}.dmg`,
      `${APP_NAME}-${version}-${arch}.zip`,
    ]),
    ...readdirSync(releaseDir).filter((name) => name.endsWith('.blockmap')),
  ];
  for (const name of required) {
    if (!covered.has(name)) throw new Error(`SHA256SUMS does not cover ${name}`);
  }
}

function verifyApplicationsLink(mountPoint, dmgPath) {
  const linkPath = join(mountPoint, 'Applications');
  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) {
    throw new Error(`${basename(dmgPath)} does not contain an Applications symlink`);
  }
  if (readlinkSync(linkPath) !== '/Applications') {
    throw new Error(`${basename(dmgPath)} Applications link does not target /Applications`);
  }
}

function verifyHardenedRuntime(appPath, arch) {
  const result = spawnSync('codesign', ['-d', '--verbose=4', appPath], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 || !/flags=.*\bruntime\b/i.test(output)) {
    throw new Error(`${arch} app is not signed with hardened runtime`);
  }
}

function verifyBundleUpdateContract(appPath, arch) {
  const resources = join(appPath, 'Contents', 'Resources');
  const updateConfigPath = join(resources, 'app-update.yml');
  if (!existsSync(updateConfigPath)) {
    throw new Error(`${arch} app is missing embedded app-update.yml`);
  }
  const config = parseYamlMapping(updateConfigPath, `${arch} app-update.yml`);
  for (const [key, value] of Object.entries(UPDATE_PROVIDER)) {
    if (config[key] !== value) {
      throw new Error(`${arch} app-update.yml must set ${key} to ${value}`);
    }
  }
  if (config.channel !== 'latest') {
    throw new Error(`${arch} app-update.yml must use the latest stable channel`);
  }

  const plistPath = join(appPath, 'Contents', 'Info.plist');
  const minimumVersion = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :LSMinimumSystemVersion', plistPath],
    { encoding: 'utf8' },
  ).trim();
  if (minimumVersion !== MINIMUM_MACOS_VERSION) {
    throw new Error(`${arch} app requires macOS ${minimumVersion}; expected ${MINIMUM_MACOS_VERSION}`);
  }
}

function verifyMountedArchitectures(appPath, arch) {
  const binaries = [
    ['app executable', join(appPath, 'Contents', 'MacOS', APP_EXECUTABLE)],
    [
      'node-pty native module',
      join(
        appPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'build',
        'Release',
        'pty.node',
      ),
    ],
    [
      'node-pty spawn helper',
      join(
        appPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'build',
        'Release',
        'spawn-helper',
      ),
    ],
  ];

  for (const [label, path] of binaries) {
    if (!existsSync(path)) throw new Error(`${arch} app is missing its ${label}: ${path}`);
    const output = execFileSync('lipo', ['-archs', path], { encoding: 'utf8' });
    validateMachOArchitectures(output, arch, `${arch} ${label}`);
  }
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
}

export function verifyAppLaunch(appPath, arch) {
  const executable = join(appPath, 'Contents', 'MacOS', APP_EXECUTABLE);
  if (!existsSync(executable)) {
    throw new Error(`${arch} app is missing its executable: ${executable}`);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [], {
      env: { ...process.env, MUXBASE_E2E: '1', NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let stableTimer;
    let terminationTimer;
    let passedStabilityWindow = false;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('spawn', () => {
      stableTimer = setTimeout(() => {
        passedStabilityWindow = true;
        child.kill('SIGTERM');
        terminationTimer = setTimeout(() => child.kill('SIGKILL'), LAUNCH_TERMINATION_MS);
      }, LAUNCH_STABILITY_MS);
    });
    child.once('exit', (code, signal) => {
      if (stableTimer) clearTimeout(stableTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (!passedStabilityWindow) {
        rejectPromise(new Error(
          `${arch} mounted app exited during launch (code=${code}, signal=${signal}): ${stderr.trim()}`,
        ));
        return;
      }
      resolvePromise();
    });
  });
}

function parseYamlMapping(path, label) {
  let value;
  try {
    value = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return value;
}

function readCliArgs(argv) {
  const releaseDirIndex = argv.indexOf('--release-dir');
  const versionIndex = argv.indexOf('--version');
  if (releaseDirIndex === -1 || !argv[releaseDirIndex + 1]) {
    throw new Error('--release-dir is required');
  }
  if (versionIndex === -1 || !argv[versionIndex + 1]) {
    throw new Error('--version is required');
  }
  return {
    releaseDir: resolve(argv[releaseDirIndex + 1]),
    version: argv[versionIndex + 1],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { releaseDir, version } = readCliArgs(process.argv.slice(2));
    await verifyRelease(releaseDir, version);
    console.log(`Verified signed, notarized macOS release ${version} for arm64 and x64`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
