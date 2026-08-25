const HOOK_EDIT_ACTIONS = ['create', 'edit', 'modify'] as const;

/** Detect prompts that should receive the editable hooks scaffold. */
export function isHooksEditingPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('.muxbase-hooks')) return true;

  return HOOK_EDIT_ACTIONS.some((action) => {
    const actionIndex = normalized.indexOf(action);
    return actionIndex !== -1 && normalized.indexOf('hooks', actionIndex + action.length) !== -1;
  });
}
