import { cn } from '../../lib/cn';

interface ToggleSwitchProps {
  ariaLabel?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
}

export function ToggleSwitch({ ariaLabel, checked, disabled, onChange, size = 'md' }: ToggleSwitchProps) {
  const trackSize = size === 'sm' ? 'h-[18px] w-8' : 'h-5 w-10';
  const thumbSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const thumbTranslate = size === 'sm' ? 'translate-x-3.5' : 'translate-x-5';

  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50',
        trackSize,
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--border)]',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out',
          thumbSize,
          checked && thumbTranslate,
        )}
      />
    </button>
  );
}
