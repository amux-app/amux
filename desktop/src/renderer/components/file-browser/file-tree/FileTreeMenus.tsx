import * as ContextMenu from '@radix-ui/react-context-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { parentDir } from '../../../../shared/filePolicy';
import type { FileEntry } from '../../../../shared/ipc-types';
import { cn } from '../../../lib/cn';
import { folderColorKey, useFileBrowserStore } from '../../../stores/file-browser.store';
import { OpenInEditorSubmenu } from './OpenInEditorSubmenu';
import {
  MENU_ITEM_CLASS,
  MENU_SEPARATOR_CLASS,
  toFileEntry,
  type FileTreeRowData,
} from './fileTreeModel';

const FOLDER_COLOR_PALETTE = [
  { name: 'Blue', hex: '#60a5fa' },
  { name: 'Green', hex: '#34d399' },
  { name: 'Amber', hex: '#fbbf24' },
  { name: 'Violet', hex: '#a78bfa' },
  { name: 'Rose', hex: '#fb7185' },
] as const;

export type FileTreeContextMenuTarget =
  | { kind: 'entry'; entry: FileTreeRowData }
  | { kind: 'root' };

export interface FileTreeContextMenuProps {
  canPaste: boolean;
  canUndo: boolean;
  folderColors: Record<string, string>;
  onCopy: (path: string) => void;
  onCopyPath: (entry: FileEntry) => void;
  onCopyRootPath: () => void;
  onCreate: (dir: string, type: 'file' | 'folder') => void;
  onCut: (path: string) => void;
  onDelete: (path: string) => void;
  onDuplicate: (path: string) => void;
  onPaste: (destDir: string) => void;
  onRename: (path: string) => void;
  onUndo: () => void;
  preventAutoFocus: boolean;
  rootPath: string;
  target: FileTreeContextMenuTarget;
  targetCount: number;
}

interface RootContextMenuProps {
  canPaste: boolean;
  canUndo: boolean;
  onCopyRootPath: () => void;
  onCreate: (dir: string, type: 'file' | 'folder') => void;
  onPaste: (destDir: string) => void;
  onUndo: () => void;
}

interface EntryContextMenuProps {
  canPaste: boolean;
  entry: FileTreeRowData;
  folderColor: string | undefined;
  onCopy: (path: string) => void;
  onCopyPath: (entry: FileEntry) => void;
  onCreate: (dir: string, type: 'file' | 'folder') => void;
  onCut: (path: string) => void;
  onDelete: (path: string) => void;
  onDuplicate: (path: string) => void;
  onPaste: (destDir: string) => void;
  onRename: (path: string) => void;
  rootPath: string;
  targetCount: number;
}

export function FileTreeContextMenu({
  canPaste,
  canUndo,
  folderColors,
  preventAutoFocus,
  rootPath,
  target,
  targetCount,
  ...handlers
}: FileTreeContextMenuProps) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className="z-50 min-w-40 rounded-lg border border-(--border) bg-(--surface-raised) py-1 shadow-xl"
        onCloseAutoFocus={(event) => {
          if (preventAutoFocus) event.preventDefault();
        }}
      >
        {target.kind === 'root' ? (
          <RootContextMenuContent
            canPaste={canPaste}
            canUndo={canUndo}
            onCopyRootPath={handlers.onCopyRootPath}
            onCreate={handlers.onCreate}
            onPaste={handlers.onPaste}
            onUndo={handlers.onUndo}
          />
        ) : (
          <EntryContextMenuContent
            {...handlers}
            canPaste={canPaste}
            entry={target.entry}
            folderColor={folderColors[folderColorKey(rootPath, target.entry.path)]}
            rootPath={rootPath}
            targetCount={targetCount}
          />
        )}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function RootContextMenuContent({
  canPaste,
  canUndo,
  onCopyRootPath,
  onCreate,
  onPaste,
  onUndo,
}: RootContextMenuProps) {
  return (
    <>
      <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onCreate('', 'file')}>
        New File
      </ContextMenu.Item>
      <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onCreate('', 'folder')}>
        New Folder
      </ContextMenu.Item>
      {canPaste && (
        <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onPaste('')}>
          Paste
        </ContextMenu.Item>
      )}
      <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={onCopyRootPath}>
        Copy Root Path
      </ContextMenu.Item>
      {canUndo && (
        <>
          <ContextMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <MenuItem onSelect={onUndo} shortcut="⌘Z">Undo Move</MenuItem>
        </>
      )}
    </>
  );
}

