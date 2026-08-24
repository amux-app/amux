import type { MessageBoxOptions } from 'electron';

export type UnsavedChangesAction = 'quit' | 'reload' | 'update';

interface GuardedRendererActionOptions {
  confirmDiscard: () => Promise<boolean>;
  perform: () => Promise<boolean | void> | boolean | void;
  requestFlush: () => Promise<boolean>;
}

export type QuitShutdownResult = 'cancelled' | 'complete' | 'force-exit';

interface GuardedApplicationQuitOptions {
  confirmDiscard: () => Promise<boolean>;
  finishQuit: () => void;
  forceExit: () => void;
  requestFlush: () => Promise<boolean>;
  shutdown: () => Promise<QuitShutdownResult>;
  shutdownTimeoutMs: number;
}

interface QuitEnvironment {
  AUMX_E2E?: string;
  NODE_ENV?: string;
}

export function createDiscardUnsavedChangesOptions(
  action: UnsavedChangesAction,
): MessageBoxOptions {
  const actionLabel = action === 'quit'
    ? 'Discard and Quit'
    : action === 'reload'
      ? 'Discard and Reload'
      : 'Discard, Restart, and Update';
  const actionDescription = action === 'quit'
    ? 'Quitting'
    : action === 'reload'
      ? 'Reloading'
      : 'Restarting to update';

  return {
    buttons: ['Cancel', actionLabel],
    cancelId: 0,
    defaultId: 0,
    detail: `${actionDescription} now discards those changes. Cancel to resolve the conflict in the editor first.`,
    message: 'Amux could not save changes to the open file.',
    noLink: true,
    title: 'Unsaved Changes',
    type: 'warning',
  };
}

export async function runGuardedRendererAction({
  confirmDiscard,
  perform,
  requestFlush,
}: GuardedRendererActionOptions): Promise<boolean> {
  if (!await requestFlush() && !await confirmDiscard()) {
    return false;
  }

  return (await perform()) !== false;
}

export function runGuardedApplicationQuit({
  confirmDiscard,
  finishQuit,
  forceExit,
  requestFlush,
  shutdown,
  shutdownTimeoutMs,
}: GuardedApplicationQuitOptions): Promise<boolean> {
  return runGuardedRendererAction({
    confirmDiscard,
    perform: async () => {
      const shutdownResult = await waitForQuitShutdown(shutdown(), shutdownTimeoutMs);
      if (shutdownResult === 'cancelled') return false;
      if (shutdownResult === 'force-exit') {
        forceExit();
        return;
      }
      finishQuit();
    },
    requestFlush,
  });
}

function waitForQuitShutdown(
  operation: Promise<QuitShutdownResult>,
  timeoutMs: number,
): Promise<QuitShutdownResult> {
  if (timeoutMs <= 0) return Promise.resolve('force-exit');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve('force-exit');
    }, timeoutMs);
    timer.unref?.();

    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function shouldBypassQuitDiscardPrompt(
  environment: QuitEnvironment,
  isPackaged: boolean,
): boolean {
  return !isPackaged && environment.NODE_ENV === 'test' && environment.AUMX_E2E === '1';
}

export function runSingleFlight<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  let pending: Promise<Result> | null = null;

  return (...args) => {
    if (pending) {
      return pending;
    }

    let operation: Promise<Result>;
    try {
      operation = action(...args);
    } catch (error) {
      operation = Promise.reject(error);
    }
    const tracked = operation.finally(() => {
      if (pending === tracked) {
        pending = null;
      }
    });
    pending = tracked;
    return tracked;
  };
}
