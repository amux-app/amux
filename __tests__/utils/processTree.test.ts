import { describe, expect, it } from 'vitest';
import { isAgentCommand } from '../../src/utils/agentCommandDetection.js';
import { parseProcessTable, processTreeContainsCommand } from '../../src/utils/processTree.js';

describe('processTree', () => {
  it.each(['bash', 'zsh', 'fish', 'sh'] as const)(
    'finds an agent process below a %s tmux default-shell wrapper',
    (shell) => {
      const output = `
      100     1 ${shell}
      101   100 sh
      102   101 claude
      200     1 codex
    `;

      const entries = parseProcessTable(output);
      const found = processTreeContainsCommand(
        entries,
        100,
        (entry) => isAgentCommand('claude', entry.command),
      );

      expect(found).toBe(true);
    },
  );

  it('does not match sibling agent processes outside the pane tree', () => {
    const output = `
      100     1 fish
      101   100 sh
      200     1 claude
    `;

    const entries = parseProcessTable(output);
    const found = processTreeContainsCommand(
      entries,
      100,
      (entry) => isAgentCommand('claude', entry.command),
    );

    expect(found).toBe(false);
  });

  it('keeps command args available for node-backed agent processes', () => {
    const output = `
      100     1 fish fish -c launcher
      101   100 node node /usr/local/bin/codex
    `;

    const entries = parseProcessTable(output);
    const found = processTreeContainsCommand(
      entries,
      100,
      (entry) => entry.command === 'node' && isAgentCommand('codex', entry.args),
    );

    expect(found).toBe(true);
  });

  it('matches agent names inside nested executable paths', () => {
    expect(isAgentCommand('claude', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true);
  });
});
