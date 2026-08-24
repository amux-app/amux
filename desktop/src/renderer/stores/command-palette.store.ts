import { create } from 'zustand';

export type SearchTab = 'all' | 'files' | 'text' | 'panes' | 'messages' | 'commands';

interface CommandPaletteState {
  isOpen: boolean;
  search: string;
  activeTab: SearchTab;
}

interface CommandPaletteActions {
  open: () => void;
  openToTab: (tab: SearchTab) => void;
  close: () => void;
  toggle: () => void;
  setSearch: (search: string) => void;
  setActiveTab: (tab: SearchTab) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState & CommandPaletteActions>(
  (set) => ({
    isOpen: false,
    search: '',
    activeTab: 'all',

    open: () => set({ isOpen: true, search: '' }),

    openToTab: (tab) => set({ isOpen: true, search: '', activeTab: tab }),

    close: () => set({ isOpen: false, search: '' }),

    toggle: () => set((s) => (s.isOpen ? { isOpen: false, search: '' } : { isOpen: true, search: '' })),

    setSearch: (search) => set({ search }),

    setActiveTab: (tab) => set({ activeTab: tab }),
  }),
);
