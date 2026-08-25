// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { SidebarAgentRow } from '../src/renderer/components/layout/SidebarAgentRow';

const CHAT_NAME = 'Who are you';
const TEST_PANE: MuxBasePane = {
  agent: 'codex',
  agentStatus: 'idle',
  branchName: 'feature/original-branch',
  id: 'pane-1',
  paneId: '%1',
  prompt: 'Who are you?',
  slug: 'who-are-you',
  title: CHAT_NAME,
  type: 'worktree',
  worktreePath: '/worktrees/who-are-you',
};

const SECOND_TEST_PANE: MuxBasePane = {
  ...TEST_PANE,
  id: 'pane-2',
  paneId: '%2',
  slug: 'second-chat',
  title: 'Second chat',
  worktreePath: '/worktrees/second-chat',
};

function renderRow(pane = TEST_PANE) {
  const onDelete = vi.fn();
  const onRename = vi.fn();
  const onSelect = vi.fn();
  return {
    onDelete,
    onRename,
    onSelect,
    ...render(
      <ul>
        <SidebarAgentRow
          hidden={false}
          onDelete={onDelete}
          onRename={onRename}
          onSelect={onSelect}
          pane={pane}
          selected={false}
          status={{ status: 'idle', waiting: false }}
        />
      </ul>,
    ),
  };
}

function openActions(): void {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${CHAT_NAME}` }));
}

describe('SidebarAgentRow actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps row selection and actions as sibling controls', () => {
    const { onSelect } = renderRow();

    const selectButton = screen.getByRole('button', { name: `${CHAT_NAME} · Idle` });
    const actionsButton = screen.getByRole('button', { name: `Actions for ${CHAT_NAME}` });

    expect(selectButton.contains(actionsButton)).toBe(false);
    fireEvent.click(selectButton);
    expect(onSelect).toHaveBeenCalledWith(TEST_PANE.id);
  });

  it('renames the chat inline with trimmed input', async () => {
    const { onRename } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: `Rename ${CHAT_NAME}` });
    expect((input as HTMLInputElement).value).toBe(CHAT_NAME);
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: '  Clearer name  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith(TEST_PANE.id, 'Clearer name');
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `Actions for ${CHAT_NAME}` }),
    );
  });

  it('starts inline rename when the chat entry is double-clicked', async () => {
    const { onRename } = renderRow();

    fireEvent.doubleClick(screen.getByRole('button', { name: `${CHAT_NAME} · Idle` }));

    const input = screen.getByRole('textbox', { name: `Rename ${CHAT_NAME}` });
    expect((input as HTMLInputElement).value).toBe(CHAT_NAME);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(onRename).not.toHaveBeenCalled();
  });

  it('cancels inline rename with Escape and returns focus to the row actions', async () => {
    const { onRename } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: `Rename ${CHAT_NAME}` });
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `${CHAT_NAME} · Idle` })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: `Actions for ${CHAT_NAME}` }),
      );
    });
  });

  it('requires confirmation before deleting a chat and explains code preservation', () => {
    const { onDelete } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByRole('dialog', { name: `Delete “${CHAT_NAME}”?` })).toBeTruthy();
    expect(screen.getByText(/stops the running agent/i)).toBeTruthy();
    expect(screen.getByText(/worktree and branch are kept/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('describes a non-worktree agent as an agent and preserves project files', () => {
    renderRow({
      ...TEST_PANE,
      branchName: undefined,
      type: undefined,
      worktreePath: undefined,
    });
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByText(/stops the running agent/i)).toBeTruthy();
    expect(screen.queryByText(/stops the running terminal/i)).toBeNull();
    expect(screen.getByText(/project files are not deleted/i)).toBeTruthy();
  });

  it('keeps an empty rename open and exposes a validation error', () => {
    const { onRename } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: `Rename ${CHAT_NAME}` });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('maxlength')).toBe('80');
  });

  it('keeps a rename containing control characters open with an inline error', () => {
    const { onRename } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: `Rename ${CHAT_NAME}` });
    fireEvent.change(input, { target: { value: 'Invalid\u0001name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Name cannot contain control characters')).toBeTruthy();
  });

  it('cancels delete without closing the pane', async () => {
    const { onDelete } = renderRow();
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes through the existing safe pane-close lifecycle after confirmation', async () => {
    const { onDelete } = renderRow();
    onDelete.mockResolvedValue(true);
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(TEST_PANE.id);
    });
  });

  it('restores the actions trigger when deletion fails', async () => {
    const { onDelete } = renderRow();
    onDelete.mockResolvedValue(false);
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `Actions for ${CHAT_NAME}` }),
    );
  });

  it('keeps deletion pending and focuses the next chat only after close succeeds', async () => {
    let resolveDelete: ((deleted: boolean) => void) | undefined;
    const deletion = new Promise<boolean>((resolve) => {
      resolveDelete = resolve;
    });
    const onDeleteStarted = vi.fn();

    function DeletingRowsHarness() {
      const [panes, setPanes] = useState([TEST_PANE, SECOND_TEST_PANE]);
      const handleDelete = async (paneId: string): Promise<boolean> => {
        onDeleteStarted(paneId);
        const deleted = await deletion;
        if (deleted) setPanes((current) => current.filter((pane) => pane.id !== paneId));
        return deleted;
      };

      return (
        <ul data-sidebar-agent-list="true" data-testid="sidebar-agent-list">
          {panes.map((pane) => (
            <SidebarAgentRow
              hidden={false}
              key={pane.id}
              onDelete={handleDelete}
              onRename={vi.fn()}
              onSelect={vi.fn()}
              pane={pane}
              selected={false}
              status={{ status: 'idle', waiting: false }}
            />
          ))}
        </ul>
      );
    }

    render(<DeletingRowsHarness />);
    openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(onDeleteStarted).toHaveBeenCalledWith(TEST_PANE.id));
    const dialog = screen.getByRole('dialog', { name: `Delete “${CHAT_NAME}”?` });
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Deleting…' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Deleting…' }));
    expect(screen.getByRole('dialog', { name: `Delete “${CHAT_NAME}”?` })).toBeTruthy();
    expect(onDeleteStarted).toHaveBeenCalledTimes(1);

    resolveDelete?.(true);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `${CHAT_NAME} · Idle` })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Second chat · Idle' }),
      );
    });
  });

  it('has no detectable accessibility violations in the row action flow', async () => {
    renderRow();
    openActions();

    const results = await axe(document.body);
    const serious = (results.violations ?? []).filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious.map((violation) => violation.id)).toEqual([]);
  });
});
