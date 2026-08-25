import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * Persists the last-chosen editor id from the "Open in editor" split-button
 * (Diff view and elsewhere). Stored separately from `task-defaults` so
 * future additions to either store don't require coordinated migrations.
 */
interface EditorPrefsState {
  lastEditorId: string | undefined;
  setLastEditorId: (id: string | undefined) => void;
}

const inMemoryStorage = new Map<string, string>();

function getStorage(): StateStorage {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem: (name) => inMemoryStorage.get(name) ?? null,
    setItem: (name, value) => {
      inMemoryStorage.set(name, value);
    },
    removeItem: (name) => {
      inMemoryStorage.delete(name);
    },
  };
}

export const useEditorPrefsStore = create<EditorPrefsState>()(
  persist(
    (set) => ({
      lastEditorId: undefined,
      setLastEditorId: (id) => set({ lastEditorId: id }),
    }),
    {
      name: 'muxbase-editor-prefs',
      partialize: (state) => ({ lastEditorId: state.lastEditorId }),
      storage: createJSONStorage(() => getStorage()),
      version: 1,
    },
  ),
);
