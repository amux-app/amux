// Barrel for the staged UI-mockup overlay builders. Each overlay paints a
// DOM-only reproduction of real app chrome (terminal, focus panel,
// marketplace, review flow, file browser, provider health, create dialog)
// so the recordings never depend on live agent processes.
export * from './overlays/file-browser';
export * from './overlays/focus-panel';
export * from './overlays/layout';
export * from './overlays/marketplace';
export * from './overlays/misc';
export * from './overlays/review';
export * from './overlays/terminal';
