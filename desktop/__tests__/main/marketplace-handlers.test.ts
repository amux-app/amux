import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

let registerMarketplaceHandlers: typeof import('../../src/main/ipc/marketplace.handlers').registerMarketplaceHandlers;

const secureHandleMock = vi.hoisted(() => vi.fn());
const getHeadShaMock = vi.hoisted(() => vi.fn());
const ensureCloneMock = vi.hoisted(() => vi.fn());
const pullMock = vi.hoisted(() => vi.fn());
const previewMock = vi.hoisted(() => vi.fn());
const installMock = vi.hoisted(() => vi.fn());
const integrityInstallMock = vi.hoisted(() => vi.fn());
const addInstalledMock = vi.hoisted(() => vi.fn());
const prepareAddInstalledMock = vi.hoisted(() => vi.fn());
const addSourceMock = vi.hoisted(() => vi.fn());
const updateSourceMock = vi.hoisted(() => vi.fn());
const recoverMock = vi.hoisted(() => vi.fn());
const registryConstructorMock = vi.hoisted(() => vi.fn());
const registryData = vi.hoisted(() => ({
  sources: [{
    url: 'https://example.test/marketplace.git',
    name: 'marketplace',
    clonePath: '/tmp/marketplace',
    detectedFormat: 'claude',
    headSha: 'head-1',
    lastUpdated: '2026-08-19T00:00:00.000Z',
  }],
  installed: [],
}));

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/muxbase-user-data') },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  rmSync: vi.fn(),
}));

vi.mock('muxbase/core', () => ({
  MarketplaceIntegrityError: class MarketplaceIntegrityError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly artifactPath?: string,
      readonly affectedPaths?: string[],
    ) {
      super(`${code}: ${message}`);
    }
  },
  MarketplaceRegistry: registryConstructorMock,
  MarketplaceInstaller: vi.fn(() => ({
    preview: previewMock,
    install: installMock,
  })),
  MarketplaceIntegrityInstaller: vi.fn(() => ({ install: integrityInstallMock })),
  MarketplaceTransaction: { recover: recoverMock },
  FormatDetector: vi.fn(() => ({
    detectPlugins: vi.fn(() => [{
      id: 'plugin-one',
      name: 'Plugin One',
      skills: [{ name: 'skill-one' }],
      mcpServers: [],
      agents: [],
      hooks: [],
      jsPlugins: [],
    }]),
    detectFormat: vi.fn(),
    clearDescriptionCache: vi.fn(),
  })),
  GitOperations: vi.fn(() => ({
    getHeadSha: getHeadShaMock,
    ensureClone: ensureCloneMock,
    pull: pullMock,
  })),
  isMarketplaceErrorCode: vi.fn((value: unknown) => [
    'ARTIFACT_MODIFIED',
    'CONCURRENT_MODIFICATION',
    'DESTINATION_CONFLICT',
    'INVALID_SOURCE_TREE',
    'ROLLBACK_FAILED',
    'TRANSACTION_RECOVERED',
  ].includes(String(value))),
  assertSafeCloneTarget: vi.fn(),
  deriveCloneDirName: vi.fn(() => 'marketplace'),
  getAgentsWithCapability: vi.fn((agents: unknown[]) => agents),
  getAvailableAgents: vi.fn(async () => ['claude']),
  validateSourceUrl: vi.fn(() => null),
}));

function registryStub() {
  return {
    getData: vi.fn(() => registryData),
    getInstalled: vi.fn(() => undefined),
    addSource: addSourceMock,
    updateSource: updateSourceMock,
    addInstalled: addInstalledMock,
    prepareAddInstalled: prepareAddInstalledMock,
  };
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => Promise<unknown>;
}

const request = {
  sourceUrl: 'https://example.test/marketplace.git',
  pluginId: 'plugin-one',
  mode: 'selected' as const,
  selectedSkills: ['skill-one'],
  selectedMcpServers: [],
  selectedAgents: [],
};

