import Store from 'electron-store';

export interface WorkspaceHistoryEntry {
  name: string;
  root: string;
  lastOpened: number;
  paneCount: number;
}

interface WorkspaceHistorySchema {
  entries: WorkspaceHistoryEntry[];
}

const MAX_ENTRIES = 20;

const DEFAULTS: WorkspaceHistorySchema = {
  entries: [],
};

export class WorkspaceHistoryService {
  private static instance: WorkspaceHistoryService;
  private store: Store<WorkspaceHistorySchema>;

  private constructor() {
    this.store = new Store<WorkspaceHistorySchema>({
      name: 'workspace-history',
      defaults: DEFAULTS,
    });
  }

  static getInstance(): WorkspaceHistoryService {
    if (!WorkspaceHistoryService.instance) {
      WorkspaceHistoryService.instance = new WorkspaceHistoryService();
    }
    return WorkspaceHistoryService.instance;
  }

  getAll(): WorkspaceHistoryEntry[] {
    return this.store.get('entries', []);
  }

  touch(entry: Pick<WorkspaceHistoryEntry, 'name' | 'root' | 'paneCount'>): WorkspaceHistoryEntry[] {
    const entries = this.getAll().filter((e) => e.root !== entry.root);
    entries.unshift({
      name: entry.name,
      root: entry.root,
      lastOpened: Date.now(),
      paneCount: entry.paneCount,
    });
    const capped = entries.slice(0, MAX_ENTRIES);
    this.store.set('entries', capped);
    return capped;
  }

  remove(root: string): WorkspaceHistoryEntry[] {
    const entries = this.getAll().filter((e) => e.root !== root);
    this.store.set('entries', entries);
    return entries;
  }
}
