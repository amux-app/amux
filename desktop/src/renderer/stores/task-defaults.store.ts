import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

interface TaskDefaultsState {
  lastTaskProjectRoot: string | undefined;
  setLastTaskProjectRoot: (projectRoot: string | undefined) => void;
}

const inMemoryTaskDefaultsStorage = new Map<string, string>();

function getTaskDefaultsStorage(): StateStorage {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem: (name) => inMemoryTaskDefaultsStorage.get(name) ?? null,
    setItem: (name, value) => {
      inMemoryTaskDefaultsStorage.set(name, value);
    },
    removeItem: (name) => {
      inMemoryTaskDefaultsStorage.delete(name);
    },
  };
}

export const useTaskDefaultsStore = create<TaskDefaultsState>()(
  persist(
    (set) => ({
      lastTaskProjectRoot: undefined,
      setLastTaskProjectRoot: (projectRoot) => set({ lastTaskProjectRoot: projectRoot }),
    }),
    {
      name: 'muxbase-task-defaults',
      partialize: (state) => ({ lastTaskProjectRoot: state.lastTaskProjectRoot }),
      storage: createJSONStorage(() => getTaskDefaultsStorage()),
      version: 1,
    },
  ),
);
