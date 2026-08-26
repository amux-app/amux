import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceStore } from '../../src/renderer/stores/marketplace.store';
import * as marketplaceApi from '../../src/renderer/api/marketplace.api';

vi.mock('../../src/renderer/api/marketplace.api', () => ({
  installPlugin: vi.fn(),
  listInstalled: vi.fn(),
  listSources: vi.fn(),
  previewPlugin: vi.fn(),
  removeSource: vi.fn(),
  addSource: vi.fn(),
  browseSource: vi.fn(),
  uninstallPlugin: vi.fn(),
  updateSource: vi.fn(),
}));

describe('marketplace store preview/install coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketplaceStore.setState({
      sources: [],
      installedPlugins: [],
      browsedPlugins: {},
      isLoading: false,
      installingPlugin: null,
      error: null,
    });
    vi.mocked(marketplaceApi.listInstalled).mockResolvedValue([]);
  });

  it('passes the reviewed digest to the install request', async () => {
    vi.mocked(marketplaceApi.installPlugin).mockResolvedValue({ success: true, result: {} as never });

    await expect(useMarketplaceStore.getState().installPlugin(
      'plugin',
      'https://example.test/source.git',
      'selected',
      ['skill'],
      [],
      ['agent'],
      'digest-1',
    )).resolves.toBe(true);

    expect(marketplaceApi.installPlugin).toHaveBeenCalledWith(
      'plugin',
      'https://example.test/source.git',
      'selected',
      ['skill'],
      [],
      ['agent'],
      'digest-1',
    );
  });

  it('surfaces a preview failure without attempting install', async () => {
    vi.mocked(marketplaceApi.previewPlugin).mockResolvedValue({ success: false, error: 'source changed' });

    const response = await useMarketplaceStore.getState().previewPlugin('plugin', 'https://example.test/source.git');

    expect(response).toEqual({ success: false, error: 'source changed' });
    expect(marketplaceApi.installPlugin).not.toHaveBeenCalled();
  });

  it('categorizes an invalid marketplace source in the visible error state', async () => {
    vi.mocked(marketplaceApi.previewPlugin).mockResolvedValue({
      success: false,
      error: 'Marketplace artifact symlink escapes source tree',
      errorCode: 'INVALID_SOURCE_TREE',
    });

    await useMarketplaceStore.getState().previewPlugin('plugin', 'https://example.test/source.git');

    expect(useMarketplaceStore.getState().error).toBe(
      'Marketplace source is invalid or unsafe: Marketplace artifact symlink escapes source tree',
    );
  });

  it('keeps registry state and the source when uninstall fails', async () => {
    const sourceUrl = 'https://example.test/source.git';
    useMarketplaceStore.setState({
      installedPlugins: [{ pluginId: 'plugin', sourceUrl, installedAt: 'now', agents: {} }],
      sources: [{ url: sourceUrl, name: 'source', clonePath: '/tmp/source', detectedFormat: null, headSha: null, lastUpdated: null }],
    });
    vi.mocked(marketplaceApi.uninstallPlugin).mockResolvedValue({
      success: false,
      error: 'Ownership could not be verified',
      errorCode: 'ARTIFACT_MODIFIED',
    });

    await useMarketplaceStore.getState().uninstallPlugin('plugin', sourceUrl);

    expect(useMarketplaceStore.getState().error).toBe('Ownership could not be verified');
    expect(marketplaceApi.listInstalled).not.toHaveBeenCalled();
    expect(marketplaceApi.removeSource).not.toHaveBeenCalled();
  });

  it('reports preserved artifacts and keeps their marketplace source', async () => {
    const sourceUrl = 'https://example.test/source.git';
    const preservedPath = '/tmp/home/.claude/settings.json';
    useMarketplaceStore.setState({
      installedPlugins: [{ pluginId: 'plugin', sourceUrl, installedAt: 'now', agents: {} }],
      sources: [{ url: sourceUrl, name: 'source', clonePath: '/tmp/source', detectedFormat: null, headSha: null, lastUpdated: null }],
    });
    vi.mocked(marketplaceApi.uninstallPlugin).mockResolvedValue({
      success: true,
      preservedArtifacts: [preservedPath],
    });

    await useMarketplaceStore.getState().uninstallPlugin('plugin', sourceUrl);

    expect(useMarketplaceStore.getState().error).toContain(preservedPath);
    expect(marketplaceApi.listInstalled).toHaveBeenCalledOnce();
    expect(marketplaceApi.removeSource).not.toHaveBeenCalled();
  });

  it('keeps source state consistent across add, remove, update, and failure paths', async () => {
    const source = {
      clonePath: '/tmp/source',
      detectedFormat: null,
      headSha: null,
      lastUpdated: null,
      name: 'source',
      url: 'url',
    };
    vi.mocked(marketplaceApi.addSource).mockResolvedValue({
      source,
      success: true,
    });
    await expect(useMarketplaceStore.getState().addSource('url')).resolves.toBe(true);
    expect(useMarketplaceStore.getState().sources).toEqual([source]);

    vi.mocked(marketplaceApi.updateSource).mockResolvedValue({
      error: undefined,
      success: true,
    });
    vi.mocked(marketplaceApi.listSources).mockResolvedValue([source]);
    await useMarketplaceStore.getState().updateSource('url');
    expect(marketplaceApi.listSources).toHaveBeenCalledOnce();

    vi.mocked(marketplaceApi.removeSource).mockResolvedValue({
      error: 'busy',
      success: false,
    });
    await useMarketplaceStore.getState().removeSource('url');
    expect(useMarketplaceStore.getState().sources).toEqual([source]);
    expect(useMarketplaceStore.getState().error).toBe('busy');
  });

  it('marks a failed browse as loaded with an empty result', async () => {
    vi.mocked(marketplaceApi.browseSource).mockRejectedValue(new Error('source unavailable'));
    await useMarketplaceStore.getState().browseSource('url');
    expect(useMarketplaceStore.getState().browsedPlugins.url).toEqual([]);
    expect(useMarketplaceStore.getState().error).toBe('source unavailable');
  });

  it('exposes install in-flight state and clears it after a rejected install', async () => {
    let release!: (value: { error: string; success: false }) => void;
    vi.mocked(marketplaceApi.installPlugin).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const promise = useMarketplaceStore.getState().installPlugin('plugin', 'url');
    expect(useMarketplaceStore.getState().installingPlugin).toBe('plugin');
    release({ error: 'install failed', success: false });
    await expect(promise).resolves.toBe(false);
    expect(useMarketplaceStore.getState().installingPlugin).toBeNull();
    expect(useMarketplaceStore.getState().error).toBe('install failed');
  });

  it('preserves the installed registry view when install fails', async () => {
    const installed = {
      agents: {},
      installedAt: 'now',
      pluginId: 'plugin',
      sourceUrl: 'url',
    };
    useMarketplaceStore.setState({ installedPlugins: [installed] });
    vi.mocked(marketplaceApi.installPlugin).mockResolvedValue({
      error: 'conflict',
      success: false,
    });
    await expect(useMarketplaceStore.getState().installPlugin('plugin', 'url')).resolves.toBe(false);
    expect(useMarketplaceStore.getState().installedPlugins).toEqual([installed]);
  });
});
