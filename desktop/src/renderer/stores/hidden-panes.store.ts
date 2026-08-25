import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * Per-user list of pane IDs the user minimised from fleet view. Persisted so
 * that hidden panes stay hidden across launches; the dot-menu / sidebar can
 * re-show them at any time.
 *
 * Pane IDs are timestamp-derived and globally unique, so a single flat Set
 * is correct even across projects — IDs from one project simply won't match
 * panes in another.
 *
 * `Set` doesn't survive JSON, so we serialise as `string[]` via partialize
 * and rehydrate back into a `Set` in onRehydrateStorage.
 */
interface HiddenPanesState {
  hiddenPaneIds: Set<string>;
  hidePane: (paneId: string) => void;
  unhidePane: (paneId: string) => void;
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

export const useHiddenPanesStore = create<HiddenPanesState>()(
  persist(
    (set) => ({
      hiddenPaneIds: new Set<string>(),

      hidePane: (paneId) =>
        set((s) => {
          if (s.hiddenPaneIds.has(paneId)) return s;
          const next = new Set(s.hiddenPaneIds);
          next.add(paneId);
          return { hiddenPaneIds: next };
        }),

      unhidePane: (paneId) =>
        set((s) => {
          if (!s.hiddenPaneIds.has(paneId)) return s;
          const next = new Set(s.hiddenPaneIds);
          next.delete(paneId);
          return { hiddenPaneIds: next };
        }),
    }),
    {
      name: 'muxbase-hidden-panes',
      version: 1,
      storage: createJSONStorage(() => getStorage()),
      // Serialise the Set as an array so JSON.stringify produces something useful.
      partialize: (state) => ({ hiddenPaneIds: [...state.hiddenPaneIds] as unknown }),
      // ...and rehydrate the array back into a Set.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const raw = state.hiddenPaneIds as unknown;
        if (Array.isArray(raw)) {
          state.hiddenPaneIds = new Set(raw as string[]);
        } else if (!(raw instanceof Set)) {
          state.hiddenPaneIds = new Set();
        }
      },
    },
  ),
);
