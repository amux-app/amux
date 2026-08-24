import { BookOpen, ChevronDown, Package, Plug, Server, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useMarketplaceBootstrap } from '../../hooks/useMarketplaceBootstrap';
import { cn } from '../../lib/cn';
import { useUiStore } from '../../stores';
import { aggregateMarketplaceCounts, useMarketplaceStore, type MarketplaceCounts, type MarketplaceFilter } from '../../stores/marketplace.store';
import { Spinner } from '../shared/Spinner';
import { SIDEBAR_ICON_SIZE, SIDEBAR_ICON_STROKE, SIDEBAR_ROW_SELECTED_CLASS, SIDEBAR_UI_FONT_CLASS } from './SidebarRow';

const MARKETPLACE_CATEGORIES: ReadonlyArray<{
  id: MarketplaceFilter;
  label: string;
  Icon: LucideIcon;
  count: (counts: MarketplaceCounts) => number;
}> = [
  { id: 'skills', label: 'Skills', Icon: Sparkles, count: (c) => c.skills },
  { id: 'agents', label: 'Instructions', Icon: BookOpen, count: (c) => c.agents },
  { id: 'hooks', label: 'Hooks', Icon: Zap, count: (c) => c.hooks },
  { id: 'mcp', label: 'MCP Servers', Icon: Server, count: (c) => c.mcpServers },
  { id: 'plugins', label: 'Plugins', Icon: Plug, count: (c) => c.jsPlugins },
];

// Kept in sync with the h-[30px] row height below — Tailwind's scanner needs
// the class written as a literal, so this only drives the inline tree-line math.
const TREE_ROW_HEIGHT = 30;
const TREE_LINE_INSET = 15;
const TREE_ROW_CLASS = cn(
  'sidebar-focus relative flex h-[30px] w-full items-center gap-[8px] rounded-[8px] pl-[28px] pr-[8px]',
  'text-left text-[13px] leading-[1.3]',
  'transition-colors duration-150',
);

export function SidebarMarketplaceSection() {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  useMarketplaceBootstrap();

  const sources = useMarketplaceStore((s) => s.sources);
  const browsedPlugins = useMarketplaceStore((s) => s.browsedPlugins);
  const activeFilter = useMarketplaceStore((s) => s.activeFilter);
  const setActiveFilter = useMarketplaceStore((s) => s.setActiveFilter);
  const activeView = useUiStore((s) => s.activeView);
  const settingsCategory = useUiStore((s) => s.settingsCategory);
  const openSettings = useUiStore((s) => s.openSettings);

  const counts = useMemo(() => aggregateMarketplaceCounts(browsedPlugins), [browsedPlugins]);
  // At least one added source hasn't finished being browsed yet — the totals
  // below are still incomplete, so rows show a spinner instead of a misleading 0.
  const isBrowsing = sources.some((source) => !(source.url in browsedPlugins));
  const onMarketplaceSettings = activeView === 'settings' && settingsCategory === 'marketplace';

  const handleSelectCategory = (id: MarketplaceFilter) => {
    setActiveFilter(id);
    openSettings('marketplace');
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={expanded}
        data-testid="sidebar-marketplace-tree-toggle"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'sidebar-focus flex h-[32px] w-full items-center gap-[8px] rounded-[8px] px-[8px]',
          'text-left text-[15px] leading-[1.3] text-[var(--sidebar-text)]',
          'transition-colors duration-150 hover:bg-[var(--sidebar-hover)]',
          onMarketplaceSettings && 'bg-[var(--sidebar-hover)]',
          SIDEBAR_UI_FONT_CLASS,
        )}
      >
        <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[var(--sidebar-nav-icon)]">
          <Package size={SIDEBAR_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
        </span>
        <span className="min-w-0 flex-1 truncate">Marketplace</span>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn('shrink-0 text-[var(--sidebar-icon)] transition-transform duration-150', expanded && 'rotate-180')}
        />
      </button>

      <div
        id={contentId}
        aria-hidden={!expanded}
        inert={!expanded}
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div data-testid="sidebar-marketplace-tree" className="relative mt-[2px] flex flex-col gap-[1px]">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute w-px bg-[var(--sidebar-icon)]/35"
              style={{ left: TREE_LINE_INSET, top: 0, bottom: TREE_ROW_HEIGHT / 2 }}
            />
            {MARKETPLACE_CATEGORIES.map((category) => {
              const selected = onMarketplaceSettings && activeFilter === category.id;
              const count = category.count(counts);
              return (
                <div key={category.id} className="relative">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute h-px w-[10px] -translate-y-1/2 bg-[var(--sidebar-icon)]/35"
                    style={{ left: TREE_LINE_INSET, top: '50%' }}
                  />
                  <button
                    type="button"
                    data-testid={`sidebar-marketplace-tree-item-${category.id}`}
                    onClick={() => handleSelectCategory(category.id)}
                    className={cn(
                      TREE_ROW_CLASS,
                      SIDEBAR_UI_FONT_CLASS,
                      selected
                        ? SIDEBAR_ROW_SELECTED_CLASS
                        : 'text-[var(--sidebar-text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text)]',
                    )}
                  >
                    <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center">
                      <category.Icon size={SIDEBAR_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{category.label}</span>
                    <span className="flex h-[16px] shrink-0 items-center justify-end">
                      {isBrowsing ? (
                        <Spinner size="xs" />
                      ) : (
                        <span className={cn('tabular-nums text-[12px]', count === 0 && 'opacity-50')}>
                          {count.toLocaleString()}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
