import { existsSync, readFileSync } from 'node:fs';
import type { AumxConfig, AumxPane } from '../types.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { parseAumxConfig } from './persistedStateValidation.js';

export type AumxConfigMutation = (config: AumxConfig) => void;

export function mutateAumxConfig(configPath: string, mutation: AumxConfigMutation): void {
  if (!existsSync(configPath)) throw new Error(`Aumx config not found: ${configPath}`);
  const raw = readFileSync(configPath, 'utf8');
  const config = parseAumxConfig(JSON.parse(raw));
  mutation(config);
  config.lastUpdated = new Date().toISOString();
  atomicWriteJsonSync(configPath, config);
}

export function upsertAumxPane(configPath: string, pane: AumxPane): void {
  mutateAumxConfig(configPath, (config) => {
    const index = config.panes.findIndex((candidate) => candidate.id === pane.id);
    if (index === -1) config.panes.push(pane);
    else config.panes[index] = pane;
  });
}

export function removeAumxPane(configPath: string, paneId: string): void {
  mutateAumxConfig(configPath, (config) => {
    config.panes = config.panes.filter((pane) => pane.id !== paneId);
  });
}

export function updateAumxControlFields(
  configPath: string,
  fields: Partial<Pick<AumxConfig, 'controlPaneId' | 'controlPaneSize'>>,
): void {
  mutateAumxConfig(configPath, (config) => {
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

export function updateAumxWelcomePane(configPath: string, welcomePaneId: string | undefined): void {
  mutateAumxConfig(configPath, (config) => {
    if (welcomePaneId === undefined) delete config.welcomePaneId;
    else config.welcomePaneId = welcomePaneId;
  });
}
