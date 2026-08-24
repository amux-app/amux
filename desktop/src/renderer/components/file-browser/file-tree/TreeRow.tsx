import { ChevronRight, Copy } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';
import { HEAVY_IGNORED_DIRS } from '../../../../shared/filePolicy';
import { cn } from '../../../lib/cn';
import { folderColorKey } from '../../../stores/file-browser.store';
import { FileTreeInlineInput } from '../FileTreeInlineInput';
import { FileTypeIcon } from '../FileTypeIcon';
import { useFileTreeContext } from './FileTree';
import { DROP_TARGET_CLASS, ROW_ICON_CLASS, toFileEntry, type FileTreeRowData } from './fileTreeModel';

const INDENT_PX = 16;
const ROW_BASE_PADDING = 8;

function rowPaddingLeft(depth: number): number {
  return depth * INDENT_PX + ROW_BASE_PADDING;
}

export function TreeRow({ row, style }: { row: FileTreeRowData; style: CSSProperties }) {
  const ctx = useFileTreeContext();

  if (row.isPlaceholder) {
    return (
      <div
        role="none"
        style={{ ...style, paddingLeft: rowPaddingLeft(row.depth) }}
        className="flex items-center pr-2"
      >
        <span className="shrink-0 w-3 mr-1" />
        <FileTypeIcon className={ROW_ICON_CLASS} icon={row.icon} />
        <FileTreeInlineInput
          onSubmit={(name) => ctx.onCreate(row.placeholderKind ?? 'file', row.placeholderDir ?? '', name)}
          onCancel={() => ctx.setCreating(null)}
        />
      </div>
    );
  }

  const folderColor = ctx.folderColors[folderColorKey(ctx.rootPath, row.path)];
  const isViewing = ctx.viewingFilePath === row.path;
  const isRenaming = ctx.renamingPath === row.path;
  const dimmed = HEAVY_IGNORED_DIRS.has(row.name);
  const fileEntry = toFileEntry(row);

  const isDropTarget = ctx.dropTargetRowId === row.id;
  const isDragged = ctx.draggedPaths.has(row.path);
  const isSelected = ctx.selectedPaths.has(row.path);

  // Selection already happened on mousedown; a modifier gesture only ever builds a selection, so
  // the click that ends it must not also open a file or collapse a folder.
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;

    if (row.isDirectory) {
      ctx.onToggleDir(row.path);
    } else {
      ctx.onFileClick?.(row.path);
    }
  };

  return (
    <div
      {...ctx.rowDragProps(row)}
      {...ctx.rowPointerProps(row.path)}
      // A draggable ancestor blocks mouse text selection inside the inline rename input.
      draggable={!isRenaming}
      id={ctx.getRowDomId(row.path)}
      role="treeitem"
      aria-current={isViewing ? 'page' : undefined}
      aria-expanded={row.isDirectory ? row.isOpen : undefined}
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      onClick={handleClick}
      onContextMenu={() => {
        ctx.onRowAnchor(row.path);
        ctx.onEntryContextMenu(row);
      }}
      data-drop-target={isDropTarget ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      data-file-kind={row.isDirectory ? 'directory' : 'file'}
      data-file-path={row.path}
      data-testid="file-tree-row"
      style={{ ...style, paddingLeft: rowPaddingLeft(row.depth) }}
      className={cn(
        'group flex cursor-pointer items-center pr-2',
        // Selection gets its own tint rather than `--surface-raised`, which is also the hover
        // colour — sharing it made a multi-selection indistinguishable from the row under the
        // pointer. Written as explicit branches so neither depends on Tailwind variant ordering.
        isSelected
          ? 'bg-(--accent)/16 hover:bg-(--accent)/22'
          : 'hover:bg-(--surface-raised)',
        ctx.activePath === row.path && 'ring-1 ring-inset ring-(--accent)/55',
        dimmed && 'opacity-50',
        !row.isDirectory && isViewing && 'bg-(--accent)/10 text-(--accent)',
        (isDragged || ctx.cutPaths.has(row.path)) && 'opacity-50',
        isDropTarget && DROP_TARGET_CLASS,
      )}
    >
      {row.isDirectory ? (
        <ChevronRight
          size={12}
          className={cn(
            'mr-1 shrink-0 text-(--text-muted) transition-transform duration-150',
            row.isOpen && 'rotate-90',
          )}
        />
      ) : (
        <span className="shrink-0 w-3 mr-1" />
      )}

      <FileTypeIcon
        className={ROW_ICON_CLASS}
        color={row.isDirectory ? folderColor : undefined}
        icon={row.icon}
      />

      {isRenaming ? (
        <FileTreeInlineInput
          defaultValue={row.name}
          onSubmit={(newName) => ctx.onRenameFile(fileEntry, newName)}
          onCancel={() => ctx.setRenamingPath(null)}
        />
      ) : (
        <span
          className={cn(
            'flex-1 min-w-0 truncate',
            row.isDirectory ? 'font-medium text-(--text)' : 'text-(--text-secondary)',
          )}
        >
          {row.name}
        </span>
      )}

      {!isRenaming && (
        <button
          onClick={(e) => { e.stopPropagation(); ctx.onCopyPath(fileEntry); }}
          onFocus={() => ctx.onSetActivePath(row.path)}
          aria-label={`Copy full path for ${row.name}`}
          className="ml-1 shrink-0 rounded p-0.5 text-(--text-muted) opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-(--accent) hover:text-(--accent)"
          title="Copy full path"
        >
          <Copy size={11} />
        </button>
      )}
    </div>
  );
}
