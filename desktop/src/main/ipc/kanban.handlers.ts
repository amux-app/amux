import { randomUUID } from 'node:crypto';
import { IPC, IPC_EVENT } from '../../shared/ipc-channels.js';
import type {
  KanbanGetRequest,
  BacklogAddRequest,
  BacklogRemoveRequest,
  BacklogUpdateRequest,
  BacklogReorderRequest,
  DoneAddRequest,
  DoneClearRequest,
  BatchLaunchRequest,
  BacklogItem,
  DoneItem,
} from '../../shared/kanban-types.js';
import { KanbanPersistenceService } from '../services/KanbanPersistenceService.js';
import { formatError } from '../utils/formatError.js';
import { log } from '../services/Logger.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { secureHandle } from './ipc-security.js';
import { authorizeProjectRoot } from '../services/projectRootAuthorization.js';

function emitKanbanChanged(bridge: MuxBaseBridge): void {
  const win = bridge.getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_EVENT.KANBAN_CHANGED);
  }
}

function pickFallbackLaunchAgent(availableAgents: readonly string[]): string | undefined {
  if (availableAgents.length === 0) return undefined;

  const preferredOrder = ['claude', 'codex', 'opencode', 'pi'];
  for (const agent of preferredOrder) {
    if (availableAgents.includes(agent)) return agent;
  }

  return availableAgents[0];
}

// Prevent duplicate launches for the same backlog item while a launch is already in progress.
const inFlightBacklogLaunches = new Map<string, Set<string>>();

function getInFlightLaunchSet(projectRoot: string): Set<string> {
  let set = inFlightBacklogLaunches.get(projectRoot);
  if (!set) {
    set = new Set<string>();
    inFlightBacklogLaunches.set(projectRoot, set);
  }
  return set;
}

function releaseInFlightLaunch(projectRoot: string, itemId: string): void {
  const set = inFlightBacklogLaunches.get(projectRoot);
  if (!set) return;
  set.delete(itemId);
  if (set.size === 0) {
    inFlightBacklogLaunches.delete(projectRoot);
  }
}

