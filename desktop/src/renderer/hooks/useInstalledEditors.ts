import { useEffect, useState } from 'react';
import type { EditorDescriptor } from '../../shared/ipc-types';
import { listEditors } from '../api/system.api';
import { useEditorPrefsStore } from '../stores/editor-prefs.store';

const EMPTY_EDITORS: readonly EditorDescriptor[] = Object.freeze([]);

/**
 * Detection shells out to `command -v` once per known editor, so the result is cached for the
 * session rather than re-probed by every surface that offers "Open in". Installing an editor
 * mid-session is rare enough to be worth a restart.
 */
let detection: Promise<readonly EditorDescriptor[]> | null = null;

function detectEditors(): Promise<readonly EditorDescriptor[]> {
  // A failure is not cached: keeping it would leave every later menu claiming no editors exist
  // until the app restarts, where the previous per-mount probe would simply have retried.
  detection ??= listEditors().catch(() => {
    detection = null;
    return EMPTY_EDITORS;
  });
  return detection;
}

export interface InstalledEditors {
  /** The editor a plain "Open in editor" should use: the remembered one, else the first real one. */
  preferred: EditorDescriptor | null;
  editors: readonly EditorDescriptor[];
  loaded: boolean;
}

function resolvePreferred(
  editors: readonly EditorDescriptor[],
  lastEditorId: string | undefined,
): EditorDescriptor | null {
  if (editors.length === 0) return null;
  const remembered = lastEditorId && editors.find((editor) => editor.id === lastEditorId);
  if (remembered) return remembered;
  return editors.find((editor) => editor.source !== 'fallback') ?? editors[0];
}

export function useInstalledEditors(): InstalledEditors {
  const lastEditorId = useEditorPrefsStore((s) => s.lastEditorId);
  const [editors, setEditors] = useState<readonly EditorDescriptor[]>(EMPTY_EDITORS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void detectEditors().then((detected) => {
      if (!active) return;
      setEditors(detected);
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  return { editors, loaded, preferred: resolvePreferred(editors, lastEditorId) };
}
