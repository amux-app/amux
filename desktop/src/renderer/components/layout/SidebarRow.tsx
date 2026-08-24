import type { LucideIcon } from 'lucide-react';
import type { AriaAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Codex's own system stack. Nav and footer rows only — agent names stay mono. */
export const SIDEBAR_UI_FONT_CLASS = 'sidebar-ui-font';

export const SIDEBAR_ICON_SIZE = 16;
export const SIDEBAR_ICON_STROKE = 1.5;

export const SIDEBAR_ROW_CLASS = cn(
  'sidebar-focus flex h-[32px] w-full items-center gap-[8px] rounded-[8px] px-[8px]',
  'text-left text-[15px] leading-[1.3] text-[var(--sidebar-text)]',
  'transition-[background-color,color] duration-150 hover:bg-[var(--sidebar-hover)]',
);

/** Selection out-specifies hover in the mock, so the pill holds its colour under the pointer. */
export const SIDEBAR_ROW_SELECTED_CLASS = cn(
  'bg-[var(--sidebar-selected)] text-[var(--sidebar-text-selected)]',
  'hover:bg-[var(--sidebar-selected)]',
);

export const SIDEBAR_CHROME_ICON_CLASS = cn(
  'sidebar-focus inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]',
  'text-[var(--sidebar-icon)] transition-[background-color,color] duration-150',
  'hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text)]',
);

export const SIDEBAR_TOOL_CLASS = cn(
  'sidebar-focus inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px]',
  'text-[var(--sidebar-text-muted)] transition-[background-color,color] duration-150',
  'hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text)]',
);

const SIDEBAR_ROW_ICON_CLASS =
  'flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[var(--sidebar-nav-icon)]';

interface SidebarNavRowProps {
  Icon: LucideIcon;
  label: string;
  onSelect: () => void;
  ariaCurrent?: AriaAttributes['aria-current'];
  ariaPressed?: AriaAttributes['aria-pressed'];
  iconClassName?: string;
  testId?: string;
  trailing?: ReactNode;
}

/**
 * Action rows never carry a resting background: the selected pill belongs to the
 * agent list alone. Active state stays semantic, via aria-current/aria-pressed.
 */
export function SidebarNavRow({
  Icon,
  ariaCurrent,
  ariaPressed,
  iconClassName,
  label,
  onSelect,
  testId,
  trailing,
}: Readonly<SidebarNavRowProps>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      aria-current={ariaCurrent}
      aria-pressed={ariaPressed}
      className={cn(SIDEBAR_ROW_CLASS, SIDEBAR_UI_FONT_CLASS)}
    >
      <span className={cn(SIDEBAR_ROW_ICON_CLASS, iconClassName)}>
        <Icon size={SIDEBAR_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
