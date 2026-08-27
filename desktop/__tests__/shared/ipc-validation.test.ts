import { describe, expect, it } from 'vitest';
import { IPC, IPC_EVENT } from '../../src/shared/ipc-channels';
import { validateIpcInvokeArgs } from '../../src/main/ipc/ipc-request-validation';
import { isIpcEventChannel, isIpcInvokeChannel } from '../../src/shared/ipc-validation';
import type { TerminalStreamModeChangedEvent } from '../../src/shared/ipc-types';

describe('ipc channel validation', () => {
  it('allows every declared invoke channel', () => {
    for (const channel of Object.values(IPC)) {
      expect(isIpcInvokeChannel(channel)).toBe(true);
    }
  });

  it('allows every declared event channel', () => {
    for (const channel of Object.values(IPC_EVENT)) {
      expect(isIpcEventChannel(channel)).toBe(true);
    }
  });

  it('rejects unknown or cross-purpose channels', () => {
    expect(isIpcInvokeChannel('pane:unknown')).toBe(false);
    expect(isIpcInvokeChannel(IPC_EVENT.TOAST)).toBe(false);
    expect(isIpcEventChannel('event:unknown')).toBe(false);
    expect(isIpcEventChannel(IPC.PANE_LIST)).toBe(false);
  });
});

