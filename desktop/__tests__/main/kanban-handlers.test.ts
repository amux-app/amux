import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerKanbanHandlers } from '../../src/main/ipc/kanban.handlers';
import { IPC } from '../../src/shared/ipc-channels';
import type { BacklogItem } from '../../src/shared/kanban-types';

const secureHandleMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  addBacklogItems: vi.fn(),
  addDoneItem: vi.fn(),
  clearDone: vi.fn(),
  getAll: vi.fn(),
  getBacklog: vi.fn(),
  removeBacklogItems: vi.fn(),
  reorderBacklog: vi.fn(),
  updateBacklogItem: vi.fn(),
}));
const authorizeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/KanbanPersistenceService.js', () => ({
  KanbanPersistenceService: { getInstance: () => serviceMock },
}));

vi.mock('../../src/main/services/projectRootAuthorization.js', () => ({
  authorizeProjectRoot: authorizeMock,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => Promise<unknown>;
}

function makeItem(id: string): BacklogItem {
  return {
    complexity: 'S',
    createdAt: 1,
    id,
    order: 0,
    prompt: id,
    title: id,
  };
}

function makeBridge(overrides: Record<string, unknown> = {}) {
  return {
    getPanes: () => [],
    getProjectRoot: () => '/project',
    getWindow: () => null,
    ...overrides,
  };
}

describe('Kanban IPC handlers', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    authorizeMock.mockReset();
    authorizeMock.mockImplementation(async (root: string | undefined) => root || undefined);
    vi.clearAllMocks();
    serviceMock.getBacklog.mockReturnValue([]);
    serviceMock.removeBacklogItems.mockReturnValue([]);
    serviceMock.reorderBacklog.mockReturnValue([]);
    serviceMock.updateBacklogItem.mockReturnValue([]);
  });

  it('updates and reorders through the persistence service after authorization', async () => {
    const updated = [makeItem('one')];
    serviceMock.updateBacklogItem.mockReturnValue(updated);
    serviceMock.reorderBacklog.mockReturnValue(updated);
    registerKanbanHandlers(makeBridge() as never);

    const updateResult = await getHandler(IPC.KANBAN_BACKLOG_UPDATE)(undefined, {
      itemId: 'one',
      projectRoot: '/project',
      updates: { title: 'updated' },
    });
    const reorderResult = await getHandler(IPC.KANBAN_BACKLOG_REORDER)(undefined, {
      orderedIds: ['one'],
      projectRoot: '/project',
    });

    expect(updateResult).toEqual({ backlog: updated, success: true });
    expect(reorderResult).toEqual({ backlog: updated, success: true });
    expect(authorizeMock).toHaveBeenCalledWith('/project', '/project', []);
    expect(serviceMock.updateBacklogItem).toHaveBeenCalledWith('/project', 'one', { title: 'updated' });
    expect(serviceMock.reorderBacklog).toHaveBeenCalledWith('/project', ['one']);
  });

  it('reports partial batch-launch failure while retaining successful launches', async () => {
    const items = [makeItem('one'), makeItem('two')];
    serviceMock.getBacklog.mockReturnValue(items);
    serviceMock.removeBacklogItems.mockReturnValue([]);
    const createPane = vi.fn()
      .mockResolvedValueOnce({ pane: { id: 'pane-one' }, success: true })
      .mockResolvedValueOnce({ error: 'tmux unavailable', success: false });
    registerKanbanHandlers(makeBridge({ createPane }) as never);

    const result = await getHandler(IPC.KANBAN_BATCH_LAUNCH)(undefined, {
      itemIds: ['one', 'two'],
      projectRoot: '/project',
    });

    expect(result).toEqual({
      errors: ['two: tmux unavailable'],
      launched: 1,
      launchedPaneIds: ['pane-one'],
      success: false,
    });
    expect(serviceMock.removeBacklogItems).toHaveBeenCalledWith('/project', ['one']);
    expect(createPane).toHaveBeenCalledTimes(2);
  });

  it('does not mutate state when the requested project root is unauthorized', async () => {
    authorizeMock.mockRejectedValue(new Error('Unauthorized project root'));
    registerKanbanHandlers(makeBridge() as never);

    const result = await getHandler(IPC.KANBAN_BACKLOG_REMOVE)(undefined, {
      itemIds: ['one'],
      projectRoot: '/outside',
    });

    expect(result).toEqual({ error: 'Unauthorized project root', success: false });
    expect(serviceMock.removeBacklogItems).not.toHaveBeenCalled();
  });
});