function MenuItem({
  children,
  className,
  onSelect,
  shortcut,
}: {
  children: ReactNode;
  className?: string;
  onSelect: () => void;
  shortcut?: string;
}) {
  return (
    <ContextMenu.Item className={cn(MENU_ITEM_CLASS, className)} onSelect={onSelect}>
      {children}
      {shortcut && <span className="ml-auto pl-6 text-(--text-muted)">{shortcut}</span>}
    </ContextMenu.Item>
  );
}

function EntryContextMenuContent({
  canPaste,
  entry,
  folderColor,
  onCopy,
  onCopyPath,
  onCreate,
  onCut,
  onDelete,
  onDuplicate,
  onPaste,
  onRename,
  rootPath,
  targetCount,
}: EntryContextMenuProps) {
  const fileEntry = toFileEntry(entry);
  const contextTargetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
  const suffix = targetCount > 1 ? ` ${targetCount} Items` : '';

  return (
    <>
      <MenuItem onSelect={() => onCreate(contextTargetDir, 'file')}>New File</MenuItem>
      <MenuItem onSelect={() => onCreate(contextTargetDir, 'folder')}>New Folder</MenuItem>
      {targetCount === 1 && (
        <MenuItem onSelect={() => onRename(entry.path)} shortcut="F2">Rename</MenuItem>
      )}
      <MenuItem onSelect={() => onCopy(entry.path)} shortcut="⌘C">{`Copy${suffix}`}</MenuItem>
      <MenuItem onSelect={() => onCut(entry.path)} shortcut="⌘X">{`Cut${suffix}`}</MenuItem>
      {canPaste && (
        <MenuItem onSelect={() => onPaste(contextTargetDir)} shortcut="⌘V">Paste</MenuItem>
      )}
      <MenuItem onSelect={() => onDuplicate(entry.path)} shortcut="⌘D">Duplicate</MenuItem>
      <OpenInEditorSubmenu relativePath={entry.path} rootPath={rootPath} />
      <MenuItem
        className="data-highlighted:text-(--error)"
        onSelect={() => onDelete(entry.path)}
        shortcut="⌘⌫"
      >
        {`Delete${suffix}`}
      </MenuItem>
      <ContextMenu.Separator className={MENU_SEPARATOR_CLASS} />
      {entry.isDirectory && (
        <FolderColorSubmenu rootPath={rootPath} path={entry.path} currentColor={folderColor} />
      )}
      <ContextMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onCopyPath(fileEntry)}>
        Copy Full Path
      </ContextMenu.Item>
    </>
  );
}

function FolderColorSubmenu({
  currentColor,
  path,
  rootPath,
}: {
  currentColor: string | undefined;
  path: string;
  rootPath: string;
}) {
  const { setFolderColor, clearFolderColor } = useFileBrowserStore.getState();

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cn(MENU_ITEM_CLASS, 'justify-between')}>
        Color
        <ChevronRight size={12} className="ml-2 text-(--text-muted)" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className="z-50 min-w-32.5 rounded-lg border border-(--border) bg-(--surface-raised) py-1 shadow-xl"
          sideOffset={4}
        >
          {FOLDER_COLOR_PALETTE.map((swatch) => (
            <ContextMenu.Item
              key={swatch.hex}
              className={MENU_ITEM_CLASS}
              onSelect={() => setFolderColor(rootPath, path, swatch.hex)}
            >
              <span
                className="shrink-0 mr-2 rounded-full"
                style={{ width: 10, height: 10, backgroundColor: swatch.hex }}
              />
              {swatch.name}
              {currentColor === swatch.hex && (
                <Check size={12} className="ml-auto text-(--text)" />
              )}
            </ContextMenu.Item>
          ))}
          {currentColor && (
            <>
              <ContextMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <ContextMenu.Item
                className={MENU_ITEM_CLASS}
                onSelect={() => clearFolderColor(rootPath, path)}
              >
                Reset
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