export function registerKanbanHandlers(bridge: MuxBaseBridge): void {
  const service = KanbanPersistenceService.getInstance();
  const authorize = (root: string | undefined): Promise<string | undefined> =>
    authorizeProjectRoot(root, bridge.getProjectRoot(), bridge.getPanes());

  secureHandle(IPC.KANBAN_GET, async (_event, request: KanbanGetRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot);
      const data = service.getAll(projectRoot ?? bridge.getProjectRoot());
      log.debug('ipc:kanban', 'KANBAN_GET', { backlog: data.backlog.length, done: data.done.length });
      return data;
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_GET failed', error);
      return { backlog: [], done: [] };
    }
  });

  secureHandle(IPC.KANBAN_BACKLOG_ADD, async (_event, request: BacklogAddRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      const authorizedItems = await Promise.all(request.items.map(async (item) => ({
        ...item,
        projectRoot: await authorize(item.projectRoot) ?? projectRoot,
      })));
      const existingBacklog = service.getBacklog(projectRoot);
      const maxOrder = existingBacklog.reduce((max, item) => Math.max(max, item.order), -1);

      const newItems: BacklogItem[] = authorizedItems.map((item, i) => ({
        ...item,
        id: randomUUID(),
        createdAt: Date.now(),
        order: maxOrder + 1 + i,
      }));

      const backlog = service.addBacklogItems(projectRoot, newItems);
      log.info('ipc:kanban', 'KANBAN_BACKLOG_ADD', { added: newItems.length, total: backlog.length });
      emitKanbanChanged(bridge);
      return { success: true, items: newItems };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_BACKLOG_ADD failed', error);
      return { success: false, items: [], error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_BACKLOG_REMOVE, async (_event, request: BacklogRemoveRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      const backlog = service.removeBacklogItems(projectRoot, request.itemIds);
      log.info('ipc:kanban', 'KANBAN_BACKLOG_REMOVE', { removed: request.itemIds.length, remaining: backlog.length });
      emitKanbanChanged(bridge);
      return { success: true };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_BACKLOG_REMOVE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_BACKLOG_UPDATE, async (_event, request: BacklogUpdateRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      const updates = request.updates.projectRoot === undefined
        ? request.updates
        : { ...request.updates, projectRoot: await authorize(request.updates.projectRoot) ?? projectRoot };
      const backlog = service.updateBacklogItem(projectRoot, request.itemId, updates);
      log.debug('ipc:kanban', 'KANBAN_BACKLOG_UPDATE', { itemId: request.itemId });
      emitKanbanChanged(bridge);
      return { success: true, backlog };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_BACKLOG_UPDATE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_BACKLOG_REORDER, async (_event, request: BacklogReorderRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      const backlog = service.reorderBacklog(projectRoot, request.orderedIds);
      log.debug('ipc:kanban', 'KANBAN_BACKLOG_REORDER', { count: request.orderedIds.length });
      emitKanbanChanged(bridge);
      return { success: true, backlog };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_BACKLOG_REORDER failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_DONE_ADD, async (_event, request: DoneAddRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      const doneItem: DoneItem = {
        ...request.item,
        id: randomUUID(),
        mergedAt: Date.now(),
      };
      const done = service.addDoneItem(projectRoot, doneItem);
      log.info('ipc:kanban', 'KANBAN_DONE_ADD', { slug: doneItem.slug, total: done.length });
      emitKanbanChanged(bridge);
      return { success: true };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_DONE_ADD failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_DONE_CLEAR, async (_event, request: DoneClearRequest) => {
    try {
      const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
      service.clearDone(projectRoot);
      log.info('ipc:kanban', 'KANBAN_DONE_CLEAR');
      emitKanbanChanged(bridge);
      return { success: true };
    } catch (error) {
      log.error('ipc:kanban', 'KANBAN_DONE_CLEAR failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.KANBAN_BATCH_LAUNCH, async (_event, request: BatchLaunchRequest) => {
    const batchStartedAt = Date.now();
    log.info('ipc:kanban', 'KANBAN_BATCH_LAUNCH', {
      count: request.itemIds.length,
      projectRoot: request.projectRoot,
    });

    const projectRoot = await authorize(request.projectRoot) ?? bridge.getProjectRoot();
    const backlog = service.getBacklog(projectRoot);
    const byId = new Map(backlog.map((item) => [item.id, item]));
    const inFlight = getInFlightLaunchSet(projectRoot);
    const errors: string[] = [];
    const launchedPaneIds: string[] = [];
    let launched = 0;

    for (const itemId of request.itemIds) {
      if (inFlight.has(itemId)) {
        log.debug('ipc:kanban', 'KANBAN_BATCH_LAUNCH skip duplicate in-flight item', { itemId });
        continue;
      }
      inFlight.add(itemId);

      const item = byId.get(itemId);
      const itemLaunchStartedAt = Date.now();
      try {
        if (!item) {
          errors.push(`Item ${itemId} not found`);
          continue;
        }

        const targetProjectRoot = await authorize(item.projectRoot) ?? projectRoot;
        log.info('ipc:kanban', 'KANBAN_BATCH_LAUNCH item start', {
          itemId,
          title: item.title,
          agent: item.agent ?? 'auto',
          targetProjectRoot,
          useWorktree: item.useWorktree,
        });

        let result = await bridge.createPane(item.prompt || item.title, item.agent, {
          projectRoot: targetProjectRoot,
          sendPromptToAgent: true,
          sourceBacklogId: item.id,
          useWorktree: item.useWorktree,
        });

        if (!result.success && result.needsAgentChoice && !item.agent) {
          const availableAgents = result.availableAgents ?? await bridge.getAvailableAgents('kanban');
          const fallbackAgent = pickFallbackLaunchAgent(availableAgents);

          if (fallbackAgent) {
            log.info('ipc:kanban', 'KANBAN_BATCH_LAUNCH retrying with fallback agent', {
              itemId,
              title: item.title,
              fallbackAgent,
              availableAgents,
            });
            result = await bridge.createPane(item.prompt || item.title, fallbackAgent as BacklogItem['agent'], {
              projectRoot: targetProjectRoot,
              sendPromptToAgent: true,
              sourceBacklogId: item.id,
              useWorktree: item.useWorktree,
            });
          } else {
            errors.push(`${item.title}: no agent available to launch task`);
            continue;
          }
        }

        if (result.success) {
          launched++;
          if (result.pane?.id) {
            launchedPaneIds.push(result.pane.id);
          }
          service.removeBacklogItems(projectRoot, [itemId]);
          log.info('ipc:kanban', 'KANBAN_BATCH_LAUNCH item complete', {
            itemId,
            paneId: result.pane?.id,
            durationMs: Date.now() - itemLaunchStartedAt,
          });
        } else {
          const message = `${item.title}: ${result.error ?? 'creation failed'}`;
          errors.push(message);
          log.warn('ipc:kanban', 'KANBAN_BATCH_LAUNCH item failed', {
            itemId,
            title: item.title,
            error: result.error ?? 'creation failed',
            durationMs: Date.now() - itemLaunchStartedAt,
          });
        }
      } catch (error) {
        const message = `${item?.title ?? itemId}: ${formatError(error)}`;
        errors.push(message);
        log.error('ipc:kanban', 'KANBAN_BATCH_LAUNCH item exception', {
          itemId,
          title: item?.title,
          error: formatError(error),
          durationMs: Date.now() - itemLaunchStartedAt,
        });
      } finally {
        releaseInFlightLaunch(projectRoot, itemId);
      }
    }

    emitKanbanChanged(bridge);
    log.info('ipc:kanban', 'KANBAN_BATCH_LAUNCH complete', {
      launched,
      errors: errors.length,
      durationMs: Date.now() - batchStartedAt,
    });
    return { success: errors.length === 0, launched, errors, launchedPaneIds };
  });
}
