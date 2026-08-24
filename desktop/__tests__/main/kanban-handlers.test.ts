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

  it('covers CRUD result shapes and emits only after persistence succeeds', async () => {
    const item = makeItem('new');
    serviceMock.getAll.mockReturnValue({ backlog: [item], done: [] });
    serviceMock.getBacklog.mockReturnValue([makeItem('old')]);
    serviceMock.addBacklogItems.mockImplementation((_root: string, items: BacklogItem[]) => items);
    serviceMock.addDoneItem.mockReturnValue([item]);
    registerKanbanHandlers(makeBridge() as never);

    await expect(getHandler(IPC.KANBAN_GET)(undefined, { projectRoot: '/project' })).resolves.toEqual({
      backlog: [item],
      done: [],
    });
    const add = await getHandler(IPC.KANBAN_BACKLOG_ADD)(undefined, {
      items: [{ prompt: 'prompt', title: 'new', projectRoot: '/project' }],
      projectRoot: '/project',
    });
    expect(add).toMatchObject({
      success: true,
      items: [{ order: 1, title: 'new' }],
    });
    await expect(
      getHandler(IPC.KANBAN_BACKLOG_REMOVE)(undefined, {
        itemIds: ['new'],
        projectRoot: '/project',
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      getHandler(IPC.KANBAN_DONE_ADD)(undefined, {
        item,
        projectRoot: '/project',
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(getHandler(IPC.KANBAN_DONE_CLEAR)(undefined, { projectRoot: '/project' })).resolves.toEqual({
      success: true,
    });
    expect(serviceMock.clearDone).toHaveBeenCalledWith('/project');
  });

  it('uses an available fallback agent when an automatic launch needs a choice', async () => {
    const item = makeItem('auto');
    serviceMock.getBacklog.mockReturnValue([item]);
    const createPane = vi
      .fn()
      .mockResolvedValueOnce({
        availableAgents: ['codex'],
        needsAgentChoice: true,
        success: false,
      })
      .mockResolvedValueOnce({ pane: { id: 'pane-auto' }, success: true });
    registerKanbanHandlers(
      makeBridge({
        createPane,
        getAvailableAgents: vi.fn().mockResolvedValue(['codex']),
      }) as never,
    );

    await expect(
      getHandler(IPC.KANBAN_BATCH_LAUNCH)(undefined, {
        itemIds: ['auto'],
        projectRoot: '/project',
      }),
    ).resolves.toEqual({
      errors: [],
      launched: 1,
      launchedPaneIds: ['pane-auto'],
      success: true,
    });
    expect(createPane).toHaveBeenNthCalledWith(
      2,
      'auto',
      'codex',
      expect.objectContaining({ sourceBacklogId: 'auto' }),
    );
  });

  it('reports no-agent and thrown-launch failures without losing other batch items', async () => {
    const items = [makeItem('missing-agent'), makeItem('throws')];
    serviceMock.getBacklog.mockReturnValue(items);
    const createPane = vi
      .fn()
      .mockResolvedValueOnce({ needsAgentChoice: true, success: false })
      .mockRejectedValueOnce(new Error('launch exploded'));
    registerKanbanHandlers(
      makeBridge({
        createPane,
        getAvailableAgents: vi.fn().mockResolvedValue([]),
      }) as never,
    );

    await expect(
      getHandler(IPC.KANBAN_BATCH_LAUNCH)(undefined, {
        itemIds: ['missing-agent', 'throws', 'unknown'],
        projectRoot: '/project',
      }),
    ).resolves.toEqual({
      errors: ['missing-agent: no agent available to launch task', 'throws: launch exploded', 'Item unknown not found'],
      launched: 0,
      launchedPaneIds: [],
      success: false,
    });
  });

  it('suppresses duplicate concurrent launches for the same backlog item', async () => {
    const item = makeItem('duplicate');
    serviceMock.getBacklog.mockReturnValue([item]);
    let release!: (value: { pane: { id: string }; success: true }) => void;
    const createPane = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    registerKanbanHandlers(makeBridge({ createPane }) as never);

    const first = getHandler(IPC.KANBAN_BATCH_LAUNCH)(undefined, {
      itemIds: ['duplicate'],
      projectRoot: '/project',
    });
    await vi.waitFor(() => expect(createPane).toHaveBeenCalledOnce());
    const second = getHandler(IPC.KANBAN_BATCH_LAUNCH)(undefined, {
      itemIds: ['duplicate'],
      projectRoot: '/project',
    });
    await vi.waitFor(() => expect(createPane).toHaveBeenCalledOnce());
    release({ pane: { id: 'pane-duplicate' }, success: true });

    await expect(first).resolves.toMatchObject({ launched: 1, success: true });
    await expect(second).resolves.toEqual({
      errors: [],
      launched: 0,
      launchedPaneIds: [],
      success: true,
    });
  });
});
