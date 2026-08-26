import type { InstalledPlugin, MarketplaceSource } from 'muxbase/core';
import { IPC } from '../../shared/ipc-channels';
import type {
  MarketplaceBrowseResponse,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplacePreviewRequest,
  MarketplacePreviewResponse,
  MarketplaceSourceAddResponse,
  MarketplaceUninstallResponse,
} from '../../shared/ipc-types';
import { invoke } from './ipc';

export function listSources(): Promise<MarketplaceSource[]> {
  return invoke<MarketplaceSource[]>(IPC.MARKETPLACE_SOURCES_LIST);
}

export function addSource(url: string): Promise<MarketplaceSourceAddResponse> {
  return invoke<MarketplaceSourceAddResponse>(IPC.MARKETPLACE_SOURCE_ADD, { url });
}

export function removeSource(url: string): Promise<{ success: boolean; error?: string }> {
  return invoke<{ success: boolean; error?: string }>(IPC.MARKETPLACE_SOURCE_REMOVE, { url });
}

export function updateSource(url: string): Promise<{ success: boolean; error?: string }> {
  return invoke<{ success: boolean; error?: string }>(IPC.MARKETPLACE_SOURCE_UPDATE, { url });
}

export function browseSource(sourceUrl: string): Promise<MarketplaceBrowseResponse> {
  return invoke<MarketplaceBrowseResponse>(IPC.MARKETPLACE_BROWSE, { sourceUrl });
}

export function installPlugin(request: MarketplaceInstallRequest): Promise<MarketplaceInstallResponse> {
  return invoke<MarketplaceInstallResponse>(IPC.MARKETPLACE_INSTALL, request);
}

export function previewPlugin(request: MarketplacePreviewRequest): Promise<MarketplacePreviewResponse> {
  return invoke<MarketplacePreviewResponse>(IPC.MARKETPLACE_PREVIEW, request);
}

export function uninstallPlugin(pluginId: string, sourceUrl: string): Promise<MarketplaceUninstallResponse> {
  return invoke<MarketplaceUninstallResponse>(IPC.MARKETPLACE_UNINSTALL, { pluginId, sourceUrl });
}

export function listInstalled(): Promise<InstalledPlugin[]> {
  return invoke<InstalledPlugin[]>(IPC.MARKETPLACE_INSTALLED_LIST);
}
