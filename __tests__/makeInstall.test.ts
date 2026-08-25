import { createPackage, getRawHeader } from '@electron/asar';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPackageArgs,
  resolveInstallDir,
  validatePackagedArchive,
  waitForAppLaunch,
} from '../scripts/install-local-app-utils.mjs';

const ROOT_DIR = resolve(__dirname, '..');
const MAKEFILE_PATH = resolve(ROOT_DIR, 'Makefile');
const INSTALL_SCRIPT_PATH = resolve(ROOT_DIR, 'scripts', 'install-local-app.mjs');
const INSTALL_UTILS_PATH = resolve(ROOT_DIR, 'scripts', 'install-local-app-utils.mjs');
const TOOLCHAIN_CHECK_PATH = resolve(ROOT_DIR, 'scripts', 'check-managed-toolchain.mjs');
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function readMakeTargetBody(target: string): string {
  const source = readFileSync(MAKEFILE_PATH, 'utf8');
  const match = source.match(new RegExp(`^${target}:.*(?:\\n\\t.*)*`, 'm'));
  return match?.[0] ?? '';
}

describe('make install contract', () => {
  it('uses make install as the only app installation entrypoint', () => {
    // Arrange
    const makefile = readFileSync(MAKEFILE_PATH, 'utf8');

    // Act
    const installTarget = readMakeTargetBody('install');

    // Assert
    expect(makefile).toMatch(/^install:.*## Install MuxBase\.app from source/m);
    expect(makefile).not.toMatch(/^install-app:/m);
    expect(makefile).not.toContain(' install-app ');
    expect(installTarget).toContain('node scripts/install-local-app.mjs');
  });

  it('keeps the app installation workflow in a dedicated installer script', () => {
    // Assert
    expect(existsSync(INSTALL_SCRIPT_PATH)).toBe(true);

    const source = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    const utilsSource = readFileSync(INSTALL_UTILS_PATH, 'utf8');
    expect(source).toContain('pnpm');
    expect(source).toContain('electron-vite');
    expect(source).toContain('install-local-app-utils.mjs');
    expect(source).not.toContain('pnpm@latest');
    expect(source).toContain('readManagedToolchainRequirements');
    expect(utilsSource).toContain('electron-builder');
    expect(utilsSource).toContain('/Applications');
  });

  it('verifies the managed toolchain after installation and before building', () => {
    const installer = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    const installIndex = installer.indexOf("['install', '--frozen-lockfile']");
    const checkIndex = installer.indexOf("['exec', 'node', 'scripts/check-managed-toolchain.mjs']");
    const buildIndex = installer.indexOf("['-w', '--filter', 'muxbase', 'build']");

    expect(existsSync(TOOLCHAIN_CHECK_PATH)).toBe(true);
    expect(installIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeGreaterThan(installIndex);
    expect(buildIndex).toBeGreaterThan(checkIndex);
  });

  it('applies the Node 24 crypto shim to the managed runtime regardless of the host Node version', () => {
    const makefile = readFileSync(MAKEFILE_PATH, 'utf8');
    const installer = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');

    expect(makefile).not.toContain('NODE_MAJOR');
    expect(makefile).toContain('export NODE_OPTIONS := --import');
    expect(installer).not.toContain('if (major < 24');
  });

  it('provisions tmux before validating a fresh-clone bootstrap', () => {
    const bootstrapTarget = readMakeTargetBody('bootstrap');

    expect(bootstrapTarget).not.toMatch(/^bootstrap: doctor/);
    expect(bootstrapTarget).toContain('ensure-tmux.mjs --provision');
    expect(bootstrapTarget).toContain('$(MAKE) doctor');
    expect(bootstrapTarget.indexOf('--provision')).toBeLessThan(
      bootstrapTarget.indexOf('$(MAKE) doctor'),
    );
    expect(bootstrapTarget.indexOf('pnpm install')).toBeLessThan(
      bootstrapTarget.indexOf('$(MAKE) doctor'),
    );
  });

  it('reuses the package verified by release-verify for make pack', () => {
    const packTarget = readMakeTargetBody('pack');

    expect(packTarget).toMatch(/^pack: release-verify/);
    expect(packTarget).not.toContain('electron-builder');
  });

  it('ad-hoc signs local mac packages instead of skipping arm64 signing', () => {
    // Act
    const args = buildPackageArgs('20260518090000', '0.1.0.20260518090000');

    // Assert
    expect(args).toContain('-c.mac.identity=-');
    expect(args).not.toContain('-c.mac.identity=null');
  });

  it('falls back to the user Applications folder when the system Applications folder is not writable', () => {
    // Act
    const plan = resolveInstallDir({
      canWriteSystemApplications: false,
      envInstallDir: undefined,
      homeDir: '/Users/alice',
    });

    // Assert
    expect(plan).toEqual({
      installDir: '/Users/alice/Applications',
      source: 'user',
    });
  });

  it('keeps an explicit MUXBASE_INSTALL_DIR even when the system Applications folder is not writable', () => {
    // Act
    const plan = resolveInstallDir({
      canWriteSystemApplications: false,
      envInstallDir: ' /tmp/MuxBase ',
      homeDir: '/Users/alice',
    });

    // Assert
    expect(plan).toEqual({
      installDir: '/tmp/MuxBase',
      source: 'environment',
    });
  });

  it('rejects an ASAR whose payload changed after its integrity header was written', async () => {
    // Arrange: build a real archive, then reproduce the cross-file corruption
    // seen when another build mutates packaging inputs while electron-builder reads.
    const sourceDir = makeScratchDir('muxbase-asar-source-');
    const archivePath = join(makeScratchDir('muxbase-asar-output-'), 'app.asar');
    writeMinimalPackagedApp(sourceDir);
    await createPackage(sourceDir, archivePath);
    const header = getRawHeader(archivePath);
    const outRecord = header.header.files.out;
    const mainRecord = outRecord && 'files' in outRecord
      ? outRecord.files.main
      : undefined;
    const mainIndexRecord = mainRecord && 'files' in mainRecord
      ? mainRecord.files['index.js']
      : undefined;
    if (!mainIndexRecord || 'files' in mainIndexRecord) {
      throw new Error('out/main/index.js missing from test archive');
    }

    const fd = openSync(archivePath, 'r+');
    try {
      writeSync(fd, Buffer.from('X'), 0, 1, 8 + header.headerSize + Number(mainIndexRecord.offset));
    } finally {
      closeSync(fd);
    }

    // Act / Assert
    await expect(validatePackagedArchive(archivePath)).rejects.toThrow(
      'Archive integrity check failed for out/main/index.js',
    );
  });

  it('accepts an ASAR when every payload matches its integrity header', async () => {
    // Arrange
    const sourceDir = makeScratchDir('muxbase-asar-source-');
    const archivePath = join(makeScratchDir('muxbase-asar-output-'), 'app.asar');
    writeMinimalPackagedApp(sourceDir);
    await createPackage(sourceDir, archivePath);

    // Act / Assert
    await expect(validatePackagedArchive(archivePath)).resolves.toBeUndefined();
  });

  it('does not report launch success until the app is observed running', async () => {
    // Arrange
    const observations = [false, false, true, true, true, true];
    let waits = 0;

    // Act
    await waitForAppLaunch(
      () => observations.shift() ?? false,
      async () => {
        waits += 1;
      },
      observations.length,
    );

    // Assert
    expect(waits).toBe(5);
  });

  it('fails installation when the launched app exits before becoming ready', async () => {
    await expect(
      waitForAppLaunch(
        () => false,
        async () => {},
        3,
      ),
    ).rejects.toThrow('MuxBase exited during startup');
  });
});

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeMinimalPackagedApp(root: string): void {
  mkdirSync(join(root, 'out', 'main'), { recursive: true });
  mkdirSync(join(root, 'out', 'preload'), { recursive: true });
  mkdirSync(join(root, 'out', 'renderer'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"main":"./out/main/index.js"}\n');
  writeFileSync(join(root, 'out', 'main', 'index.js'), 'export const boot = true;\n');
  writeFileSync(join(root, 'out', 'preload', 'index.js'), '"use strict";\n');
  writeFileSync(join(root, 'out', 'renderer', 'index.html'), '<!doctype html>\n');
}
