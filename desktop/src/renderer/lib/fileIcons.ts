import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_NAMES,
  FILE_ICON_PALETTES,
  FOLDER_ICON_NAMES,
  type FileIconPalette,
} from '../assets/file-icons/generated/fileIconMaps';
import { getFileExtColor } from './constants';

const DEFAULT_FILE_ICON = '_file';
const DEFAULT_FOLDER_ICON = '_folder';
const OPEN_ICON_SUFFIX = '_open';
const ROOT_FOLDER_ICON = '_root';
const SYMBOL_ID_PREFIX = 'fi-';

export interface FileIconRef {
  color: string;
  symbolId: string;
}

/**
 * Catppuccin ships one semantic palette name per glyph. Each name is bound to an existing
 * theme token so icons follow the active light or dark theme instead of a fixed hex palette.
 */
const PALETTE_COLORS: Record<FileIconPalette, string> = {
  blue: 'var(--accent)',
  flamingo: 'var(--agent-brand-codex)',
  green: 'var(--success)',
  lavender: 'var(--agent-brand-claude)',
  maroon: 'var(--error)',
  mauve: 'var(--agent-analyzing)',
  overlay1: 'var(--text-muted)',
  peach: 'var(--agent-brand-codex)',
  pink: 'var(--agent-analyzing)',
  red: 'var(--error)',
  rosewater: 'var(--text-secondary)',
  sapphire: 'var(--accent)',
  sky: 'var(--agent-brand-opencode)',
  teal: 'var(--agent-working)',
  text: 'var(--text-secondary)',
  yellow: 'var(--warning)',
};

/** The generic folder and root glyphs keep the tree's established neutral/amber cue. */
const BASE_FOLDER_COLORS: Record<string, string> = {
  [DEFAULT_FOLDER_ICON]: 'var(--text-muted)',
  [`${DEFAULT_FOLDER_ICON}${OPEN_ICON_SUFFIX}`]: 'var(--warning)',
  [ROOT_FOLDER_ICON]: 'var(--text-muted)',
  [`${ROOT_FOLDER_ICON}${OPEN_ICON_SUFFIX}`]: 'var(--warning)',
};

function toSymbolId(iconId: string): string {
  return `${SYMBOL_ID_PREFIX}${iconId}`;
}

function paletteColor(iconId: string): string {
  return PALETTE_COLORS[FILE_ICON_PALETTES[iconId]];
}

/** Longest suffix wins, so `component.test.tsx` matches `test.tsx` before `tsx`. */
function findExtensionIconId(lowerFileName: string): string | undefined {
  const segments = lowerFileName.split('.');
  for (let index = 1; index < segments.length; index += 1) {
    const iconId = FILE_ICON_EXTENSIONS[segments.slice(index).join('.')];
    if (iconId) return iconId;
  }
  return undefined;
}

function findFileIconId(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();
  const byName = FILE_ICON_NAMES[lowerFileName];
  if (byName) return byName;

  return findExtensionIconId(lowerFileName) ?? DEFAULT_FILE_ICON;
}

function folderIconRef(baseIconId: string, isOpen: boolean): FileIconRef {
  const iconId = isOpen ? `${baseIconId}${OPEN_ICON_SUFFIX}` : baseIconId;
  return {
    color: BASE_FOLDER_COLORS[iconId] ?? paletteColor(iconId),
    symbolId: toSymbolId(iconId),
  };
}

export function resolveFileIcon(fileName: string): FileIconRef {
  const iconId = findFileIconId(fileName);
  return {
    color: iconId === DEFAULT_FILE_ICON ? getFileExtColor(fileName) : paletteColor(iconId),
    symbolId: toSymbolId(iconId),
  };
}

export function resolveFolderIcon(folderName: string, isOpen: boolean): FileIconRef {
  return folderIconRef(FOLDER_ICON_NAMES[folderName.toLowerCase()] ?? DEFAULT_FOLDER_ICON, isOpen);
}

export function resolveRootFolderIcon(isOpen: boolean): FileIconRef {
  return folderIconRef(ROOT_FOLDER_ICON, isOpen);
}
