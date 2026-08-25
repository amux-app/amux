import { existsSync, readFileSync } from 'node:fs';
import type { MuxBaseConfig, MuxBasePane } from '../types.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { parseMuxBaseConfig } from './persistedStateValidation.js';

export type MuxBaseConfigMutation = (config: MuxBaseConfig) => void;

export function mutateMuxBaseConfig(configPath: string, mutation: MuxBaseConfigMutation): void {
  if (!existsSync(configPath)) throw new Error(`MuxBase config not found: ${configPath}`);
  const raw = readFileSync(configPath, 'utf8');
  const config = parseMuxBaseConfig(JSON.parse(raw));
  mutation(config);
  config.lastUpdated = new Date().toISOString();
  atomicWriteJsonSync(configPath, config);
}

export function upsertMuxBasePane(configPath: string, pane: MuxBasePane): void {
  mutateMuxBaseConfig(configPath, (config) => {
    const index = config.panes.findIndex((candidate) => candidate.id === pane.id);
    if (index === -1) config.panes.push(pane);
    else config.panes[index] = pane;
  });
}

export function removeMuxBasePane(configPath: string, paneId: string): void {
  mutateMuxBaseConfig(configPath, (config) => {
    config.panes = config.panes.filter((pane) => pane.id !== paneId);
  });
}

export function updateMuxBaseControlFields(
  configPath: string,
  fields: Partial<Pick<MuxBaseConfig, 'controlPaneId' | 'controlPaneSize'>>,
): void {
  mutateMuxBaseConfig(configPath, (config) => {
    if (Object.hasOwn(fields, 'controlPaneId')) {
      if (fields.controlPaneId === undefined) delete config.controlPaneId;
      else config.controlPaneId = fields.controlPaneId;
    }
    if (Object.hasOwn(fields, 'controlPaneSize')) {
      if (fields.controlPaneSize === undefined) delete config.controlPaneSize;
      else config.controlPaneSize = fields.controlPaneSize;
    }
  });
}

export function updateMuxBaseWelcomePane(configPath: string, welcomePaneId: string | undefined): void {
  mutateMuxBaseConfig(configPath, (config) => {
    if (welcomePaneId === undefined) delete config.welcomePaneId;
    else config.welcomePaneId = welcomePaneId;
  });
}
