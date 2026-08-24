import { describe, expect, it } from 'vitest';
import { isAgentCommand } from '../../src/utils/agentCommandDetection.js';

describe('isAgentCommand', () => {
  it('matches Pi by executable identity rather than substring', () => {
    expect(isAgentCommand('pi', 'pi')).toBe(true);
    expect(isAgentCommand('pi', '/opt/homebrew/bin/pi')).toBe(true);
    expect(isAgentCommand('pi', '/usr/bin/env pi --thinking high')).toBe(true);
    expect(isAgentCommand('pi', 'pip')).toBe(false);
    expect(isAgentCommand('pi', 'spin')).toBe(false);
    expect(isAgentCommand('pi', 'node task.js --name pi')).toBe(false);
  });
});
