import { describe, it, expect } from 'vitest';
import {
  appendSlugSuffix,
  buildAgentLaunchOptions,
  getAgentSlugSuffix,
  getCodexEffortFlags,
  getCodexModelFlags,
  getEffortFlags,
  getModelFlags,
  getOpencodeModelFlags,
  getOpencodeVariantFlags,
  getPermissionFlags,
  getReadOnlyFlags,
} from '../src/utils/agentLaunch.js';

describe('agent launch utils', () => {
  it('appends normalized slug suffix once', () => {
    expect(appendSlugSuffix('feature-a', 'Claude Code')).toBe('feature-a-claude-code');
    expect(appendSlugSuffix('feature-a-claude-code', 'claude-code')).toBe('feature-a-claude-code');
  });

  it('returns per-agent slug suffixes', () => {
    expect(getAgentSlugSuffix('claude')).toBe('claude-code');
    expect(getAgentSlugSuffix('opencode')).toBe('opencode');
    expect(getAgentSlugSuffix('codex')).toBe('codex');
  });

  it('builds single and a/b options from available agents', () => {
    const options = buildAgentLaunchOptions(['claude', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'codex',
      'claude+codex',
    ]);
    expect(options[2]?.agents).toEqual(['claude', 'codex']);
  });

  it('builds all pair combinations when 3 agents are available', () => {
    const options = buildAgentLaunchOptions(['claude', 'opencode', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'opencode',
      'codex',
      'claude+opencode',
      'claude+codex',
      'opencode+codex',
    ]);
  });
});

describe('getPermissionFlags', () => {
  describe('claude', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('claude', '')).toBe('');
      expect(getPermissionFlags('claude', undefined)).toBe('');
    });

    it('returns auto mode flags', () => {
      expect(getPermissionFlags('claude', 'auto')).toBe('--permission-mode auto');
    });

    it('normalizes edit-capable legacy modes to safe auto flags', () => {
      expect(getPermissionFlags('claude', 'acceptEdits')).toBe('--permission-mode auto');
      expect(getPermissionFlags('claude', 'bypassPermissions')).toBe('--permission-mode auto');
    });

    it('does not turn legacy plan mode into edit-capable auto flags', () => {
      expect(getPermissionFlags('claude', 'plan')).toBe('');
    });
  });

  describe('codex', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('codex', '')).toBe('');
      expect(getPermissionFlags('codex', undefined)).toBe('');
    });

    it('returns auto mode flags', () => {
      expect(getPermissionFlags('codex', 'auto')).toBe('--sandbox workspace-write --ask-for-approval on-request');
    });

    it('normalizes edit-capable legacy modes to safe auto flags', () => {
      expect(getPermissionFlags('codex', 'acceptEdits')).toBe('--sandbox workspace-write --ask-for-approval on-request');
      expect(getPermissionFlags('codex', 'bypassPermissions')).toBe('--sandbox workspace-write --ask-for-approval on-request');
    });

    it('does not turn legacy plan mode into edit-capable auto flags', () => {
      expect(getPermissionFlags('codex', 'plan')).toBe('');
    });
  });

  describe('opencode', () => {
    it('uses OpenCode default permissions without unsafe flags', () => {
      expect(getPermissionFlags('opencode', '')).toBe('');
      expect(getPermissionFlags('opencode', undefined)).toBe('');
      expect(getPermissionFlags('opencode', 'auto')).toBe('');
      expect(getPermissionFlags('opencode', 'plan')).toBe('');
      expect(getPermissionFlags('opencode', 'acceptEdits')).toBe('');
      expect(getPermissionFlags('opencode', 'bypassPermissions')).toBe('');
    });
  });
});

describe('getReadOnlyFlags', () => {
  it('constrains claude to plan mode', () => {
    expect(getReadOnlyFlags('claude')).toBe('--permission-mode plan');
  });

  it('constrains codex to a read-only sandbox without approval prompts', () => {
    expect(getReadOnlyFlags('codex')).toBe('--sandbox read-only --ask-for-approval never');
  });

  it('constrains opencode to the built-in plan agent', () => {
    expect(getReadOnlyFlags('opencode')).toBe('--agent plan');
  });
});

