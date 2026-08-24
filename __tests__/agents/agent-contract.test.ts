import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  agentHasCapability,
  getAgentBinary,
  getAgentLabel,
  getAgentSlugSuffix,
  getAgentsWithCapability,
  isAgentName,
} from '../../src/agents/agent-contract.js';

describe('agent contract', () => {
  it('defines one stable ordered catalog including Pi', () => {
    expect(AGENT_IDS).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(AGENT_IDS.every(isAgentName)).toBe(true);
    expect(isAgentName('unknown')).toBe(false);
  });

  it('exposes stable Pi identity metadata', () => {
    expect(getAgentLabel('pi')).toBe('Pi');
    expect(getAgentBinary('pi')).toBe('pi');
    expect(getAgentSlugSuffix('pi')).toBe('pi');
  });

  it('exposes supported Pi flows while keeping unsupported surfaces disabled', () => {
    expect(agentHasCapability('pi', 'launch')).toBe(true);
    expect(agentHasCapability('pi', 'duel')).toBe(true);
    expect(agentHasCapability('pi', 'kanban')).toBe(true);
    expect(agentHasCapability('pi', 'sessionList')).toBe(true);
    expect(agentHasCapability('pi', 'sessionParsing')).toBe(true);
    expect(agentHasCapability('pi', 'review')).toBe(false);
    expect(agentHasCapability('pi', 'marketplaceMcp')).toBe(false);
  });

  it('filters installed agents without changing canonical order', () => {
    expect(getAgentsWithCapability(['pi', 'codex', 'claude'], 'review')).toEqual(['claude', 'codex']);
    expect(getAgentsWithCapability(['pi', 'codex', 'claude'], 'launch')).toEqual(['claude', 'codex', 'pi']);
  });
});
