import Store from 'electron-store';
import type { BacklogItem, DoneItem, KanbanData } from '../../shared/kanban-types.js';

interface KanbanSchema {
  projects: Record<string, KanbanData>;
}

const MAX_DONE_ITEMS = 50;

const DEFAULTS: KanbanSchema = {
  projects: {},
};

export class KanbanPersistenceService {
  private static instance: KanbanPersistenceService;
  private store: Store<KanbanSchema>;

  private constructor() {
    this.store = new Store<KanbanSchema>({
      name: 'kanban-data',
      defaults: DEFAULTS,
    });
  }

  static getInstance(): KanbanPersistenceService {
    if (!KanbanPersistenceService.instance) {
      KanbanPersistenceService.instance = new KanbanPersistenceService();
    }
    return KanbanPersistenceService.instance;
  }

  private getProjectData(projectRoot: string): KanbanData {
    const projects = this.store.get('projects', {});
    return projects[projectRoot] ?? { backlog: [], done: [] };
  }

  private setProjectData(projectRoot: string, data: KanbanData): void {
    const projects = this.store.get('projects', {});
    projects[projectRoot] = data;
    this.store.set('projects', projects);
  }

  getBacklog(projectRoot: string): BacklogItem[] {
    return this.getProjectData(projectRoot).backlog;
  }

  getDone(projectRoot: string): DoneItem[] {
    return this.getProjectData(projectRoot).done;
  }

  getAll(projectRoot: string): KanbanData {
    return this.getProjectData(projectRoot);
  }

  addBacklogItems(projectRoot: string, items: BacklogItem[]): BacklogItem[] {
    const data = this.getProjectData(projectRoot);
    data.backlog.push(...items);
    this.setProjectData(projectRoot, data);
    return data.backlog;
  }

  removeBacklogItems(projectRoot: string, itemIds: string[]): BacklogItem[] {
    const data = this.getProjectData(projectRoot);
    const idsSet = new Set(itemIds);
    data.backlog = data.backlog.filter((item) => !idsSet.has(item.id));
    this.setProjectData(projectRoot, data);
    return data.backlog;
  }

  updateBacklogItem(
    projectRoot: string,
    itemId: string,
    updates: Partial<Pick<BacklogItem, 'title' | 'prompt' | 'complexity' | 'agent' | 'useWorktree' | 'projectRoot' | 'order'>>,
  ): BacklogItem[] {
    const data = this.getProjectData(projectRoot);
    const idx = data.backlog.findIndex((item) => item.id === itemId);
    if (idx >= 0) {
      data.backlog[idx] = { ...data.backlog[idx], ...updates };
      this.setProjectData(projectRoot, data);
    }
    return data.backlog;
  }

  reorderBacklog(projectRoot: string, orderedIds: string[]): BacklogItem[] {
    const data = this.getProjectData(projectRoot);
    const byId = new Map(data.backlog.map((item) => [item.id, item]));
    const reordered: BacklogItem[] = [];
    for (const orderedId of orderedIds) {
      const item = byId.get(orderedId);
      if (item) {
        reordered.push({ ...item, order: reordered.length });
        byId.delete(orderedId);
      }
    }
    for (const remaining of byId.values()) {
      reordered.push({ ...remaining, order: reordered.length });
    }
    data.backlog = reordered;
    this.setProjectData(projectRoot, data);
    return data.backlog;
  }

  addDoneItem(projectRoot: string, item: DoneItem): DoneItem[] {
    const data = this.getProjectData(projectRoot);
    data.done.unshift(item);
    if (data.done.length > MAX_DONE_ITEMS) {
      data.done = data.done.slice(0, MAX_DONE_ITEMS);
    }
    this.setProjectData(projectRoot, data);
    return data.done;
  }

  clearDone(projectRoot: string): void {
    const data = this.getProjectData(projectRoot);
    data.done = [];
    this.setProjectData(projectRoot, data);
  }
}
