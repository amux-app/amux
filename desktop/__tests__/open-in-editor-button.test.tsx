// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenInEditorButton } from '../src/renderer/components/pane-detail/OpenInEditorButton';
import { useEditorPrefsStore } from '../src/renderer/stores/editor-prefs.store';

const listEditorsMock = vi.fn();
const openInEditorMock = vi.fn();
const addToastMock = vi.fn();

vi.mock('../src/renderer/api/system.api', () => ({
  listEditors: () => listEditorsMock(),
  openInEditor: (...args: unknown[]) => openInEditorMock(...args),
}));

vi.mock('../src/renderer/stores', () => ({
  useNotificationStore: (selector: (state: { addToast: typeof addToastMock }) => unknown) =>
    selector({ addToast: addToastMock }),
}));

describe('OpenInEditorButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorPrefsStore.setState({ lastEditorId: undefined });
    listEditorsMock.mockResolvedValue([
      { id: 'vscode', label: 'VS Code', command: '/usr/local/bin/code', source: 'path' },
      { id: 'cursor', label: 'Cursor', command: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', source: 'app' },
      { id: 'system', label: 'System default', command: 'code', source: 'fallback' },
    ]);
    openInEditorMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the first detected editor when nothing is remembered', async () => {
    render(<OpenInEditorButton path="/tmp/repo" />);

    // Wait for the editor list to load and the label to update.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open in vs code/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /open in vs code/i }));

    await waitFor(() => {
      expect(openInEditorMock).toHaveBeenCalledWith(
        '/tmp/repo',
        undefined,
        undefined,
        'vscode',
      );
    });
  });

  it('opens the dropdown via the chevron and switches the active editor', async () => {
    render(<OpenInEditorButton path="/tmp/repo" />);

    // Wait for editors to load (chevron is disabled until then).
    await waitFor(() => {
      const chevron = screen.getByRole('button', { name: /choose editor/i }) as HTMLButtonElement;
      expect(chevron.disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: /choose editor/i }));
    const cursorOption = await screen.findByRole('option', { name: /cursor/i });
    fireEvent.click(cursorOption);

    // Picking an option both remembers it and launches.
    await waitFor(() => {
      expect(useEditorPrefsStore.getState().lastEditorId).toBe('cursor');
    });
    expect(openInEditorMock).toHaveBeenCalledWith(
      '/tmp/repo',
      undefined,
      undefined,
      'cursor',
    );

    // Trigger label now reflects the new choice.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open in cursor/i })).toBeTruthy();
    });
  });

  it('shows a hint when no editors were detected', async () => {
    listEditorsMock.mockResolvedValueOnce([]);

    render(<OpenInEditorButton path="/tmp/repo" />);

    // The trigger button stays disabled because no editor resolved.
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: /open in editor/i }) as HTMLButtonElement;
      expect(trigger.disabled).toBe(true);
    });
  });
});
