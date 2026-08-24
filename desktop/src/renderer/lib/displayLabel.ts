export interface ShortLabel {
  text: string;
  truncated: boolean;
}

export function firstSegments(value: string, maxSegments: number): ShortLabel {
  const trimmed = value.trim();
  const segments = trimmed.match(/[^\s\-_]+(?:[\s\-_]+|$)/g) ?? [];
  if (segments.length <= maxSegments) return { text: trimmed, truncated: false };
  const text = segments.slice(0, maxSegments).join('').replace(/[\s\-_]+$/, '');
  return { text, truncated: true };
}
