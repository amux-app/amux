export const PANE_NAME_MAX_LENGTH = 80;

const PANE_NAME_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type PaneNameValidationResult =
  | { ok: true; value: string }
  | { message: string; ok: false };

/** Normalize and validate every user-supplied pane display name. */
export function validatePaneName(name: string | undefined): PaneNameValidationResult {
  const value = name?.trim();
  if (!value) {
    return { message: 'No name provided', ok: false };
  }
  if (value.length > PANE_NAME_MAX_LENGTH) {
    return {
      message: `Name must be ${PANE_NAME_MAX_LENGTH} characters or fewer`,
      ok: false,
    };
  }
  if (PANE_NAME_CONTROL_CHARACTER_PATTERN.test(value)) {
    return { message: 'Name cannot contain control characters', ok: false };
  }
  return { ok: true, value };
}
