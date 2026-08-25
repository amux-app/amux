import type { SettingDefinition, SettingsScope } from 'muxbase/core';
import { AgentBrandIcon, hasIcon } from '../shared/agent-brand-icons';
import { SettingRow } from './SettingRow';

interface SettingGroupProps {
  title: string;
  settings: SettingDefinition[];
  scope: SettingsScope;
}

const SECTION_ICON_AGENT: Record<string, string> = {
  'Claude Code': 'claude',
  'Codex': 'codex',
  'OpenCode': 'opencode',
  'Pi': 'pi',
};

export function SettingGroup({ title, settings, scope }: SettingGroupProps) {
  if (settings.length === 0) return null;
  const agentKey = SECTION_ICON_AGENT[title];
  return (
    <section>
      {title && (
        <h4 className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.16em] mb-2">
          {agentKey && hasIcon(agentKey) && (
            <AgentBrandIcon agent={agentKey} size="sm" className="opacity-70" />
          )}
          <span>{title}</span>
        </h4>
      )}
      <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
        {settings.map((def) => (
          <SettingRow key={def.key} definition={def} scope={scope} />
        ))}
      </div>
    </section>
  );
}
