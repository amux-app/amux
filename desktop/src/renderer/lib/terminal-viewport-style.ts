export const TERMINAL_TOP_INSET_PX = 6;

interface TerminalElementHost {
  element: HTMLElement | null | undefined;
}

export function applyTerminalViewportStyle(
  terminal: TerminalElementHost,
  backgroundColor: string,
): void {
  const { element } = terminal;
  if (!element) return;

  element.style.backgroundColor = backgroundColor;
  element.style.paddingTop = `${TERMINAL_TOP_INSET_PX}px`;
}
