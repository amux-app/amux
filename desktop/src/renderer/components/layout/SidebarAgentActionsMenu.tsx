import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { AnchoredMenu } from '../shared/AnchoredMenu';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { SIDEBAR_ICON_STROKE, SIDEBAR_TOOL_CLASS } from './SidebarRow';

const ACTION_ICON_SIZE = 14;
const MENU_ICON_SIZE = 16;

const MENU_SURFACE_CLASS = cn(
  'sidebar-menu-surface min-w-[160px] rounded-[10px] p-[6px]',
  'border border-[var(--sidebar-menu-border)] bg-[var(--sidebar-menu-bg)]',
);

const MENU_ITEM_CLASS = cn(
  'sidebar-focus flex h-[30px] w-full items-center gap-[8px] rounded-[6px] px-[8px]',
  'text-left text-[13px] leading-[1.3] transition-[background-color,color] duration-100',
);

interface MenuItemProps {
  children: ReactNode;
  danger?: boolean;
  icon: ReactNode;
  onSelect: () => void;
}

function MenuItem({ children, danger = false, icon, onSelect }: Readonly<MenuItemProps>) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        MENU_ITEM_CLASS,
        danger
          ? 'text-[var(--error)] hover:bg-[var(--error)]/10'
          : 'text-[var(--sidebar-menu-text)] hover:bg-[var(--sidebar-menu-hover)]',
      )}
    >
      <span aria-hidden="true" className="inline-flex w-[16px] shrink-0 items-center justify-center">
        {icon}
      </span>
      {children}
    </button>
  );
}

interface SidebarAgentActionsMenuProps {
  deleteMessage: string;
  getDeleteFocusTarget: () => HTMLElement | null;
  name: string;
  onDelete: () => Promise<boolean>;
  onRename: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export function SidebarAgentActionsMenu({
  deleteMessage,
  getDeleteFocusTarget,
  name,
  onDelete,
  onRename,
  triggerRef,
}: Readonly<SidebarAgentActionsMenuProps>) {
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const deleteFocusTargetRef = useRef<HTMLElement | null | undefined>(undefined);
  const deleteInFlightRef = useRef(false);

  const closeMenuThen = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const openDeleteDialog = () => {
    deleteFocusTargetRef.current = undefined;
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    const focusTarget = getDeleteFocusTarget();
    // Pane-list events may remove this row before the close promise settles.
    // Preload the dialog cleanup target so that unmount still has a valid handoff.
    deleteFocusTargetRef.current = focusTarget;
    setDeleting(true);

    const deleted = await onDelete();
    deleteInFlightRef.current = false;
    setDeleting(false);
    deleteFocusTargetRef.current = deleted ? focusTarget : undefined;
    setDeleteDialogOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`Actions for ${name}`}
        onClick={() => setMenuOpen((open) => !open)}
        className={cn(
          SIDEBAR_TOOL_CLASS,
          'absolute top-[4px] right-[4px] z-10 opacity-0',
          'group-hover/agent:opacity-100 group-focus-within/agent:opacity-100',
          menuOpen && 'opacity-100',
        )}
      >
        <Ellipsis size={MENU_ICON_SIZE} strokeWidth={2} />
      </button>

      <AnchoredMenu
        className={MENU_SURFACE_CLASS}
        label={`Actions for ${name}`}
        onClose={() => setMenuOpen(false)}
        open={menuOpen}
        triggerRef={triggerRef}
      >
        <MenuItem
          icon={<Pencil size={ACTION_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />}
          onSelect={() => closeMenuThen(onRename)}
        >
          Rename
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 size={ACTION_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />}
          onSelect={() => closeMenuThen(openDeleteDialog)}
        >
          Delete
        </MenuItem>
      </AnchoredMenu>

      {createPortal(
        <ConfirmDialog
          cancelLabel="Cancel"
          confirmLabel={deleting ? 'Deleting…' : 'Delete chat'}
          danger
          initialFocus="cancel"
          message={deleteMessage}
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => void confirmDelete()}
          open={deleteDialogOpen}
          pending={deleting}
          restoreFocusTarget={() => deleteFocusTargetRef.current}
          title={`Delete “${name}”?`}
        />,
        document.body,
      )}
    </>
  );
}
