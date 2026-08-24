#!/usr/bin/env node
/**
 * Vendors the Catppuccin VS Code icon set into src/renderer/assets/file-icons/vendor.
 *
 * Upstream: https://github.com/catppuccin/vscode-icons (MIT)
 * Requires network access; run only when bumping UPSTREAM_REVISION.
 * The offline codegen step is scripts/generate-file-icons.mjs.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_URL = 'https://github.com/catppuccin/vscode-icons.git';
const UPSTREAM_REVISION = 'b6915da9f6889b683a110aa747de96c2820a537d';
const SVG_SUFFIX = '.svg';
const FOLDER_PREFIX = 'folder_';
const OPEN_SUFFIX = '_open';
const JSON_INDENT = 2;
const MAX_DUMP_BYTES = 32 * 1024 * 1024;

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(desktopRoot, 'src/renderer/assets/file-icons/vendor');

/** Always required: the generic file/folder/root glyphs used when nothing else matches. */
const BASE_ICONS = ['_file', '_folder', '_folder_open', '_root', '_root_open'];

/**
 * File icons excluded from the vendored set: proprietary design suites, game engines,
 * the Roblox/Luau ecosystem, office documents and legacy scientific languages.
 * `humans`, `poetry-lock` and `wally` additionally paint with fixed colors that cannot follow the
 * app theme; scripts/generate-file-icons.mjs fails when such an icon is vendored.
 */
const EXCLUDED_FILE_ICONS = new Set([
  '3d', 'adobe-ae', 'adobe-ai', 'adobe-id', 'adobe-ps', 'adobe-xd', 'autohotkey', 'blink', 'cobol',
  'darklua', 'drawio', 'dub', 'dub-selections', 'figma', 'fortran', 'godot', 'godot-assets', 'hare',
  'huff', 'humans', 'juce', 'jule', 'latte', 'lua-check', 'lua-client', 'lua-rocks', 'lua-server',
  'lua-test', 'luau', 'luau-check', 'luau-client', 'luau-config', 'luau-server', 'luau-test', 'mantle',
  'matlab', 'midi', 'moonwave', 'ms-excel', 'ms-powerpoint', 'ms-word', 'pesde', 'pesde-lock', 'phrase',
  'poetry-lock', 'premake', 'r', 'rdata', 'rmd', 'roblox', 'rojo', 'rokit', 'rproj', 'rsml',
  'salesforce', 'sketch',
  'slidesk', 'spwn', 'squirrel', 'stata', 'super-collider', 'twine', 'unity', 'vhs', 'vital', 'wally',
  'xmake',
]);

/** Folder icons kept: directory names that appear in mainstream application repositories. */
const INCLUDED_FOLDER_ICONS = new Set([
  'api', 'app', 'assets', 'aws', 'cargo', 'circle-ci', 'components', 'config', 'coverage', 'cypress',
  'database', 'devcontainer', 'dist', 'docker', 'docs', 'examples', 'fonts', 'functions', 'git', 'github',
  'gitlab', 'gradle', 'graphql', 'hooks', 'husky', 'images', 'include', 'javascript', 'kubernetes',
  'layouts', 'lib', 'locales', 'middleware', 'mocks', 'next', 'node', 'packages', 'plugins', 'prisma',
  'private', 'proto', 'public', 'redux', 'routes', 'sass', 'scripts', 'security', 'server', 'shared',
  'src', 'storybook', 'styles', 'svg', 'temp', 'templates', 'tests', 'themes', 'turbo', 'types', 'upload',
  'utils', 'views', 'vscode', 'workflows',
]);

function isVendored(iconId) {
  if (BASE_ICONS.includes(iconId)) return true;
  if (iconId.startsWith(FOLDER_PREFIX)) {
    const base = iconId.slice(FOLDER_PREFIX.length).replace(new RegExp(`${OPEN_SUFFIX}$`), '');
    return INCLUDED_FOLDER_ICONS.has(base);
  }
  return !EXCLUDED_FILE_ICONS.has(iconId);
}

function cloneUpstream() {
  const checkout = mkdtempSync(join(tmpdir(), 'catppuccin-icons-'));
  execFileSync('git', ['init', '--quiet'], { cwd: checkout });
  execFileSync('git', ['remote', 'add', 'origin', UPSTREAM_URL], { cwd: checkout });
  execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', UPSTREAM_REVISION], { cwd: checkout });
  execFileSync('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: checkout });
  return checkout;
}

function copyIcons(checkout) {
  const sourceDir = join(checkout, 'icons/css-variables');
  const targetDir = join(vendorDir, 'icons');
  rmSync(targetDir, { force: true, recursive: true });
  mkdirSync(targetDir, { recursive: true });

  const copied = readdirSync(sourceDir)
    .filter((entry) => entry.endsWith(SVG_SUFFIX))
    .filter((entry) => isVendored(entry.slice(0, -SVG_SUFFIX.length)));

  for (const entry of copied) {
    cpSync(join(sourceDir, entry), join(targetDir, entry));
  }
  return copied.length;
}

const DUMP_MODULE = `import { fileIcons } from './src/defaults/fileIcons.ts';
import { folderIcons } from './src/defaults/folderIcons.ts';
process.stdout.write(JSON.stringify({ fileIcons, folderIcons }));
`;

function readUpstreamAssociations(checkout) {
  const dumpPath = join(checkout, 'dump-associations.mts');
  writeFileSync(dumpPath, DUMP_MODULE);
  const raw = execFileSync(process.execPath, ['--experimental-strip-types', dumpPath], {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: MAX_DUMP_BYTES,
  });
  return JSON.parse(raw);
}

function writeAssociations(name, icons) {
  const payload = {
    source: UPSTREAM_URL,
    revision: UPSTREAM_REVISION,
    license: 'MIT',
    icons,
  };
  writeFileSync(join(vendorDir, name), `${JSON.stringify(payload, null, JSON_INDENT)}\n`);
}

const checkout = cloneUpstream();
mkdirSync(vendorDir, { recursive: true });
cpSync(join(checkout, 'LICENSE'), join(vendorDir, 'LICENSE'));
const iconCount = copyIcons(checkout);
const { fileIcons, folderIcons } = readUpstreamAssociations(checkout);
writeAssociations('file-associations.json', fileIcons);
writeAssociations('folder-associations.json', folderIcons);
rmSync(checkout, { force: true, recursive: true });

process.stdout.write(`Vendored ${iconCount} Catppuccin icons at ${UPSTREAM_REVISION}\n`);
