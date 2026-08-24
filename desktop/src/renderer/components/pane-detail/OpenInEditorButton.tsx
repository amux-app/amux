import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Code2 } from 'lucide-react';
import type { EditorDescriptor } from '../../../shared/ipc-types';
import * as systemApi from '../../api/system.api';
import { useInstalledEditors } from '../../hooks/useInstalledEditors';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS } from '../../lib/constants';
import { HoverTooltip } from '../shared/HoverTooltip';
import { useEditorPrefsStore } from '../../stores/editor-prefs.store';
import { useNotificationStore } from '../../stores';

interface OpenInEditorButtonProps {
  /** Absolute path to the file or folder to open. */
  path: string;
  /** File relative to {@link path}, when opening a single file. */
  file?: string;
  /** Optional 1-based line to jump to. */
  line?: number;
  /** Visual size — `sm` matches the diff toolbar; `xs` matches per-file rows; `icon` drops the label for icon-only toolbars. */
  size?: 'icon' | 'xs' | 'sm';
  /** Tooltip override; default mentions whichever editor will run. */
  title?: string;
  /** Optional extra classes on the wrapper. */
  className?: string;
  /** Override the default label prefix ("Open in"). */
  labelPrefix?: string;
}

const CHOOSE_EDITOR_LABEL = 'Choose editor';
const MENU_KEYFRAMES = '@keyframes open-in-editor-menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}';

interface MenuPosition {
  top: number;
  left: number;
  /** Width of the menu — wider than the trigger so longer editor labels fit. */
  width: number;
}

/**
 * Split-button: the main button opens the last-chosen editor; the chevron
 * to its right opens a dropdown of installed editors. Selecting a new editor
 * also remembers it for next time.
 *
 * The editor list comes from `useInstalledEditors`, which probes SYSTEM_LIST_EDITORS at most once
 * per renderer session and shares the result with every other "Open in" surface.
 */
export function OpenInEditorButton({
  path,
  file,
  line,
  size = 'sm',
  title,
  className,
  labelPrefix = 'Open in',
}: OpenInEditorButtonProps) {
  const setLastEditorId = useEditorPrefsStore((s) => s.setLastEditorId);
  const addToast = useNotificationStore((s) => s.addToast);

  const { editors, loaded: editorsLoaded, preferred: activeEditor } = useInstalledEditors();
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const launch = useCallback(async (editor: EditorDescriptor | null) => {
    if (!editor) return;
    try {
      await systemApi.openInEditor(path, file, line, editor.id);
    } catch (err) {
      addToast(`Failed to open editor: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [addToast, path, file, line]);

  // Reposition the menu under the chevron so the dropdown reads as belonging
  // to the chevron half, even when the trigger sits at the right edge of the
  // toolbar.
  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPos(null);
      return;
    }
    const reposition = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = Math.max(rect.width, 220);
      // Right-align the menu under the chevron, but clamp into the viewport.
      const right = rect.right;
      const left = Math.max(8, right - menuWidth);
      setMenuPos({ top: rect.bottom + 4, left, width: menuWidth });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
        chevronRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen]);

  const handleSelect = (editor: EditorDescriptor) => {
    setIsOpen(false);
    setLastEditorId(editor.id);
    void launch(editor);
  };

  const labelText = activeEditor ? `${labelPrefix} ${activeEditor.label}` : `${labelPrefix} editor`;
  const tooltip = title ?? (activeEditor ? `Open in ${activeEditor.label}` : 'Open in editor');

  const isIconOnly = size === 'icon';
  const padding = size === 'xs' ? 'px-2 py-1 text-[10px]' : 'px-2 py-1 text-[11px]';
  const chevronPadding = size === 'sm' ? 'px-1.5 py-1' : 'px-1 py-1';

  return (
    <>
      <style>{MENU_KEYFRAMES}</style>
      <div
        ref={containerRef}
        className={cn(
          'inline-flex items-stretch rounded-md border border-transparent overflow-hidden',
          'hover:border-[var(--border)]',
          isOpen && 'border-[var(--border)]',
          className,
        )}
      >
        <HoverTooltip label={tooltip}>
          <button
            type="button"
            aria-label={isIconOnly ? tooltip : undefined}
            onClick={() => void launch(activeEditor)}
            disabled={!editorsLoaded || !activeEditor}
            className={cn(
              isIconOnly ? HEADER_ICON_BUTTON_CLASS : padding,
              'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isIconOnly ? <Code2 size={12} /> : labelText}
          </button>
        </HoverTooltip>
        <HoverTooltip label={CHOOSE_EDITOR_LABEL} suppressed={isOpen}>
          <button
            ref={chevronRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-label={CHOOSE_EDITOR_LABEL}
            onClick={() => setIsOpen((o) => !o)}
            disabled={!editorsLoaded || editors.length === 0}
            className={cn(
              chevronPadding,
              'flex items-center justify-center border-l border-[var(--border)]/40',
              'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                isOpen && 'rotate-180',
              )}
            />
          </button>
        </HoverTooltip>
      </div>

      {isOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={CHOOSE_EDITOR_LABEL}
          className="fixed z-[80] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] shadow-2xl"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            animation: 'open-in-editor-menu-in 130ms ease forwards',
          }}
        >
          <div className="max-h-[280px] overflow-y-auto py-1">
            {editors.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
                No editors detected.
              </div>
            ) : (
              editors.map((editor) => {
                const isActive = activeEditor?.id === editor.id;
                return (
                  <button
                    key={editor.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => handleSelect(editor)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors',
                      'hover:bg-[var(--tool-item-hover-bg)]',
                      isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                    )}
                  >
                    <span className="w-3 shrink-0 text-center">
                      {isActive && <Check className="h-3 w-3 inline-block" />}
                    </span>
                    <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                      <span className="font-medium truncate">{editor.label}</span>
                      {editor.source !== 'fallback' && (
                        <span className="text-[9px] text-[var(--text-muted)] opacity-70 truncate font-mono">
                          {editor.command.split('/').pop()}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
