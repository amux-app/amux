import { SquarePen } from 'lucide-react';
import { usePaneStore } from '../../stores';
import { SidebarNavRow } from './SidebarRow';

export const NEW_AGENT_LABEL = 'New agent';

export function SidebarCreateButton() {
  const setCreating = usePaneStore((s) => s.setCreating);

  return (
    <SidebarNavRow
      Icon={SquarePen}
      iconClassName="text-[var(--accent)]"
      label={NEW_AGENT_LABEL}
      onSelect={() => setCreating(true)}
      testId="sidebar-new-agent"
      trailing={<span className="shrink-0 text-[13px] text-[var(--sidebar-text-muted)]">⌘N</span>}
    />
  );
}
