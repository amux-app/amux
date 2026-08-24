import { cn } from '../../lib/cn';

const SIZE_MAP = {
  xs: 'h-3.5 w-3.5 border-[1.5px]',
  sm: 'h-4 w-4 border-[1.5px]',
  md: 'h-5 w-5 border-2',
  lg: 'h-6 w-6 border-2',
} as const;

interface SpinnerProps {
  size?: 'lg' | 'md' | 'sm' | 'xs';
  className?: string;
}

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block rounded-full border-[var(--border)] border-t-[var(--accent)] animate-spin',
        SIZE_MAP[size],
        className,
      )}
    />
  );
}
