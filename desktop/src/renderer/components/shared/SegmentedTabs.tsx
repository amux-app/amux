import { motion } from 'motion/react';
import { cn } from '../../lib/cn';

export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
}

interface SegmentedTabsProps<T extends string> {
  items: readonly SegmentedTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  layoutId: string;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  layoutId,
  className,
}: SegmentedTabsProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={active}
            onClick={(e) => { e.stopPropagation(); onChange(item.id); }}
            className={cn(
              'relative rounded-md px-3 py-1.5 text-[10px] font-medium transition-colors',
              active
                ? 'text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            {item.label}
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-2 -bottom-0.5 h-[1.5px] rounded-full bg-[var(--accent)]"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
