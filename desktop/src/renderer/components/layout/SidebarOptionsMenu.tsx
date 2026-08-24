import { Check } from 'lucide-react';
import { useId, type RefObject } from 'react';
import type { SidebarOrganize, SidebarSort } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { AnchoredMenu } from '../shared/AnchoredMenu';

const CHECK_ICON_SIZE = 14;
const CHECK_ICON_STROKE = 2.2;

const MENU_SURFACE_CLASS = cn(
  'sidebar-menu-surface min-w-[208px] rounded-[10px] p-[6px]',
  'border border-[var(--sidebar-menu-border)] bg-[var(--sidebar-menu-bg)]',
);

const MENU_GROUP_LABEL_CLASS =
  'px-[10px] pt-[6px] pb-[4px] pl-[14px] text-[12px] leading-[1.2] text-[var(--sidebar-menu-label)]';

const MENU_ITEM_CLASS = cn(
  'sidebar-focus flex h-[30px] w-full items-center gap-[6px] rounded-[6px] pr-[10px] pl-[8px]',
  'text-left text-[14px] leading-[1.3] text-[var(--sidebar-menu-text)]',
  'transition-[background-color] duration-100 hover:bg-[var(--sidebar-menu-hover)]',
);

const ORGANIZE_OPTIONS: ReadonlyArray<{ label: string; value: SidebarOrganize }> = [
  { label: 'By project', value: 'project' },
  { label: 'In one list', value: 'flat' },
];

const SORT_OPTIONS: ReadonlyArray<{ label: string; value: SidebarSort }> = [
  { label: 'Priority', value: 'priority' },
  { label: 'Last active', value: 'updated' },
  { label: 'Creation order', value: 'manual' },
];

interface RadioItemProps {
  checked: boolean;
  label: string;
  onSelect: () => void;
}

function RadioItem({ checked, label, onSelect }: Readonly<RadioItemProps>) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} onClick={onSelect} className={MENU_ITEM_CLASS}>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex w-[18px] shrink-0 items-center justify-center text-[var(--sidebar-menu-check)]',
          !checked && 'opacity-0',
        )}
      >
        <Check size={CHECK_ICON_SIZE} strokeWidth={CHECK_ICON_STROKE} />
      </span>
      {label}
    </button>
  );
}

interface SidebarOptionsMenuProps {
  onClose: () => void;
  onOrganizeChange: (value: SidebarOrganize) => void;
  onSortChange: (value: SidebarSort) => void;
  open: boolean;
  organize: SidebarOrganize;
  sort: SidebarSort;
  triggerRef: RefObject<HTMLElement | null>;
}

export function SidebarOptionsMenu({
  onClose,
  onOrganizeChange,
  onSortChange,
  open,
  organize,
  sort,
  triggerRef,
}: Readonly<SidebarOptionsMenuProps>) {
  const baseId = useId();
  const organizeLabelId = `${baseId}-organize`;
  const sortLabelId = `${baseId}-sort`;

  return (
    <AnchoredMenu
      className={MENU_SURFACE_CLASS}
      label="Sidebar options"
      onClose={onClose}
      open={open}
      triggerRef={triggerRef}
    >
      <div role="group" aria-labelledby={organizeLabelId}>
        <div className={MENU_GROUP_LABEL_CLASS} id={organizeLabelId}>Organize sidebar</div>
        {ORGANIZE_OPTIONS.map((option) => (
          <RadioItem
            key={option.value}
            checked={organize === option.value}
            label={option.label}
            onSelect={() => { onOrganizeChange(option.value); onClose(); }}
          />
        ))}
      </div>
      <div role="group" aria-labelledby={sortLabelId}>
        <div className={MENU_GROUP_LABEL_CLASS} id={sortLabelId}>Sort agents by</div>
        {SORT_OPTIONS.map((option) => (
          <RadioItem
            key={option.value}
            checked={sort === option.value}
            label={option.label}
            onSelect={() => { onSortChange(option.value); onClose(); }}
          />
        ))}
      </div>
    </AnchoredMenu>
  );
}
