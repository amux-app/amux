import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { SettingDefinition, SettingsScope } from 'aumx/core';
import { cn } from '../../lib/cn';
import { useElectronSettingsStore, useSettingsStore, useUiStore } from '../../stores';
import type { SettingsCategory } from '../../stores/ui.store';
import { Spinner } from '../shared/Spinner';
import { AboutSettings } from './AboutSettings';
import { AdvancedSettings } from './AdvancedSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { MarketplaceSettings } from './MarketplaceSettings';
import { SettingGroup } from './SettingGroup';
import { TerminalSettings } from './TerminalSettings';
import { WindowSettings } from './WindowSettings';

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'agent', label: 'Agent' },
  { id: 'worktree', label: 'Worktree' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'window', label: 'Window' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' },
];

const AUMX_GROUPS: Record<string, string[]> = {
  agent: [
    'permissionMode', 'defaultAgent',
    'claudeModel', 'claudeEffort', 'claudeFullscreenRendering',
    'codexModel', 'codexEffort',
    'opencodeVariant', 'opencodeScrollbackMode',
    'piThinking',
  ],
  worktree: ['useWorktree', 'initGitIfMissing', 'baseBranch', 'branchPrefix'],
};

const AGENT_SECTION_ORDER = ['General', 'Claude Code', 'Codex', 'OpenCode', 'Pi'] as const;
const DEFAULT_SECTION = 'General';

const SCOPE_TABS: { id: SettingsScope; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'project', label: 'Project' },
];

function SettingsLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <p className="text-sm text-[var(--text)]">Couldn&apos;t load settings.</p>
      <p className="max-w-[420px] text-xs text-[var(--text-muted)]">{error}</p>
      <button
        onClick={onRetry}
        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Retry
      </button>
    </div>
  );
}

function bucketBySection(definitions: SettingDefinition[]): Map<string, SettingDefinition[]> {
  const buckets = new Map<string, SettingDefinition[]>();
  for (const def of definitions) {
    const section = def.section ?? DEFAULT_SECTION;
    const existing = buckets.get(section);
    if (existing) {
      existing.push(def);
    } else {
      buckets.set(section, [def]);
    }
  }
  return buckets;
}

function orderSectionEntries(buckets: Map<string, SettingDefinition[]>, preferred: readonly string[]): Array<[string, SettingDefinition[]]> {
  const knownInOrder = preferred
    .filter((name) => buckets.has(name))
    .map((name) => [name, buckets.get(name) as SettingDefinition[]] as [string, SettingDefinition[]]);
  const unknown = Array.from(buckets.entries()).filter(([name]) => !preferred.includes(name));
  return [...knownInOrder, ...unknown];
}

function AumxCoreCategory({ groupKey, title, sectionOrder }: { groupKey: string; title: string; sectionOrder?: readonly string[] }) {
  const [scope, setScope] = useState<SettingsScope>('global');
  const definitions = useSettingsStore((s) => s.definitions);
  const loadSettingDefinitions = useSettingsStore((s) => s.loadSettingDefinitions);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const isLoading = useSettingsStore((s) => s.isLoading);

  useEffect(() => {
    loadSettings();
  }, [loadSettings, scope]);

  useEffect(() => {
    loadSettingDefinitions();
  }, [loadSettingDefinitions]);

  const orderedSections = useMemo(() => {
    const keys = AUMX_GROUPS[groupKey] ?? [];
    const groupDefs = definitions.filter((d) => keys.includes(d.key));
    const buckets = bucketBySection(groupDefs);
    return orderSectionEntries(buckets, sectionOrder ?? [DEFAULT_SECTION]);
  }, [definitions, groupKey, sectionOrder]);

  const renderHeader = (
    <div className="flex items-center gap-3 mb-5">
      <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.16em]">
        {title}
      </h3>
      <div className="flex gap-1">
        {SCOPE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setScope(tab.id)}
            className={cn(
              'px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors',
              scope === tab.id
                ? 'bg-[var(--accent)] text-[var(--bg)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--surface)]',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div>
        {renderHeader}
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </div>
    );
  }

  if (orderedSections.length === 0) {
    return <div>{renderHeader}</div>;
  }

  return (
    <div>
      {renderHeader}
      <div className="flex flex-col gap-7">
        {orderedSections.map(([sectionName, settings]) => (
          <SettingGroup
            key={sectionName}
            title={sectionName}
            settings={settings}
            scope={scope}
          />
        ))}
      </div>
    </div>
  );
}

export function SettingsView() {
  const category = useUiStore((s) => s.settingsCategory);
  const setCategory = useUiStore((s) => s.setSettingsCategory);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const loadElectronSettings = useElectronSettingsStore((s) => s.load);
  const electronSettingsLoaded = useElectronSettingsStore((s) => s.settings !== null);
  const loadError = useElectronSettingsStore((s) => s.loadError);

  useEffect(() => {
    loadElectronSettings();
  }, [loadElectronSettings]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border)]">
        <button
          onClick={() => setActiveView('dashboard')}
          className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          <ArrowLeft size={14} />
          <span>Back to Dashboard</span>
        </button>
        <span className="text-[var(--border)]">|</span>
        <h2 className="text-sm font-semibold text-[var(--text)]">Settings</h2>
      </div>

      {/* Category sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Category nav */}
        <nav className="w-[160px] shrink-0 border-r border-[var(--border)] py-2 overflow-y-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id)}
              className={cn(
                'w-full text-left px-4 py-2 text-xs font-medium transition-colors',
                category === cat.id
                  ? 'text-[var(--text)] bg-[var(--surface-raised)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-raised)]/50',
              )}
            >
              {cat.label}
            </button>
          ))}
        </nav>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[860px] px-8 py-6">
            {loadError && !electronSettingsLoaded ? (
              <SettingsLoadError error={loadError} onRetry={loadElectronSettings} />
            ) : !electronSettingsLoaded ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : (
              <>
                {category === 'appearance' && <AppearanceSettings />}
                {category === 'terminal' && <TerminalSettings />}
                {category === 'agent' && <AumxCoreCategory groupKey="agent" title="Agent" sectionOrder={AGENT_SECTION_ORDER} />}
                {category === 'worktree' && <AumxCoreCategory groupKey="worktree" title="Worktree" />}
                {category === 'marketplace' && <MarketplaceSettings />}
                {category === 'window' && <WindowSettings />}
                {category === 'shortcuts' && <KeyboardShortcutsSettings />}
                {category === 'advanced' && <AdvancedSettings />}
                {category === 'about' && <AboutSettings />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
