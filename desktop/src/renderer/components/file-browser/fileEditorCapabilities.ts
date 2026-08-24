export type FileEditorCapabilityTier = 'full' | 'reduced' | 'read-only';

export const FILE_EDITOR_CAPABILITY_THRESHOLDS = {
  full: {
    maxBytes: 150_000,
    maxLineCount: 10_000,
    maxLineLength: 20_000,
  },
  reduced: {
    maxBytes: 1024 * 1024,
    maxLineCount: 100_000,
    maxLineLength: 200_000,
  },
} as const;

function documentShape(content: string): { lineCount: number; maxLineLength: number } {
  let lineCount = 1;
  let lineLength = 0;
  let maxLineLength = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 0x0a || character === 0x0d) {
      maxLineLength = Math.max(maxLineLength, lineLength);
      lineLength = 0;
      lineCount += 1;
      if (character === 0x0d && content.charCodeAt(index + 1) === 0x0a) index += 1;
    } else {
      lineLength += 1;
    }
  }
  return { lineCount, maxLineLength: Math.max(maxLineLength, lineLength) };
}

export function getFileEditorCapabilityTier(
  content: string,
  sizeBytes: number,
): FileEditorCapabilityTier {
  const shape = documentShape(content);
  if (
    sizeBytes > FILE_EDITOR_CAPABILITY_THRESHOLDS.reduced.maxBytes
    || shape.lineCount > FILE_EDITOR_CAPABILITY_THRESHOLDS.reduced.maxLineCount
    || shape.maxLineLength > FILE_EDITOR_CAPABILITY_THRESHOLDS.reduced.maxLineLength
  ) return 'read-only';
  if (
    sizeBytes > FILE_EDITOR_CAPABILITY_THRESHOLDS.full.maxBytes
    || shape.lineCount > FILE_EDITOR_CAPABILITY_THRESHOLDS.full.maxLineCount
    || shape.maxLineLength > FILE_EDITOR_CAPABILITY_THRESHOLDS.full.maxLineLength
  ) return 'reduced';
  return 'full';
}
