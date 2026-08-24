import { AGENT_IDS, getAgentsWithCapability } from 'aumx/core';
import { describe, expect, it } from 'vitest';
import {
  agentHasSessionParsing,
  SESSION_PARSING_AGENTS,
} from '../../src/shared/agent-session-types';

describe('agent session types', () => {
  it('marks claude, codex, opencode and pi as session-parseable', () => {
    // Arrange
    const agents = ['claude', 'codex', 'opencode', 'pi'];

    // Act
    const supported = agents.map(agentHasSessionParsing);

    // Assert
    expect(supported).toEqual([true, true, true, true]);
  });

  it('keeps the parser registry aligned with the agent capability contract', () => {
    expect(SESSION_PARSING_AGENTS).toEqual(
      getAgentsWithCapability(AGENT_IDS, 'sessionParsing'),
    );
  });
});
