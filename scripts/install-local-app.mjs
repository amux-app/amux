#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManagedToolchainRequirements } from './check-managed-toolchain.mjs';
import {
  buildPackageArgs,
  resolveInstallDir,
  SYSTEM_APPLICATIONS_DIR,
  validatePackagedArchive,
  waitForAppLaunch,
} from './install-local-app-utils.mjs';

const APP_BUNDLE = 'MuxBase.app';
const APP_ID = 'app.muxbase.desktop';
const DESKTOP_PACKAGE_PATH = 'desktop/package.json';
const NO_LAUNCH = process.env.MUXBASE_INSTALL_NO_LAUNCH === '1';
const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DESKTOP_DIR = resolve(ROOT_DIR, 'desktop');
const RELEASE_DIR = resolve(DESKTOP_DIR, 'release');
const CRYPTO_FIX = resolve(ROOT_DIR, 'scripts', 'node24-crypto-fix.mjs');
const LAUNCH_CHECK_ATTEMPTS = 20;
const LAUNCH_CHECK_INTERVAL_MS = 500;

applyNode24CryptoFix();

async function main() {
  assertMacOS();
  const { pnpmVersion } = readManagedToolchainRequirements(ROOT_DIR);
  assertPnpmAvailable(pnpmVersion);

  const buildNumber = createBuildNumber();
  const packageVersion = readPackageVersion();
  const buildVersion = `${packageVersion}.${buildNumber}`;
  const installPlan = createInstallPlan();
  const installedAppPath = resolve(installPlan.installDir, APP_BUNDLE);

  await runStep('Installing workspace dependencies', 'pnpm', ['install', '--frozen-lockfile'], ROOT_DIR);
  await runStep(
    'Verifying managed build toolchain',
    'pnpm',
    ['exec', 'node', 'scripts/check-managed-toolchain.mjs'],
    ROOT_DIR,
  );
  await runStep('Building core package', 'pnpm', ['-w', '--filter', 'muxbase', 'build'], ROOT_DIR);
  await runStep('Building desktop app', 'pnpm', ['exec', 'electron-vite', 'build'], DESKTOP_DIR);
  await cleanReleaseDir();
  await runStep('Packaging local MuxBase app', 'pnpm', buildPackageArgs(buildNumber, buildVersion), DESKTOP_DIR);
  const packagedAppPath = findPackagedApp();
  await validatePackagedApp(packagedAppPath);
  await quitRunningApp();
  await installPackagedApp(packagedAppPath, installPlan.installDir);

  if (!NO_LAUNCH) {
    await runStep('Launching MuxBase', 'open', [installedAppPath], ROOT_DIR);
    console.log('Confirming MuxBase remains running...');
    await waitForAppLaunch(
      isAppRunning,
      () => new Promise((resolvePromise) => setTimeout(resolvePromise, LAUNCH_CHECK_INTERVAL_MS)),
      LAUNCH_CHECK_ATTEMPTS,
    );
  }

  console.log(`Installed MuxBase ${packageVersion} (${buildVersion}) to ${installedAppPath}`);
}

function assertMacOS() {
  if (process.platform === 'darwin') return;
  throw new Error('make install installs the macOS MuxBase.app bundle and must run on macOS.');
}

function assertPnpmAvailable(pnpmVersion) {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `pnpm is not available. Install it with: corepack enable && corepack prepare pnpm@${pnpmVersion} --activate`,
    );
  }
}

async function cleanReleaseDir() {
  await rm(RELEASE_DIR, { force: true, recursive: true });
}

async function validatePackagedApp(appPath) {
  const archivePath = resolve(appPath, 'Contents', 'Resources', 'app.asar');
  console.log('Validating packaged MuxBase archive...');
  await validatePackagedArchive(archivePath);
}

function createBuildNumber() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

function findPackagedApp() {
  const matches = readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => resolve(RELEASE_DIR, entry.name, APP_BUNDLE))
    .filter((path) => existsSync(path))
    .sort();

  if (matches.length === 0) {
    throw new Error(`Packaged ${APP_BUNDLE} was not found in ${RELEASE_DIR}.`);
  }

  const archMatch = matches.find((path) => path.includes(process.arch));
  return archMatch ?? matches[0];
}

async function installPackagedApp(sourcePath, installDir) {
  const targetPath = resolve(installDir, APP_BUNDLE);
  await mkdir(installDir, { recursive: true });
  assertWritableInstallTarget(installDir, targetPath);
  await rm(targetPath, { force: true, recursive: true });
  await runStep(`Installing MuxBase.app to ${installDir}`, 'ditto', [sourcePath, targetPath], ROOT_DIR);
}

async function quitRunningApp() {
  console.log('Quitting any running MuxBase instance');
  await run('osascript', ['-e', `tell application id "${APP_ID}" to quit`], ROOT_DIR, {
    allowFailure: true,
    quiet: true,
  });
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 1000);
  });
}

function isAppRunning() {
  try {
    return execFileSync(
      'osascript',
      ['-e', `application id "${APP_ID}" is running`],
      { encoding: 'utf8', timeout: 2000 },
    ).trim() === 'true';
  } catch {
    return false;
  }
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, DESKTOP_PACKAGE_PATH), 'utf8'));
  return packageJson.version;
}

function createInstallPlan() {
  const systemTargetPath = resolve(SYSTEM_APPLICATIONS_DIR, APP_BUNDLE);
  const plan = resolveInstallDir({
    canWriteSystemApplications: canWritePath(SYSTEM_APPLICATIONS_DIR) && canReplacePath(systemTargetPath),
    envInstallDir: process.env.MUXBASE_INSTALL_DIR,
    homeDir: homedir(),
  });

  if (plan.source === 'user') {
    console.log(`${SYSTEM_APPLICATIONS_DIR} is not writable; installing to ${plan.installDir} instead.`);
  }

  return plan;
}

function assertWritableInstallTarget(installDir, targetPath) {
  if (!canWritePath(installDir)) {
    throw new Error(`Install directory is not writable: ${installDir}. Set MUXBASE_INSTALL_DIR to a writable directory.`);
  }

  if (existsSync(targetPath) && !canReplacePath(targetPath)) {
    throw new Error(`Existing app bundle is not writable: ${targetPath}. Remove it or set MUXBASE_INSTALL_DIR to a writable directory.`);
  }
}

function canReplacePath(path) {
  return !existsSync(path) || canWritePath(path);
}

function canWritePath(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function runStep(label, command, args, cwd) {
  console.log(`${label}...`);
  await run(command, args, cwd);
}

function run(command, args, cwd, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      stdio: options.quiet ? 'ignore' : 'inherit',
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function applyNode24CryptoFix() {
  if (!existsSync(CRYPTO_FIX)) return;

  const importFlag = `--import ${CRYPTO_FIX}`;
  const current = process.env.NODE_OPTIONS || '';
  if (!current.includes(importFlag)) {
    process.env.NODE_OPTIONS = current ? `${current} ${importFlag}` : importFlag;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