describe('ipc request validation', () => {
  it('validates every invoke channel before handlers receive payloads', () => {
    const missingSchemas = Object.values(IPC).filter((channel) => {
      try {
        validateIpcInvokeArgs(channel, []);
        return false;
      } catch (error) {
        return String(error).includes('No IPC request schema');
      }
    });

    expect(missingSchemas).toEqual([]);
  });

  it('rejects malformed pane create payloads before handler code can read properties', () => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_CREATE, [{}])).toThrow(/Invalid IPC payload/);
    expect(() => validateIpcInvokeArgs(IPC.PANE_CREATE, [{ prompt: '', type: 'shell' }])).not.toThrow();
  });

  it.each([IPC.MARKETPLACE_PREVIEW, IPC.MARKETPLACE_INSTALL])(
    'enforces the explicit marketplace intent contract for %s',
    (channel) => {
      const installFields = channel === IPC.MARKETPLACE_INSTALL ? { previewDigest: 'digest-1' } : {};
      const identity = { pluginId: 'plugin', sourceUrl: 'https://example.test/source.git' };

      const validRequests = [
        {
          ...identity,
          ...installFields,
          mode: 'selected',
          selectedAgents: [],
          selectedMcpServers: [],
          selectedSkills: ['skill'],
        },
        {
          ...identity,
          ...installFields,
          mode: 'selected',
          selectedAgents: [],
          selectedMcpServers: [],
          selectedSkills: [],
        },
        {
          ...identity,
          ...installFields,
          mode: 'full',
        },
      ];
      for (const request of validRequests) {
        expect(() => validateIpcInvokeArgs(channel, [request])).not.toThrow();
      }

      const invalidRequests = [
        {
          ...identity,
          ...installFields,
          mode: 'selected',
          selectedAgents: [],
          selectedSkills: [],
        },
        {
          ...identity,
          ...installFields,
          mode: 'full',
          selectedSkills: [],
        },
        {
          ...identity,
          ...installFields,
          selectedAgents: [],
          selectedMcpServers: [],
          selectedSkills: [],
        },
        {
          ...identity,
          ...installFields,
          mode: 'unknown',
        },
        {
          ...identity,
          ...installFields,
          mode: 'full',
          unexpected: true,
        },
      ];
      for (const request of invalidRequests) {
        expect(() => validateIpcInvokeArgs(channel, [request])).toThrow(/Invalid IPC payload/);
      }
    },
  );

  it('accepts Pi at launch, duel, kanban, and session-list boundaries', () => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_CREATE, [{
      agent: 'pi',
      effort: 'xhigh',
      model: 'openai/gpt-5.5',
      prompt: '',
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: 'Compare approaches',
      sides: [{ agent: 'pi' }, { agent: 'codex' }],
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.PANE_SESSION_LIST, [{
      agent: 'pi',
      projectRoot: '/repo/current',
    }])).not.toThrow();
  });

  it.each(['pii', 'Pi', 'π'])('rejects noncanonical Pi id %s', (agent) => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_CREATE, [{ agent, prompt: '' }]))
      .toThrow(/Invalid IPC payload/);
    expect(() => validateIpcInvokeArgs(IPC.PANE_SESSION_LIST, [{
      agent,
      projectRoot: '/repo/current',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('accepts only non-empty bounded single-line pane names for rename', () => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_RENAME, [{
      paneId: 'pane-1',
      newName: 'Clearer name',
    }])).not.toThrow();

    for (const newName of ['', '   ', 'a'.repeat(81), 'line one\nline two']) {
      expect(() => validateIpcInvokeArgs(IPC.PANE_RENAME, [{
        paneId: 'pane-1',
        newName,
      }])).toThrow(/Invalid IPC payload/);
    }
  });

  it('rejects extra arguments on no-payload channels', () => {
    expect(() => validateIpcInvokeArgs(IPC.AGENT_LIST, [{ unexpected: true }])).toThrow(/Invalid IPC payload/);
  });

  it('accepts app info requests without a payload', () => {
    expect(() => validateIpcInvokeArgs(IPC.SYSTEM_APP_INFO, [])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.SYSTEM_APP_INFO, [{ unexpected: true }])).toThrow(/Invalid IPC payload/);
  });

  it('keeps unknown values only for settings values and action callback values', () => {
    expect(() => validateIpcInvokeArgs(IPC.SETTINGS_UPDATE, [{
      key: 'baseBranch',
      scope: 'project',
      value: { arbitrary: true },
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.ACTION_CALLBACK, [{
      callbackId: 'callback-1',
      value: { rejected: true },
    }])).toThrow(/Invalid IPC payload/);
  });

  it('accepts renderer diagnostics but rejects unknown log levels', () => {
    expect(() => validateIpcInvokeArgs(IPC.RENDERER_LOG, [{
      level: 'debug',
      scope: 'terminal',
      message: 'WebGL addon failed, using DOM renderer',
      data: { reason: 'context lost' },
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.RENDERER_LOG, [{
      level: 'trace',
      scope: 'terminal',
      message: 'unsupported',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('validates duel create payloads and rejects identical or empty ones', () => {
    // valid: two sides differing by agent
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: 'build a login form',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
      claudeRenderer: 'classic',
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: 'build a login form',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
      claudeRenderer: 'fullscreen',
    }])).toThrow(/Invalid IPC payload/);

    // valid: same agent differing by model
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: 'build a login form',
      sides: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'sonnet' }],
    }])).not.toThrow();

    // invalid: identical sides
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: 'build a login form',
      sides: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'opus' }],
    }])).toThrow(/Invalid IPC payload/);

    // invalid: empty (whitespace) prompt
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_CREATE, [{
      prompt: '   ',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
    }])).toThrow(/Invalid IPC payload/);
  });

  it('validates duel resolve payloads', () => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_RESOLVE, [{ winnerPaneId: 'pane-a' }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.PANE_DUEL_RESOLVE, [{ winnerPaneId: '' }])).toThrow(/Invalid IPC payload/);
  });

  it('validates terminal scroll requests', () => {
    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SCROLL, [{
      alternateScreenMode: 'opencode',
      direction: 'up',
      lines: 12,
      paneId: 'p1',
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SCROLL, [{
      alternateScreenMode: 'unknown',
      direction: 'up',
      lines: 12,
      paneId: 'p1',
    }])).toThrow(/Invalid IPC payload/);

    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SCROLL, [{
      direction: 'left',
      lines: 12,
      paneId: 'p1',
    }])).toThrow(/Invalid IPC payload/);

    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SCROLL, [{
      direction: 'up',
      lines: 0,
      paneId: 'p1',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('validates terminal selection expansion requests', () => {
    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SELECTION_EXPAND, [{
      anchorText: 'first viewport',
      currentText: 'last viewport',
      direction: 'down',
      paneId: 'p1',
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SELECTION_EXPAND, [{
      anchorText: '',
      currentText: 'last viewport',
      direction: 'down',
      paneId: 'p1',
    }])).toThrow(/Invalid IPC payload/);

    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_SELECTION_EXPAND, [{
      anchorText: 'first viewport',
      currentText: 'last viewport',
      direction: 'sideways',
      paneId: 'p1',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('accepts only a boolean user-initiated marker for terminal writes', () => {
    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_WRITE, [{
      data: 'x',
      paneId: 'p1',
      userInitiated: true,
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_WRITE, [{
      data: 'x',
      paneId: 'p1',
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.TERMINAL_WRITE, [{
      data: 'x',
      paneId: 'p1',
      userInitiated: 'yes',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('accepts a bounded pane-session list limit', () => {
    expect(() => validateIpcInvokeArgs(IPC.PANE_SESSION_LIST, [{
      agent: 'claude',
      limit: 10,
      projectRoot: '/tmp/project',
    }])).not.toThrow();

    expect(() => validateIpcInvokeArgs(IPC.PANE_SESSION_LIST, [{
      agent: 'claude',
      limit: 0,
      projectRoot: '/tmp/project',
    }])).toThrow(/Invalid IPC payload/);
  });

  it('requires every file write to declare the expected disk state', () => {
    const base = {
      content: 'next content',
      documentVersion: 2,
      editorSessionId: 'editor-session-1',
      eol: 'lf',
      hasBom: false,
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      saveSequence: 3,
    };

    expect(() => validateIpcInvokeArgs(IPC.FILE_WRITE, [{
      ...base,
      expectedContentVersion: 'previous-hash',
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.FILE_WRITE, [{
      ...base,
      expectedContentVersion: null,
      expectedMissing: true,
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.FILE_WRITE, [base])).toThrow(/Invalid IPC payload/);
    expect(() => validateIpcInvokeArgs(IPC.FILE_WRITE, [{
      ...base,
      expectedContentVersion: 'previous-hash',
      expectedMissing: true,
    }])).toThrow(/Invalid IPC payload/);
  });

  it('requires a valid inspected state for worktree removal', () => {
    const request = {
      allowDataLoss: false,
      expectedState: {
        branch: 'feature/preserved',
        gitStatus: 'clean',
        registration: 'registered',
      },
      worktreePath: '/repo/.muxbase/worktrees/preserved',
    };

    expect(() => validateIpcInvokeArgs(IPC.WORKTREE_REMOVE, [request])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.WORKTREE_REMOVE, [{
      allowDataLoss: false,
      worktreePath: request.worktreePath,
    }])).toThrow(/Invalid IPC payload/);
    expect(() => validateIpcInvokeArgs(IPC.WORKTREE_REMOVE, [{
      ...request,
      expectedState: { ...request.expectedState, gitStatus: 'assumed-clean' },
    }])).toThrow(/Invalid IPC payload/);
  });

  it('validates electron settings values against per-key schemas', () => {
    // valid: enum value matches
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalTransport',
      value: 'control',
    }])).not.toThrow();
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalTransport',
      value: 'pty',
    }])).not.toThrow();

    // valid: boolean
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'cursorBlink',
      value: false,
    }])).not.toThrow();

    // valid: number
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalFontSize',
      value: 14,
    }])).not.toThrow();

    // invalid: enum value outside allowed set
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalTransport',
      value: 'totally-fake-mode',
    }])).toThrow(/Invalid IPC payload/);

    // invalid: wrong type for boolean key
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'cursorBlink',
      value: 'yes',
    }])).toThrow(/Invalid IPC payload/);

    // invalid: wrong type for number key
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalFontSize',
      value: '14',
    }])).toThrow(/Invalid IPC payload/);

    // invalid: number out of range
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'terminalFontSize',
      value: 200,
    }])).toThrow(/Invalid IPC payload/);

    // invalid: opacity below the safe floor
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'windowOpacity',
      value: -3,
    }])).toThrow(/Invalid IPC payload/);

    // invalid: NaN rejected by number schema
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'pollingInterval',
      value: Number.NaN,
    }])).toThrow(/Invalid IPC payload/);

    // invalid: unknown key
    expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
      key: 'mysteryKey',
      value: true,
    }])).toThrow(/Invalid IPC payload/);
  });

  it('rejects path-traversal artifact names for marketplace item install/uninstall', () => {
    const base = {
      type: 'skill' as const,
      agents: ['claude' as const],
      pluginId: 'myplugin',
      sourceUrl: 'https://example.com/repo.git',
    };

    // valid: an ordinary skill name
    expect(() => validateIpcInvokeArgs(IPC.MARKETPLACE_UNINSTALL_ITEM, [{
      ...base, name: 'my-skill',
    }])).not.toThrow();

    // invalid: traversal, separators, absolute, leading dot
    for (const name of ['../../.ssh', '..\\..\\evil', '/etc/passwd', '.hidden', 'a/b']) {
      expect(() => validateIpcInvokeArgs(IPC.MARKETPLACE_UNINSTALL_ITEM, [{
        ...base, name,
      }])).toThrow(/Invalid IPC payload/);
    }

    // invalid: a hostile pluginId component (used to scope the on-disk filename)
    expect(() => validateIpcInvokeArgs(IPC.MARKETPLACE_UNINSTALL_ITEM, [{
      ...base, name: 'reviewer', type: 'agent', pluginId: '../..',
    }])).toThrow(/Invalid IPC payload/);

    // install-item enforces the same name rules
    expect(() => validateIpcInvokeArgs(IPC.MARKETPLACE_INSTALL_ITEM, [{
      ...base, name: '../../evil',
    }])).toThrow(/Invalid IPC payload/);
  });
});

describe('IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED payload shape', () => {
  it('channel string is an event channel and not an invoke channel', () => {
    expect(isIpcEventChannel(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED)).toBe(true);
    expect(isIpcInvokeChannel(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED)).toBe(false);
    expect(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED).toBe('event:terminal-stream-mode-changed');
  });

  it('TerminalStreamModeChangedEvent has the required paneId, streamId, and mode fields', () => {
    const event: TerminalStreamModeChangedEvent = {
      paneId: 'p1',
      streamId: 42,
      mode: 'capture',
    };
    expect(event.paneId).toBe('p1');
    expect(event.streamId).toBe(42);
    expect(event.mode).toBe('capture');
  });
});
