import { SettingsManager } from 'aumx/core';
import type { AgentDefaultSlice } from '../../../shared/ipc-types.js';

export function readPiDefaults(projectRoot?: string): AgentDefaultSlice {
  try {
    const settings = SettingsManager.getInstance(projectRoot).getSettings();
    return {
      model: settings.piModel || undefined,
      effort: settings.piThinking || undefined,
    };
  } catch {
    return {};
  }
}
