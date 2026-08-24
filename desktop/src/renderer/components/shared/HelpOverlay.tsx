import { useId, useRef } from 'react';
import { getShortcutGroups } from '../../lib/feature-flags';
import { useElectronSettingsStore, useUiStore } from '../../stores';
import { Kbd } from './Kbd';
import { ModalSurface, type ModalMotionPreset } from './ModalSurface';

const PANEL_CLASS = 'w-full max-w-[420px] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-2xl overflow-hidden';
const PANEL_MOTION: ModalMotionPreset = {
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: -10 },
  initial: { opacity: 0, scale: 0.95, y: -10 },
};

export function HelpOverlay() {
  const isOpen = useUiStore((s) => s.helpOverlayOpen);
  const close = useUiStore((s) => s.toggleHelpOverlay);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const shortcutGroups = getShortcutGroups(electronSettings);
  const titleId = useId();
  const titleRef = useRef<HTMLSpanElement>(null);

  return (
    <ModalSurface
      closeOnBackdropClick
      initialFocusRef={titleRef}
      labelledBy={titleId}
      onClose={close}
      open={isOpen}
      panelClassName={PANEL_CLASS}
      panelMotion={PANEL_MOTION}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span ref={titleRef} id={titleId} tabIndex={-1} className="text-sm font-medium text-[var(--text)]">
          Keyboard Shortcuts
        </span>
        <Kbd keys="?" className="opacity-60" />
      </div>

      <div className="px-4 py-3 space-y-4 max-h-[50vh] overflow-y-auto">
        {shortcutGroups.map((group) => (
          <div key={group.label}>
            <h4 className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wider mb-1.5">
              {group.label}
            </h4>
            <div className="space-y-0.5">
              {group.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.keys}
                  className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-[var(--surface)]"
                >
                  <span className="text-xs text-[var(--text-secondary)]">{shortcut.action}</span>
                  <Kbd keys={shortcut.keys} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-2.5 border-t border-[var(--border)] text-center">
        <span className="text-[10px] text-[var(--text-secondary)]">
          Press <Kbd keys="Esc" className="mx-0.5" /> or click outside to close
        </span>
      </div>
    </ModalSurface>
  );
}
