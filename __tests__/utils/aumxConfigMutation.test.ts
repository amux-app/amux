import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutateAumxConfig,
  removeAumxPane,
  updateAumxControlFields,
  updateAumxWelcomePane,
  upsertAumxPane,
} from '../../src/utils/aumxConfigMutation.js';

function configPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aumx-config-'));
  const file = path.join(root, 'aumx.config.json');
  writeFileSync(file, JSON.stringify({
    customField: { preserved: true },
    lastUpdated: 'old',
    panes: [],
    projectName: 'demo',
    projectRoot: root,
    settings: { useWorktree: true },
  }));
  return file;
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('aumx config field-owned mutations', () => {
  it('preserves unrelated fields across sequential pane, welcome, and control updates', () => {
    const file = configPath();
    const pane = { id: 'pane-1', paneId: '%1', prompt: 'task', slug: 'task' };

    upsertAumxPane(file, pane);
    updateAumxWelcomePane(file, '%welcome');
    updateAumxControlFields(file, { controlPaneId: '%control', controlPaneSize: 40 });

    const config = readConfig(file);
    expect(config.customField).toEqual({ preserved: true });
    expect(config.settings).toEqual({ useWorktree: true });
    expect(config.welcomePaneId).toBe('%welcome');
    expect(config.controlPaneId).toBe('%control');
    expect(config.panes).toEqual([pane]);
  });

  it('updates only control fields explicitly included in the patch', () => {
    const file = configPath();
    updateAumxControlFields(file, { controlPaneId: '%control', controlPaneSize: 40 });
    updateAumxControlFields(file, { controlPaneId: '%replacement' });

    expect(readConfig(file)).toMatchObject({
      controlPaneId: '%replacement',
      controlPaneSize: 40,
    });
  });

  it('upserts and removes by pane id without replacing other panes', () => {
    const file = configPath();
    const first = { id: 'pane-1', paneId: '%1', prompt: 'first', slug: 'first' };
    const second = { id: 'pane-2', paneId: '%2', prompt: 'second', slug: 'second' };

    upsertAumxPane(file, first);
    upsertAumxPane(file, second);
    upsertAumxPane(file, { ...first, prompt: 'updated' });
    removeAumxPane(file, first.id);

    expect(readConfig(file).panes).toEqual([second]);
  });

  it('fails closed on malformed or missing config without replacing it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aumx-config-invalid-'));
    const malformed = path.join(root, 'malformed.json');
    writeFileSync(malformed, '{not-json');

    expect(() => updateAumxWelcomePane(malformed, '%welcome')).toThrow();
    expect(readFileSync(malformed, 'utf8')).toBe('{not-json');
    expect(() => updateAumxWelcomePane(path.join(root, 'missing.json'), '%welcome')).toThrow();
    expect(existsSync(path.join(root, 'missing.json'))).toBe(false);
  });

  it('runs a mutation against the latest on-disk snapshot', () => {
    const file = configPath();
    updateAumxWelcomePane(file, '%welcome');
    mutateAumxConfig(file, (config) => {
      config.settings.useWorktree = false;
    });

    expect(readConfig(file)).toMatchObject({
      settings: { useWorktree: false },
      welcomePaneId: '%welcome',
    });
  });
});