describe('getModelFlags (claude)', () => {
  it('returns no flag for empty or undefined model', () => {
    expect(getModelFlags('claude', '')).toBe('');
    expect(getModelFlags('claude', undefined)).toBe('');
  });

  it('emits --model alias for each supported claude alias', () => {
    expect(getModelFlags('claude', 'opus')).toBe("--model 'opus'");
    expect(getModelFlags('claude', 'sonnet')).toBe("--model 'sonnet'");
    expect(getModelFlags('claude', 'haiku')).toBe("--model 'haiku'");
    expect(getModelFlags('claude', 'fable')).toBe("--model 'fable'");
  });

  it('is a no-op for non-claude agents', () => {
    expect(getModelFlags('codex', 'opus')).toBe('');
    expect(getModelFlags('opencode', 'opus')).toBe('');
  });
});

describe('getEffortFlags (claude)', () => {
  it('returns no flag for empty or undefined effort', () => {
    expect(getEffortFlags('claude', '')).toBe('');
    expect(getEffortFlags('claude', undefined)).toBe('');
  });

  it('emits --effort level for supported claude levels', () => {
    expect(getEffortFlags('claude', 'low')).toBe("--effort 'low'");
    expect(getEffortFlags('claude', 'high')).toBe("--effort 'high'");
    expect(getEffortFlags('claude', 'max')).toBe("--effort 'max'");
  });

  it('translates ultracode (muxbase harness marker) to the highest valid CLI effort xhigh', () => {
    expect(getEffortFlags('claude', 'ultracode')).toBe("--effort 'xhigh'");
  });

  it('is a no-op for non-claude agents', () => {
    expect(getEffortFlags('codex', 'high')).toBe('');
    expect(getEffortFlags('opencode', 'high')).toBe('');
  });
});

describe('getCodexModelFlags', () => {
  it('returns no flag when model is undefined or empty', () => {
    expect(getCodexModelFlags(undefined)).toBe('');
    expect(getCodexModelFlags('')).toBe('');
  });

  it('emits --model <id> for any model id', () => {
    expect(getCodexModelFlags('gpt-5-codex')).toBe("--model 'gpt-5-codex'");
    expect(getCodexModelFlags('o4-mini')).toBe("--model 'o4-mini'");
    expect(getCodexModelFlags('gpt-4.1')).toBe("--model 'gpt-4.1'");
  });

  it('shell-escapes embedded single quotes to prevent injection', () => {
    expect(getCodexModelFlags("evil'; rm -rf /")).toBe("--model 'evil'\\''; rm -rf /'");
  });
});

describe('getCodexEffortFlags', () => {
  it('returns no flag when effort is undefined or empty', () => {
    expect(getCodexEffortFlags(undefined)).toBe('');
    expect(getCodexEffortFlags('')).toBe('');
  });

  it('emits -c with the model_reasoning_effort key=value pair quoted as one arg', () => {
    expect(getCodexEffortFlags('minimal')).toBe("-c 'model_reasoning_effort=minimal'");
    expect(getCodexEffortFlags('high')).toBe("-c 'model_reasoning_effort=high'");
    expect(getCodexEffortFlags('xhigh')).toBe("-c 'model_reasoning_effort=xhigh'");
  });
});

describe('getOpencodeModelFlags', () => {
  it('returns no flag when model is undefined or empty', () => {
    expect(getOpencodeModelFlags(undefined)).toBe('');
    expect(getOpencodeModelFlags('')).toBe('');
  });

  it('emits --model <provider/id> shell-quoted', () => {
    expect(getOpencodeModelFlags('openai/gpt-5.5-fast')).toBe("--model 'openai/gpt-5.5-fast'");
    expect(getOpencodeModelFlags('anthropic/claude-4.7-opus')).toBe("--model 'anthropic/claude-4.7-opus'");
  });
});

describe('getOpencodeVariantFlags', () => {
  it('returns no flag when variant is undefined or empty', () => {
    expect(getOpencodeVariantFlags(undefined)).toBe('');
    expect(getOpencodeVariantFlags('')).toBe('');
  });

  it('emits --variant <level> shell-quoted (provider-specific reasoning effort)', () => {
    expect(getOpencodeVariantFlags('high')).toBe("--variant 'high'");
    expect(getOpencodeVariantFlags('max')).toBe("--variant 'max'");
    expect(getOpencodeVariantFlags('minimal')).toBe("--variant 'minimal'");
  });
});
