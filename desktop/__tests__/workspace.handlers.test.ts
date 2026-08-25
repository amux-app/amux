import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron dialog APIs so we don't open real native dialogs in tests.
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
}));

// Capture handler registrations.
const secureHandleMock = vi.fn();
vi.mock('../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (...args: unknown[]) => secureHandleMock(...args),
}));

// Avoid loading real services.
vi.mock('../src/main/services/WorkspaceHistoryService.js', () => ({
  WorkspaceHistoryService: {
    getInstance: () => ({
      getAll: () => [],
      touch: () => [],
      remove: () => [],
    }),
  },
}));

vi.mock('../src/main/services/Logger.js', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/utils/formatError.js', () => ({
  formatError: (e: unknown) => String(e),
}));

vi.mock('../src/main/services/ProjectDiscovery.js', () => ({
  discoverProjects: async () => [],
}));

vi.mock('muxbase/core', () => ({
  execAsync: vi.fn(async () => ''),
  getProjectConfigPath: (projectRoot: string) => `${projectRoot}/.muxbase/muxbase.config.json`,
  shQuote: (s: string) => s,
}));

import { dialog } from 'electron';
import { IPC } from '../src/shared/ipc-channels';
import { registerWorkspaceHandlers } from '../src/main/ipc/workspace.handlers';

function getRegisteredHandler(channel: string) {
  const call = secureHandleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`Handler was not registered for channel ${channel}`);
  return call[1] as (...args: any[]) => any;
}

describe('workspace.handlers NEW_PROJECT', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    (dialog.showOpenDialog as any).mockReset?.();
    (dialog.showSaveDialog as any).mockReset?.();
  });

  it('returns canceled when user cancels location picker', async () => {
    (dialog.showOpenDialog as any).mockResolvedValue({ canceled: true, filePaths: [] });

    registerWorkspaceHandlers();
    const handler = getRegisteredHandler(IPC.WORKSPACE_NEW_PROJECT);

    const res = await handler();
    expect(res).toEqual({ canceled: true });
  });

  it('returns selected path when user picks a directory', async () => {
    (dialog.showOpenDialog as any).mockResolvedValue({ canceled: false, filePaths: ['/tmp/myapp'] });

    registerWorkspaceHandlers();
    const handler = getRegisteredHandler(IPC.WORKSPACE_NEW_PROJECT);

    const res = await handler();
    expect(res).toEqual({ canceled: false, path: '/tmp/myapp' });
  });

  it('returns error when dialog throws', async () => {
    (dialog.showOpenDialog as any).mockRejectedValue(new Error('dialog crashed'));

    registerWorkspaceHandlers();
    const handler = getRegisteredHandler(IPC.WORKSPACE_NEW_PROJECT);

    const res = await handler();
    expect(res.canceled).toBe(false);
    expect(res.error).toBeDefined();
  });
});
