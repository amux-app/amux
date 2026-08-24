import { describe, expect, it } from 'vitest';
import spriteMarkup from '../src/renderer/assets/file-icons/generated/file-icon-sprite.svg?raw';
import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_NAMES,
  FILE_ICON_PALETTES,
  FOLDER_ICON_NAMES,
} from '../src/renderer/assets/file-icons/generated/fileIconMaps';
import { getFileExtColor } from '../src/renderer/lib/constants';
import { resolveFileIcon, resolveFolderIcon, resolveRootFolderIcon } from '../src/renderer/lib/fileIcons';

const BASE_ICON_IDS = ['_file', '_folder', '_folder_open', '_root', '_root_open'];
const OPEN_ICON_SUFFIX = '_open';
const UNMAPPED_FILE_NAME = 'notes.xyzzy';

function spriteSymbolIds(): Set<string> {
  return new Set([...spriteMarkup.matchAll(/<symbol id="([^"]+)"/g)].map(([, id]) => id));
}

function referencedIconIds(): string[] {
  const folderIds = Object.values(FOLDER_ICON_NAMES);
  return [
    ...BASE_ICON_IDS,
    ...Object.keys(FILE_ICON_PALETTES),
    ...Object.values(FILE_ICON_NAMES),
    ...Object.values(FILE_ICON_EXTENSIONS),
    ...folderIds,
    ...folderIds.map((id) => `${id}${OPEN_ICON_SUFFIX}`),
  ];
}

describe('resolveFileIcon precedence', () => {
  it('prefers an exact file name over its extension', () => {
    // Arrange & Act
    const icon = resolveFileIcon('readme.md');

    // Assert
    expect(icon.symbolId).toBe('fi-readme');
  });

  it('prefers a compound extension over the simple extension', () => {
    // Arrange & Act
    const compound = resolveFileIcon('client.test.ts');
    const simple = resolveFileIcon('client.ts');

    // Assert
    expect(compound.symbolId).toBe('fi-typescript-test');
    expect(simple.symbolId).toBe('fi-typescript');
  });

  it('falls back to the default glyph when nothing matches', () => {
    // Arrange & Act
    const icon = resolveFileIcon(UNMAPPED_FILE_NAME);

    // Assert
    expect(icon.symbolId).toBe('fi-_file');
  });

  it('matches names and extensions case-insensitively', () => {
    // Arrange & Act
    const icon = resolveFileIcon('README.MD');
    const extensionIcon = resolveFileIcon('Client.TS');

    // Assert
    expect(icon.symbolId).toBe('fi-readme');
    expect(extensionIcon.symbolId).toBe('fi-typescript');
  });
});

describe('file icon colors', () => {
  it('maps a known glyph onto a theme token', () => {
    // Arrange & Act
    const icon = resolveFileIcon('client.ts');

    // Assert
    expect(icon.color).toBe('var(--accent)');
  });

  it('keeps the existing extension tint for unmapped files', () => {
    // Arrange & Act
    const icon = resolveFileIcon(UNMAPPED_FILE_NAME);

    // Assert
    expect(icon.symbolId).toBe('fi-_file');
    expect(icon.color).toBe(getFileExtColor(UNMAPPED_FILE_NAME));
  });
});

describe('folder icons', () => {
  it('uses the special folder glyph for both expand states', () => {
    // Arrange & Act
    const closed = resolveFolderIcon('src', false);
    const open = resolveFolderIcon('src', true);

    // Assert
    expect(closed.symbolId).toBe('fi-folder_src');
    expect(open.symbolId).toBe('fi-folder_src_open');
    expect(open.color).toBe(closed.color);
  });

  it('resolves aliased folder names', () => {
    // Arrange & Act
    const icon = resolveFolderIcon('node_modules', false);

    // Assert
    expect(icon.symbolId).toBe('fi-folder_node');
  });

  it('keeps the neutral and amber cue for unmapped folders and the root', () => {
    // Arrange & Act
    const closed = resolveFolderIcon('anything-unmapped', false);
    const open = resolveFolderIcon('anything-unmapped', true);
    const root = resolveRootFolderIcon(true);

    // Assert
    expect(closed).toEqual({ color: 'var(--text-muted)', symbolId: 'fi-_folder' });
    expect(open).toEqual({ color: 'var(--warning)', symbolId: 'fi-_folder_open' });
    expect(root).toEqual({ color: 'var(--warning)', symbolId: 'fi-_root_open' });
  });
});

describe('generated sprite integrity', () => {
  it('defines a symbol for every icon id the maps reference', () => {
    // Arrange
    const symbolIds = spriteSymbolIds();

    // Act
    const missing = [...new Set(referencedIconIds())].filter((id) => !symbolIds.has(`fi-${id}`));

    // Assert
    expect(missing).toEqual([]);
  });

  it('normalizes every glyph color to currentColor', () => {
    // Arrange & Act
    const catppuccinVariables = spriteMarkup.match(/var\(--vscode-ctp-[a-z0-9]+\)/g);

    // Assert
    expect(catppuccinVariables).toBeNull();
  });
});
