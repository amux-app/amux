import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { IPC, IPC_EVENT } from '../src/shared/ipc-channels';
import type { SerializableActionResult } from '../src/shared/ipc-types';

const API_DIR = resolve(__dirname, '..', 'src', 'renderer', 'api');

// IPC channels registered on the main process but intentionally not yet
// exposed to the renderer (e.g. used only during startup or planned features).
// Update this list when adding a renderer API wrapper for a channel.
const MAIN_ONLY_CHANNELS: ReadonlySet<string> = new Set(['SYSTEM_CHECK']);

function readApiFiles(): string {
  const files = readdirSync(API_DIR)
    .filter((file) => file.endsWith('.api.ts'))
    .sort();
  return files.map((file) => readFileSync(resolve(API_DIR, file), 'utf-8')).join('\n');
}

describe('IPC-to-renderer API coverage', () => {
  const apiSource = readApiFiles();
  const rendererChannelKeys = Object.keys(IPC).filter((k) => !MAIN_ONLY_CHANNELS.has(k));

  it.each(rendererChannelKeys)('IPC.%s is referenced in a renderer API function', (key) => {
    expect(apiSource).toContain(`IPC.${key}`);
  });

  it('every renderer-facing IPC channel has a corresponding API call', () => {
    const missingKeys: string[] = [];
    for (const key of rendererChannelKeys) {
      if (!apiSource.includes(`IPC.${key}`)) {
        missingKeys.push(key);
      }
    }
    expect(missingKeys).toEqual([]);
  });

  it('MAIN_ONLY_CHANNELS lists only keys that actually exist in IPC', () => {
    for (const key of MAIN_ONLY_CHANNELS) {
      expect(Object.keys(IPC)).toContain(key);
    }
  });
});

describe('IPC and IPC_EVENT separation', () => {
  const ipcValues = new Set(Object.values(IPC));
  const eventValues = new Set(Object.values(IPC_EVENT));

  it('IPC channels do not start with "event:"', () => {
    const violations = Object.entries(IPC).filter(([, v]) => v.startsWith('event:'));
    expect(violations).toEqual([]);
  });

  it('IPC_EVENT channels are not in IPC', () => {
    const overlap = [...eventValues].filter((v) => ipcValues.has(v as (typeof IPC)[keyof typeof IPC]));
    expect(overlap).toEqual([]);
  });

  it('IPC channels are not in IPC_EVENT', () => {
    const overlap = [...ipcValues].filter((v) => eventValues.has(v as (typeof IPC_EVENT)[keyof typeof IPC_EVENT]));
    expect(overlap).toEqual([]);
  });
});

describe('SerializableActionResult contract', () => {
  it('has the required "type" field with correct union', () => {
    const result: SerializableActionResult = { type: 'success', message: '' };
    const validTypes = ['success', 'error', 'confirm', 'choice', 'input', 'info', 'progress', 'navigation'] as const;
    expect(validTypes).toContain(result.type);
  });

  it('has the required "message" field', () => {
    const result: SerializableActionResult = { type: 'info', message: 'test' };
    expect(result.message).toBeDefined();
  });

  it('supports optional confirm fields', () => {
    const result: SerializableActionResult = {
      type: 'confirm',
      message: 'Are you sure?',
      title: 'Confirm',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      callbackId: 'cb-1',
      dismissable: true,
    };
    expect(result.title).toBe('Confirm');
    expect(result.confirmLabel).toBe('Yes');
    expect(result.cancelLabel).toBe('No');
    expect(result.callbackId).toBe('cb-1');
    expect(result.dismissable).toBe(true);
  });

  it('supports optional choice fields', () => {
    const result: SerializableActionResult = {
      type: 'choice',
      message: 'Pick one',
      options: [
        { id: 'a', label: 'Option A', description: 'First', danger: false, default: true },
        { id: 'b', label: 'Option B' },
      ],
      callbackId: 'cb-2',
    };
    expect(result.options).toHaveLength(2);
    expect(result.options![0].id).toBe('a');
  });

  it('supports optional input fields', () => {
    const result: SerializableActionResult = {
      type: 'input',
      message: 'Enter name',
      placeholder: 'name...',
      defaultValue: 'default',
      callbackId: 'cb-3',
    };
    expect(result.placeholder).toBe('name...');
    expect(result.defaultValue).toBe('default');
  });

  it('supports optional progress and navigation fields', () => {
    const result: SerializableActionResult = {
      type: 'progress',
      message: 'Working...',
      progress: 50,
      targetPaneId: 'pane-1',
      data: { extra: true },
    };
    expect(result.progress).toBe(50);
    expect(result.targetPaneId).toBe('pane-1');
    expect(result.data).toEqual({ extra: true });
  });
});

describe('Channel naming consistency', () => {
  it('IPC keys use UPPER_SNAKE_CASE', () => {
    for (const key of Object.keys(IPC)) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('IPC_EVENT keys use UPPER_SNAKE_CASE', () => {
    for (const key of Object.keys(IPC_EVENT)) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('IPC channel values use lowercase kebab domain:action', () => {
    for (const value of Object.values(IPC)) {
      expect(value).toMatch(/^[a-z][-a-z]*:[a-z][-a-z]*$/);
    }
  });

  it('IPC_EVENT channel values use event: prefix with kebab-case', () => {
    for (const value of Object.values(IPC_EVENT)) {
      expect(value).toMatch(/^event:[a-z][-a-z]*$/);
    }
  });

  it('IPC key domain prefix matches channel domain', () => {
    for (const [key, value] of Object.entries(IPC)) {
      const channelDomain = value.split(':')[0];
      const keyDomain = key.split('_').slice(0, channelDomain.split('-').length).join('-').toLowerCase();
      expect(channelDomain).toBe(keyDomain);
    }
  });
});
