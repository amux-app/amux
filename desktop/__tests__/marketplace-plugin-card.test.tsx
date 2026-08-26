// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DetectedPlugin, MarketplaceSource } from 'muxbase/core';
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

const multiSkillPlugin: DetectedPlugin = {
  ...plugin,
  skills: [
    { name: 'skill-one', description: 'A skill' },
    { name: 'skill-two', description: 'Another skill' },
  ],
};

const secondSource: MarketplaceSource = {
  ...source,
  name: 'marketplace-two',
  url: 'https://example.test/marketplace-two.git',
};

const secondPlugin: DetectedPlugin = {
  ...plugin,
  hooks: [],
  id: 'plugin-two',
  name: 'Plugin Two',
  skills: [{ name: 'skill-two', description: 'Another skill' }],
};

const duplicatePlugin: DetectedPlugin = {
  ...plugin,
  hooks: [],
  name: 'Plugin One Copy',
  skills: [{ name: 'skill-two', description: 'Another skill' }],
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
      installInFlight: null,
      installingPlugin: null,
      error: null,
    });
    previewPluginMock.mockResolvedValue({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: true,
        agents: [{ agent: 'claude', artifacts: [{ name: 'post_merge', destinationPaths: ['.muxbase-hooks/post_merge'], detail: 'run-tool' }] }],
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
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('post_merge')));
    expect(installPluginMock).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));

    await waitFor(() => expect(installPluginMock).toHaveBeenCalledWith(
      {
        mode: 'selected',
        pluginId: 'plugin-one',
        previewDigest: 'digest-1',
        selectedAgents: [],
        selectedMcpServers: [],
        selectedSkills: ['skill-one'],
        sourceUrl: source.url,
      },
    ));
  });

  it('ignores a second install click while the preview is pending', async () => {
    let resolvePreview!: (value: unknown) => void;
    previewPluginMock.mockReturnValue(new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    }));

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    const installButton = screen.getByRole('button', { name: 'Install selected (1)' });
    fireEvent.click(installButton);
    fireEvent.click(installButton);

    expect(previewPluginMock).toHaveBeenCalledTimes(1);
    resolvePreview({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: false,
        agents: [],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });

    await waitFor(() => expect(installPluginMock).toHaveBeenCalledTimes(1));
  });

  it('keeps the install claim when SettingsView unmounts during preview', async () => {
    let resolvePreview!: (value: unknown) => void;
    previewPluginMock.mockReturnValue(new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    }));

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));
    expect(previewPluginMock).toHaveBeenCalledTimes(1);

    cleanup();
    render(<MarketplaceSettings />);
    const remountedInstallButton = screen.getByRole('button', { name: /^Install$/ });

    expect(previewPluginMock).toHaveBeenCalledTimes(1);
    expect(remountedInstallButton.disabled).toBe(true);
    resolvePreview({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: false,
        agents: [],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });
    await waitFor(() => expect(installPluginMock).toHaveBeenCalledTimes(1));
  });

  it('disables every plugin install action while another plugin is pending', async () => {
    let resolvePreview!: (value: unknown) => void;
    previewPluginMock.mockReturnValue(new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    }));
    listSourcesMock.mockResolvedValue([source, secondSource]);
    useMarketplaceStore.setState({
      browsedPlugins: {
        [secondSource.url]: [secondPlugin],
        [source.url]: [plugin],
      },
      sources: [source, secondSource],
    });

    render(<MarketplaceSettings />);
    const installButtons = screen.getAllByRole('button', { name: /^Install$/ });
    expect(installButtons).toHaveLength(2);
    fireEvent.click(installButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));

    expect(installButtons[1].disabled).toBe(true);
    fireEvent.click(installButtons[1]);
    expect(previewPluginMock).toHaveBeenCalledTimes(1);

    resolvePreview({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: false,
        agents: [],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });
    await waitFor(() => expect(installPluginMock).toHaveBeenCalledTimes(1));
  });

  it('shows the spinner only for the active source and plugin identity', async () => {
    let resolvePreview!: (value: unknown) => void;
    previewPluginMock.mockReturnValue(new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    }));
    listSourcesMock.mockResolvedValue([source, secondSource]);
    useMarketplaceStore.setState({
      browsedPlugins: {
        [secondSource.url]: [duplicatePlugin],
        [source.url]: [plugin],
      },
      sources: [source, secondSource],
    });

    render(<MarketplaceSettings />);
    const installButtons = screen.getAllByRole('button', { name: /^Install$/ });
    fireEvent.click(installButtons[0]);
    fireEvent.click(installButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));

    await waitFor(() => expect(screen.getAllByRole('status', { name: 'Loading' })).toHaveLength(1));
    resolvePreview({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: false,
        agents: [],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });
    await waitFor(() => expect(installPluginMock).toHaveBeenCalledTimes(1));
  });

  it('emits the same selected intent for Select all and reverse-order manual selection', async () => {
    useMarketplaceStore.setState({ browsedPlugins: { [source.url]: [multiSkillPlugin] } });

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all skills' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (2)' }));

    await waitFor(() => expect(previewPluginMock).toHaveBeenCalledWith({
      mode: 'selected',
      pluginId: 'plugin-one',
      selectedAgents: [],
      selectedMcpServers: [],
      selectedSkills: ['skill-one', 'skill-two'],
      sourceUrl: source.url,
    }));

    cleanup();
    vi.clearAllMocks();
    previewPluginMock.mockResolvedValue({
      success: true,
      preview: {
        digest: 'digest-1',
        introducesExecutableBehavior: false,
        agents: [],
        environmentVariableNames: [],
        generatedFiles: [],
      },
    });
    installPluginMock.mockResolvedValue({ success: true });

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-two' }));
    fireEvent.click(screen.getByRole('button', { name: 'skill-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (2)' }));

    await waitFor(() => expect(previewPluginMock).toHaveBeenCalledWith({
      mode: 'selected',
      pluginId: 'plugin-one',
      selectedAgents: [],
      selectedMcpServers: [],
      selectedSkills: ['skill-one', 'skill-two'],
      sourceUrl: source.url,
    }));
  });

  it('emits an explicit full intent from the full-install action', async () => {
    useMarketplaceStore.setState({ browsedPlugins: { [source.url]: [multiSkillPlugin] } });

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install full plugin' }));

    await waitFor(() => expect(previewPluginMock).toHaveBeenCalledWith({
      mode: 'full',
      pluginId: 'plugin-one',
      sourceUrl: source.url,
    }));
  });

  it('emits an explicit full intent for auto-install-only plugins', async () => {
    const autoInstallOnlyPlugin: DetectedPlugin = {
      ...plugin,
      skills: [],
      hooks: [{ event: 'post_merge', command: 'run-tool' }],
    };
    useMarketplaceStore.setState({ browsedPlugins: { [source.url]: [autoInstallOnlyPlugin] } });

    render(<MarketplaceSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(previewPluginMock).toHaveBeenCalledWith({
      mode: 'full',
      pluginId: 'plugin-one',
      sourceUrl: source.url,
    }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Install selected (1)' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('NODE_OPTIONS="--require ./bootstrap.js"'),
    ));
    expect(installPluginMock).not.toHaveBeenCalled();
  });
});
