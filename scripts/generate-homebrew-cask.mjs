#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'Amux';
const APP_BUNDLE = `${APP_NAME}.app`;
const ARM_ARCH = 'arm64';
const CASK_PATH = 'packaging/homebrew/Casks/amux.rb';
const INTEL_ARCH = 'x64';
const RELEASE_DOWNLOAD_URL = 'https://github.com/amux-app/amux/releases/download/v#{version}/Amux-#{version}-#{arch}.dmg';
const REPO_HOMEPAGE = 'https://github.com/amux-app/amux';
const REPO_VERIFIED_HOST = 'github.com/amux-app/amux/';
const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TMUX_MINIMUM = readTmuxMinimum();

const args = process.argv.slice(2);
const version = getFlagValue(args, '--version') ?? readPackageVersion();
const armDmg = resolve(ROOT_DIR, getFlagValue(args, '--arm-dmg') ?? defaultDmgPath(version, ARM_ARCH));
const intelDmg = resolve(ROOT_DIR, getFlagValue(args, '--intel-dmg') ?? defaultDmgPath(version, INTEL_ARCH));
const output = resolve(ROOT_DIR, getFlagValue(args, '--output') ?? CASK_PATH);

assertFileExists(armDmg, '--arm-dmg');
assertFileExists(intelDmg, '--intel-dmg');
writeCask(output, buildCask(version, hashFile(armDmg), hashFile(intelDmg)));
console.log(`Homebrew cask generated at ${output}`);

function assertFileExists(path, flag) {
  if (existsSync(path)) return;
  throw new Error(`Missing ${flag} artifact: ${path}`);
}

function buildCask(packageVersion, armSha256, intelSha256) {
  return [
    'cask "amux" do',
    '  arch arm: "arm64", intel: "x64"',
    '',
    `  version "${packageVersion}"`,
    `  sha256 arm:   "${armSha256}",`,
    `         intel: "${intelSha256}"`,
    '',
    `  url "${RELEASE_DOWNLOAD_URL}",`,
    `      verified: "${REPO_VERIFIED_HOST}"`,
    `  name "${APP_NAME}"`,
    '  desc "Desktop app for managing multiple AI coding agents through tmux"',
    `  homepage "${REPO_HOMEPAGE}"`,
    '',
    '  livecheck do',
    '    url :url',
    '    strategy :github_latest',
    '  end',
    '',
    '  auto_updates true',
    '  depends_on formula: ["git", "tmux"]',
    '  depends_on macos: ">= :ventura"',
    '',
    ...buildTmuxPreflight(),
    '',
    `  app "${APP_BUNDLE}"`,
    '',
    ...buildCaveats(),
    '',
    '  zap trash: [',
    '    "~/Library/Application Support/Amux",',
    '    "~/Library/Caches/app.amux.desktop",',
    '    "~/Library/Logs/Amux",',
    '    "~/Library/Preferences/app.amux.desktop.plist",',
    '    "~/Library/Saved Application State/app.amux.desktop.savedState",',
    '  ]',
    'end',
    '',
  ].join('\n');
}

function buildTmuxPreflight() {
  return [
    '  preflight do',
    '    tmux_bin = Formula["tmux"].opt_bin/"tmux"',
    '    probe = system_command tmux_bin, args: ["-V"], print_stderr: false',
    '    raw = probe.stdout.strip',
    `    match = raw.match(/\\A(?:tmux\\s+)?(\\d+)\\.(\\d+)([a-z])?\\z/)`,
    `    odie "Amux requires tmux ${TMUX_MINIMUM} or newer, but 'tmux -V' returned: #{raw.empty? ? "nothing" : raw}" unless match`,
    '    installed = [match[1].to_i, match[2].to_i, (match[3] || "").empty? ? 0 : match[3].ord - 96]',
    `    required = ${buildRequiredTuple(TMUX_MINIMUM)}`,
    `    detected = "#{match[1]}.#{match[2]}#{match[3]}"`,
    `    odie "Amux requires tmux ${TMUX_MINIMUM} or newer, but tmux #{detected} is installed. Run: brew upgrade tmux" if (installed <=> required) < 0`,
    '  end',
  ];
}

function buildCaveats() {
  return [
    '  caveats <<~EOS',
    `    Amux requires tmux ${TMUX_MINIMUM} or newer.`,
    '    Recommended install: brew install tmux && brew install --cask amux',
    '    After upgrading tmux, save and close active tmux sessions and restart tmux completely.',
    '  EOS',
  ];
}

function buildRequiredTuple(minimum) {
  const match = minimum.match(/^(\d+)\.(\d+)([a-z])?$/);
  if (!match) throw new Error(`Invalid tmux minimum in system-requirements.json: ${minimum}`);
  const suffix = match[3] ? match[3].charCodeAt(0) - 96 : 0;
  return `[${Number(match[1])}, ${Number(match[2])}, ${suffix}]`;
}

function defaultDmgPath(packageVersion, arch) {
  return `desktop/release/${APP_NAME}-${packageVersion}-${arch}.dmg`;
}

function getFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
  return packageJson.version;
}

function readTmuxMinimum() {
  const requirements = JSON.parse(readFileSync(resolve(ROOT_DIR, 'config/system-requirements.json'), 'utf8'));
  return requirements.tmux.minimum;
}

function writeCask(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
