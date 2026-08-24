import * as ContextMenu from '@radix-ui/react-context-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { EditorDescriptor } from '../../../../shared/ipc-types';
import { openInEditor } from '../../../api/system.api';
import { useInstalledEditors } from '../../../hooks/useInstalledEditors';
import { cn } from '../../../lib/cn';
import { useNotificationStore } from '../../../stores';
import { useEditorPrefsStore } from '../../../stores/editor-prefs.store';
import { MENU_ITEM_CLASS } from './fileTreeModel';

const MAX_LISTED_EDITORS = 5;

export interface OpenInEditorSubmenuProps {
  relativePath: string;
  rootPath: string;
}

/**
 * Keeps the remembered editor visible even when detection finds more than the menu shows, so the
 * one entry the user actually reaches for can never be the one that got truncated.
 */
export function listedEditors(
  editors: readonly EditorDescriptor[],
  preferredId: string | undefined,
): EditorDescriptor[] {
  const preferred = editors.filter((editor) => editor.id === preferredId);
  const rest = editors.filter((editor) => editor.id !== preferredId);
  return [...preferred, ...rest].slice(0, MAX_LISTED_EDITORS);
}

export function OpenInEditorSubmenu({ relativePath, rootPath }: OpenInEditorSubmenuProps) {
  const { editors, loaded, preferred } = useInstalledEditors();
  const setLastEditorId = useEditorPrefsStore((s) => s.setLastEditorId);
  const addToast = useNotificationStore((s) => s.addToast);

  const open = (editor: EditorDescriptor): void => {
    setLastEditorId(editor.id);
    // `openInEditor` takes the authorized root first; an absolute file path there is rejected.
    void openInEditor(rootPath, relativePath, undefined, editor.id).catch((error: unknown) => {
      addToast(error instanceof Error ? error.message : 'Failed to open editor', 'error');
    });
  };

  const options = listedEditors(editors, preferred?.id);

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cn(MENU_ITEM_CLASS, 'justify-between')}>
        Open in
        <ChevronRight size={12} className="ml-2 text-(--text-muted)" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className="z-50 min-w-44 rounded-lg border border-(--border) bg-(--surface-raised) py-1 shadow-xl"
          sideOffset={4}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-(--text-muted)">
              {loaded ? 'No editors detected' : 'Detecting editors…'}
            </div>
          ) : (
            options.map((editor) => (
              <ContextMenu.Item
                key={editor.id}
                className={MENU_ITEM_CLASS}
                onSelect={() => open(editor)}
              >
                <span className="mr-2 w-3 shrink-0 text-center">
                  {editor.id === preferred?.id && <Check size={12} className="inline-block" />}
                </span>
                {editor.label}
              </ContextMenu.Item>
            ))
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
