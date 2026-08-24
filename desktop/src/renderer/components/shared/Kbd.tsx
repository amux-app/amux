import { cn } from '../../lib/cn';

interface KbdProps {
  keys: string;
  className?: string;
}

export function Kbd({ keys, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded',
        'bg-[var(--surface)] border border-[var(--border)]',
        'text-[11px] font-mono text-[var(--text-muted)] leading-none',
        className,
      )}
    >
      {keys}
    </kbd>
  );
}
