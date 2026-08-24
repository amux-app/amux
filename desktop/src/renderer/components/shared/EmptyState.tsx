import { cn } from '../../lib/cn';

export const CTA_STYLE = {
  borderPercent: 25,
  fadePercent: 6,
  fillPercent: 12,
  hoverPercent: 8,
  labelTintPercent: 70,
} as const;

function accentMix(percent: number): string {
  return `color-mix(in srgb, var(--accent) ${percent}%, transparent)`;
}

// --text is light on dark themes and dark on light ones, so shifting the accent
// toward it always moves the label away from the accent-tinted button surface.
export const CTA_LABEL_COLOR = `color-mix(in srgb, var(--accent) ${CTA_STYLE.labelTintPercent}%, var(--text))`;

interface EmptyStateProps {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
  secondaryAction?: string;
  onSecondaryAction?: () => void;
  className?: string;
}

export function EmptyState({ title, description, action, onAction, secondaryAction, onSecondaryAction, className }: Readonly<EmptyStateProps>) {
  return (
    <div className={cn('relative flex flex-col items-center justify-center h-full w-full overflow-hidden', className)}>
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-1/2 left-1/2 w-[600px] h-[600px] rounded-full"
          style={{
            background: 'radial-gradient(circle, var(--accent) 0%, transparent 70%)',
            animation: 'orb-float 6s ease-in-out infinite',
          }}
        />
        <div
          className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full opacity-[0.04]"
          style={{ background: 'radial-gradient(circle, var(--agent-working) 0%, transparent 70%)' }}
        />
      </div>

      <div className="relative flex flex-col items-center gap-6 max-w-sm text-center px-6">
        <div className="flex flex-col items-center gap-2">
          <span
            className="text-[72px] font-bold tracking-[-0.04em] leading-none select-none"
            style={{
              background: 'linear-gradient(135deg, var(--text) 0%, var(--text-secondary) 60%, var(--accent) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              fontFamily: "'Inter', sans-serif",
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Amux
          </span>
          <p
            className="text-[13px] font-normal tracking-[0.18em] uppercase"
            style={{ color: 'var(--text-secondary)', letterSpacing: '0.2em' }}
          >
            Multi-agent terminal
          </p>
        </div>

        <div
          className="w-px h-8 mx-auto"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--border), transparent)' }}
        />

        <div className="flex flex-col items-center gap-1">
          <p className="text-[13px] text-[var(--text-secondary)] font-medium">{title}</p>
          <p className="text-[12px] text-[var(--text-secondary)]">{description}</p>
        </div>

        {action && onAction && (
          <div className="flex items-center gap-2">
            <button
              onClick={onAction}
              className="group relative px-6 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-200 overflow-hidden"
              style={{
                background: `linear-gradient(135deg, ${accentMix(CTA_STYLE.fillPercent)} 0%, ${accentMix(CTA_STYLE.fadePercent)} 100%)`,
                border: `1px solid ${accentMix(CTA_STYLE.borderPercent)}`,
                color: CTA_LABEL_COLOR,
              }}
            >
              <span
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                style={{ background: accentMix(CTA_STYLE.hoverPercent) }}
              />
              <span className="relative">{action}</span>
            </button>
            {secondaryAction && onSecondaryAction && (
              <button
                onClick={onSecondaryAction}
                className="px-4 py-2.5 rounded-lg text-[12px] font-medium transition-all duration-200 text-[var(--text-secondary)] hover:text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-raised)]"
              >
                {secondaryAction}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
