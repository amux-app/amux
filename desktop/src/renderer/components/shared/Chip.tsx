import { cn } from '../../lib/cn';

interface ChipProps {
  label: string;
  mono?: boolean;
  dotColor?: string;
  children: React.ReactNode;
}

export function Chip({ label, mono, dotColor, children }: ChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1">
      {dotColor && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />}
      <span className="text-[8.5px] uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
      <span
        className={cn('text-[11px] font-semibold text-[var(--text)]', mono && 'font-mono')}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {children}
      </span>
    </span>
  );
}
