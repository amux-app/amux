import type { ReactNode } from 'react';

/**
 * Opaque surface for tab panels that overlay a permanently mounted terminal.
 * Owns the background so panels never need to paint their own.
 */
export function TabPanelSurface({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="absolute inset-0 z-20 bg-[var(--bg)]">{children}</div>;
}
