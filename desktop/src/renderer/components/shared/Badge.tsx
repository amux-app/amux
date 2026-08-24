import { cn } from '../../lib/cn';
import { AGENT_STYLES } from '../../lib/constants';
import { AgentBrandIcon, isBrandedAgentName } from './agent-brand-icons';

interface BadgeProps {
  label: string;
  variant?: 'default' | 'outline';
  className?: string;
}

export function Badge({ label, variant = 'default', className }: BadgeProps) {
  const key = label.toLowerCase();
  const agentStyle = AGENT_STYLES[key];
  const showBrand = isBrandedAgentName(key);

  return (
    <span
      aria-label={showBrand ? label : undefined}
      role={showBrand ? 'img' : undefined}
      title={showBrand ? label : undefined}
      className={cn(
        'inline-flex items-center rounded-full capitalize leading-none',
        agentStyle
          ? 'border border-[var(--divider-strong)] py-0.5 px-2 text-[10px] font-semibold tracking-wide text-[var(--text-secondary)]'
          : variant === 'outline'
            ? 'gap-1 border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium tracking-wide text-[var(--text-secondary)]'
            : 'gap-1 bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium tracking-wide text-[var(--text-secondary)]',
        className,
      )}
    >
      {showBrand ? (
        <span
          className="flex shrink-0 items-center justify-center"
          style={{ color: agentStyle?.text }}
          aria-hidden
        >
          <AgentBrandIcon agent={key} size="sm" />
        </span>
      ) : (
        label
      )}
    </span>
  );
}
