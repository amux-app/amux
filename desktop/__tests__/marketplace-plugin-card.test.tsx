// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DetectedPlugin, MarketplaceSource } from 'aumx/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceSettings } from '../src/renderer/components/settings/MarketplaceSettings';
import { useMarketplaceStore } from '../src/renderer/stores/marketplace.store';

const previewPluginMock = vi.hoisted(() => vi.fn());
const installPluginMock = vi.hoisted(() => vi.fn());
const listSourcesMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/marketplace.api', () => ({
  addSource: vi.fn(),
  browseSource: vi.fn(async () => ({ plugins: [] })),
  installPlugin: installPluginMock,
  listInstalled: vi.fn(async () => []),
  listSources: listSourcesMock,
  previewPlugin: previewPluginMock,
  removeSource: vi.fn(),
  uninstallPlugin: vi.fn(),
  updateSource: vi.fn(),
}));

const source: MarketplaceSource = {
  url: 'https://example.test/marketplace.git',
  name: 'marketplace',
  clonePath: '/tmp/marketplace',
  detectedFormat: 'claude',
  headSha: 'head-1',
  lastUpdated: '2026-08-19T00:00:00.000Z',
};

const plugin: DetectedPlugin = {
  id: 'plugin-one',
  name: 'Plugin One',
  skills: [{ name: 'skill-one', description: 'A skill' }],
  mcpServers: [],
  agents: [],
  hooks: [{ event: 'post_merge', command: 'run-tool' }],
  jsPlugins: [],
};

describe('marketplace executable preview consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSourcesMock.mockResolvedValue([source]);
    useMarketplaceStore.setState({
      sources: [source],
      installedPlugins: [],
      browsedPlugins: { [source.url]: [plugin] },
      isLoading: false,
      installingPlugin: null,
      error: null,
    });
    previewPluginMock.mockResolvedValue({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: true,
        agents: [{ agent: 'claude', artifacts: [{ name: 'post_merge', destinationPaths: ['.aumx-hooks/post_merge'], detail: 'run-tool' }] }],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });
    installPluginMock.mockResolvedValue({ success: true });
    window.confirm = vi.fn(() => false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows executable effects and blocks installation until confirmation is accepted', async () => {
    render(<MarketplaceSettings />);

    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('post_merge')));
    expect(installPluginMock).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(installPluginMock).toHaveBeenCalledWith(
      'plugin-one',
      source.url,
      'full',
      ['skill-one'],
      [],
      [],
      'digest-1',
    ));
  });

  it('shows literal manifest-provided MCP environment values in the consent dialog', async () => {
    previewPluginMock.mockResolvedValue({
      success: true,
      preview: {
        digest: 'digest-2',
        introducesExecutableBehavior: true,
        agents: [{
          agent: 'claude',
          artifacts: [{
            name: 'mcp:test-server',
            destinationPaths: ['~/.claude/settings.json'],
            detail: 'node server.js\nNODE_OPTIONS="--require ./bootstrap.js"',
          }],
        }],
        environmentVariableNames: ['NODE_OPTIONS'],
        generatedFiles: [],
      },
    });

    render(<MarketplaceSettings />);

    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('NODE_OPTIONS="--require ./bootstrap.js"'),
    ));
    expect(installPluginMock).not.toHaveBeenCalled();
  });
});
