import { useEffect } from 'react';
import { useMarketplaceStore } from '../stores/marketplace.store';

/**
 * Ensures marketplace sources and their plugin listings are loaded.
 * Shared by every surface that needs live marketplace data (Settings tab,
 * sidebar tree) so sources are only ever browsed once per session.
 */
export function useMarketplaceBootstrap(): void {
  const sources = useMarketplaceStore((s) => s.sources);
  const browsedPlugins = useMarketplaceStore((s) => s.browsedPlugins);
  const loadSources = useMarketplaceStore((s) => s.loadSources);
  const loadInstalled = useMarketplaceStore((s) => s.loadInstalled);
  const browseSource = useMarketplaceStore((s) => s.browseSource);

  useEffect(() => {
    loadSources();
    loadInstalled();
  }, [loadSources, loadInstalled]);

  useEffect(() => {
    for (const source of sources) {
      if (!(source.url in browsedPlugins)) browseSource(source.url);
    }
  }, [browseSource, browsedPlugins, sources]);
}
