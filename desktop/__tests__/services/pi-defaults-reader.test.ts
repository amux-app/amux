import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ piModel: '', piThinking: '' }));

vi.mock('muxbase/core', () => ({
  SettingsManager: {
    getInstance: vi.fn(() => ({ getSettings: () => settings })),
  },
}));

import { readPiDefaults } from '../../src/main/services/agent-defaults/PiDefaultsReader';

describe('readPiDefaults', () => {
  beforeEach(() => {
    settings.piModel = '';
    settings.piThinking = '';
  });

  it('reports scoped MuxBase Pi model and thinking defaults', () => {
    settings.piModel = 'openai/gpt-5.5';
    settings.piThinking = 'high';

    expect(readPiDefaults('/repo/current')).toEqual({
      model: 'openai/gpt-5.5',
      effort: 'high',
    });
  });
});