describe('marketplace IPC preview/install coordination', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerMarketplaceHandlers } = await import('../../src/main/ipc/marketplace.handlers'));
    secureHandleMock.mockClear();
    previewMock.mockClear();
    installMock.mockClear();
    integrityInstallMock.mockClear();
    getHeadShaMock.mockResolvedValue('head-1');
    ensureCloneMock.mockReset();
    ensureCloneMock.mockResolvedValue('head-1');
    pullMock.mockReset();
    pullMock.mockResolvedValue(undefined);
    previewMock.mockImplementation((_plugin, _agents, _nativeConfig, _selection, identity) => ({
      digest: `digest:${identity.headSha}`,
      sourceHeadSha: identity.headSha,
      introducesExecutableBehavior: false,
      agents: [],
      environmentVariableNames: [],
      generatedFiles: [],
    }));
    integrityInstallMock.mockImplementation((_plugin, _agents, _nativeConfig, _selection, _mode, options) => {
      const result = {
        agents: { claude: { status: 'full' } },
        ownershipManifest: { version: 1, transactionId: 'transaction', artifacts: [] },
        pluginId: 'plugin-one',
      };
      options.prepareRegistryMutation(result).applyInMemory();
      return result;
    });
    addInstalledMock.mockClear();
    addSourceMock.mockClear();
    updateSourceMock.mockClear();
    prepareAddInstalledMock.mockImplementation(() => ({ mutation: {}, applyInMemory: addInstalledMock }));
    prepareAddInstalledMock.mockClear();
    recoverMock.mockReset();
    recoverMock.mockReturnValue({ recovered: 0, rollbackFailures: [] });
    registryConstructorMock.mockReset();
    registryConstructorMock.mockImplementation(registryStub);
    registerMarketplaceHandlers();
  });

  it('recovers transactions before constructing the registry singleton', async () => {
    const order: string[] = [];
    recoverMock.mockImplementation(() => {
      order.push('recover');
      return { recovered: 1, rollbackFailures: [] };
    });
    registryConstructorMock.mockImplementation(() => {
      order.push('registry');
      return registryStub();
    });

    await getHandler(IPC.MARKETPLACE_SOURCES_LIST)(undefined);

    expect(order).toEqual(['recover', 'registry']);
  });

  it('blocks registry construction and returns structured integrity details when recovery fails', async () => {
    const rollbackFailures = [
      '/tmp/muxbase-user-data/marketplace-transactions/transactions/failed-one.json',
      '/tmp/muxbase-user-data/marketplace-transactions/transactions/failed-two.json',
    ];
    recoverMock.mockReturnValue({
      recovered: 1,
      rollbackFailures,
    });

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'ROLLBACK_FAILED',
      affectedPaths: rollbackFailures,
    });
    expect(registryConstructorMock).not.toHaveBeenCalled();
  });

  it('allows install when the fresh preview digest matches consent', async () => {
    const preview = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, request);
    expect(preview).toMatchObject({ success: true, preview: { digest: 'digest:head-1' } });

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });

    expect(result).toMatchObject({ success: true });
    expect(integrityInstallMock).toHaveBeenCalledWith(
      expect.anything(),
      ['claude'],
      expect.objectContaining({ pluginId: 'plugin-one' }),
      expect.objectContaining({ skills: ['skill-one'] }),
      'selected',
      expect.objectContaining({ ownershipManifest: undefined, prepareRegistryMutation: expect.any(Function) }),
    );
    expect(addInstalledMock).toHaveBeenCalledTimes(1);
    expect(prepareAddInstalledMock).toHaveBeenCalledWith(expect.objectContaining({
      selectedArtifacts: expect.objectContaining({
        agentNames: [],
        mcpServers: [],
        skills: ['skill-one'],
        usedNativeRegistration: false,
      }),
    }));
  });

  it('does not authorize a full install with a selected-mode preview digest', async () => {
    previewMock.mockImplementation((plugin, _agents, _nativeConfig, selection, identity, mode) => ({
      digest: `digest:${mode}:${JSON.stringify(selection)}:${identity.headSha}`,
      sourceHeadSha: identity.headSha,
      introducesExecutableBehavior: false,
      agents: [],
      environmentVariableNames: [],
      generatedFiles: [],
    }));

    const selectedPreview = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, request);
    expect(selectedPreview).toMatchObject({ success: true });
    if (!('preview' in selectedPreview) || !selectedPreview.preview) throw new Error('Missing selected preview');

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      mode: 'full',
      pluginId: request.pluginId,
      sourceUrl: request.sourceUrl,
      previewDigest: selectedPreview.preview.digest,
    });

    expect(result).toEqual({ success: false, error: 'Marketplace source changed; review the installation again' });
    expect(integrityInstallMock).not.toHaveBeenCalled();
    expect(addInstalledMock).not.toHaveBeenCalled();
  });

  it('propagates explicit full intent to native install and registry state', async () => {
    const fullRequest = {
      mode: 'full' as const,
      pluginId: request.pluginId,
      sourceUrl: request.sourceUrl,
    };
    const preview = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, fullRequest);
    expect(preview).toMatchObject({ success: true, preview: { digest: 'digest:head-1' } });

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...fullRequest,
      previewDigest: 'digest:head-1',
    });

    expect(result).toMatchObject({ success: true });
    expect(integrityInstallMock).toHaveBeenCalledWith(
      expect.anything(),
      ['claude'],
      expect.objectContaining({ pluginId: 'plugin-one' }),
      undefined,
      'full',
      expect.anything(),
    );
    expect(prepareAddInstalledMock).toHaveBeenCalledWith(expect.objectContaining({
      selectedArtifacts: expect.objectContaining({
        agentNames: [],
        mcpServers: [],
        skills: ['skill-one'],
        usedNativeRegistration: true,
      }),
    }));
  });

  it('returns structured source validation details when preview rejects the source tree', async () => {
    previewMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('Marketplace artifact symlink escapes source tree'), {
        artifactPath: '/tmp/marketplace/escaping-link',
        code: 'INVALID_SOURCE_TREE',
      });
    });

    const result = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, request);

    expect(result).toMatchObject({
      affectedPaths: ['/tmp/marketplace/escaping-link'],
      errorCode: 'INVALID_SOURCE_TREE',
      success: false,
    });
  });

  it('blocks later registry actions after a transaction rollback failure', async () => {
    const rollbackFailure = Object.assign(new Error('Could not restore marketplace state'), {
      code: 'ROLLBACK_FAILED',
    });
    integrityInstallMock.mockImplementationOnce(() => {
      throw rollbackFailure;
    });

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });

    expect(result).toMatchObject({ success: false, errorCode: 'ROLLBACK_FAILED' });
    expect(() => getHandler(IPC.MARKETPLACE_SOURCES_LIST)(undefined)).toThrow('Could not restore marketplace state');
  });

  it('returns a structured source-removal failure after a transaction rollback failure', async () => {
    const rollbackFailure = Object.assign(new Error('Could not restore marketplace state'), {
      code: 'ROLLBACK_FAILED',
    });
    integrityInstallMock.mockImplementationOnce(() => {
      throw rollbackFailure;
    });

    await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });

    expect(getHandler(IPC.MARKETPLACE_SOURCE_REMOVE)(undefined, {
      url: request.sourceUrl,
    })).toEqual({
      success: false,
      error: 'Could not restore marketplace state',
    });
  });

  it('does not add a source after an overlapping transaction rollback failure', async () => {
    let finishClone!: (headSha: string) => void;
    ensureCloneMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      finishClone = resolve;
    }));
    const addResult = getHandler(IPC.MARKETPLACE_SOURCE_ADD)(undefined, {
      url: 'https://example.test/new-marketplace.git',
    });
    const rollbackFailure = Object.assign(new Error('Could not restore marketplace state'), {
      code: 'ROLLBACK_FAILED',
    });
    integrityInstallMock.mockImplementationOnce(() => {
      throw rollbackFailure;
    });

    await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });
    finishClone('head-2');

    await expect(addResult).resolves.toEqual({
      success: false,
      error: 'Could not restore marketplace state',
    });
    expect(addSourceMock).not.toHaveBeenCalled();
  });

  it('does not update a source after an overlapping transaction rollback failure', async () => {
    let finishPull!: () => void;
    pullMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPull = resolve;
    }));
    const updateResult = getHandler(IPC.MARKETPLACE_SOURCE_UPDATE)(undefined, {
      url: request.sourceUrl,
    });
    await vi.waitFor(() => expect(pullMock).toHaveBeenCalledTimes(1));
    const rollbackFailure = Object.assign(new Error('Could not restore marketplace state'), {
      code: 'ROLLBACK_FAILED',
    });
    integrityInstallMock.mockImplementationOnce(() => {
      throw rollbackFailure;
    });

    await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });
    finishPull();

    await expect(updateResult).resolves.toEqual({
      success: false,
      error: 'Could not restore marketplace state',
    });
    expect(updateSourceMock).not.toHaveBeenCalled();
  });

  it('rejects a changed source before installer or registry mutation', async () => {
    const preview = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, request);
    expect(preview).toMatchObject({ success: true, preview: { digest: 'digest:head-1' } });
    getHeadShaMock.mockResolvedValue('head-2');

    const result = await getHandler(IPC.MARKETPLACE_INSTALL)(undefined, {
      ...request,
      previewDigest: 'digest:head-1',
    });

    expect(result).toEqual({ success: false, error: 'Marketplace source changed; review the installation again' });
    expect(integrityInstallMock).not.toHaveBeenCalled();
    expect(addInstalledMock).not.toHaveBeenCalled();
  });

  it('propagates explicit full intent without selection data', async () => {
    const preview = await getHandler(IPC.MARKETPLACE_PREVIEW)(undefined, {
      mode: 'full',
      sourceUrl: request.sourceUrl,
      pluginId: request.pluginId,
    });

    expect(previewMock).toHaveBeenCalledWith(
      expect.anything(),
      ['claude'],
      expect.anything(),
      undefined,
      expect.objectContaining({ headSha: 'head-1' }),
      'full',
    );
    expect(preview).toMatchObject({ success: true });
  });
});
