// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorDescriptor } from '../src/shared/ipc-types';

const systemApi = vi.hoisted(() => ({
  listEditors: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock('../src/renderer/api/system.api', () => systemApi);

function editor(id: string, source: EditorDescriptor['source'] = 'path'): EditorDescriptor {
  return { command: `/usr/local/bin/${id}`, id, label: id.toUpperCase(), source };
}

const DETECTED = ['vscode', 'cursor', 'windsurf', 'zed', 'sublime', 'webstorm'].map((id) => editor(id));

async function importListedEditors() {
  const module = await import('../src/renderer/components/file-browser/file-tree/OpenInEditorSubmenu');
  return module.listedEditors;
}

describe('installed editor detection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    systemApi.listEditors.mockResolvedValue(DETECTED);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('probes the machine once however many menus ask', async () => {
    // Arrange
    const { useInstalledEditors } = await import('../src/renderer/hooks/useInstalledEditors');

    // Act
    const first = renderHook(() => useInstalledEditors());
    const second = renderHook(() => useInstalledEditors());
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    await waitFor(() => expect(second.result.current.loaded).toBe(true));

    // Assert
    expect(systemApi.listEditors).toHaveBeenCalledTimes(1);
    expect(first.result.current.editors).toHaveLength(DETECTED.length);
  });

  it('prefers the remembered editor while it is still installed', async () => {
    // Arrange
    const { useEditorPrefsStore } = await import('../src/renderer/stores/editor-prefs.store');
    const { useInstalledEditors } = await import('../src/renderer/hooks/useInstalledEditors');
    useEditorPrefsStore.getState().setLastEditorId('zed');

    // Act
    const { result } = renderHook(() => useInstalledEditors());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // Assert
    expect(result.current.preferred?.id).toBe('zed');
  });

  it('falls back to the first real editor over the generic system opener', async () => {
    // Arrange
    systemApi.listEditors.mockResolvedValue([editor('system', 'fallback'), editor('cursor')]);
    const { useInstalledEditors } = await import('../src/renderer/hooks/useInstalledEditors');

    // Act
    const { result } = renderHook(() => useInstalledEditors());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // Assert
    expect(result.current.preferred?.id).toBe('cursor');
  });

  it('reports no editors rather than throwing when detection fails', async () => {
    // Arrange
    systemApi.listEditors.mockRejectedValue(new Error('spawn failed'));
    const { useInstalledEditors } = await import('../src/renderer/hooks/useInstalledEditors');

    // Act
    const { result } = renderHook(() => useInstalledEditors());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // Assert
    expect(result.current.editors).toEqual([]);
    expect(result.current.preferred).toBeNull();
  });
});

describe('listedEditors', () => {
  it('shows at most five options', async () => {
    const listedEditors = await importListedEditors();

    expect(listedEditors(DETECTED, 'vscode')).toHaveLength(5);
  });

  it('keeps the remembered editor visible even when it would be truncated away', async () => {
    const listedEditors = await importListedEditors();

    const listed = listedEditors(DETECTED, 'webstorm').map((entry) => entry.id);

    expect(listed[0]).toBe('webstorm');
    expect(listed).not.toContain('sublime');
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('keeps detection order when nothing is remembered yet', async () => {
    const listedEditors = await importListedEditors();

    expect(listedEditors(DETECTED, undefined).map((entry) => entry.id))
      .toEqual(['vscode', 'cursor', 'windsurf', 'zed', 'sublime']);
  });

  it('lists everything when fewer than five editors are installed', async () => {
    const listedEditors = await importListedEditors();

    expect(listedEditors(DETECTED.slice(0, 2), 'cursor').map((entry) => entry.id))
      .toEqual(['cursor', 'vscode']);
  });
});
