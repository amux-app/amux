export interface ContentSize {
  height: number;
  width: number;
}

export function validateAppliedContentSize(
  requested: ContentSize,
  applied: readonly number[] | null,
  minimumHeight: number,
): ContentSize {
  const width = applied?.[0];
  const height = applied?.[1];
  const received = Number.isFinite(width) && Number.isFinite(height)
    ? `${width}x${height}`
    : 'no application window';

  if (width !== requested.width || typeof height !== 'number' || height < minimumHeight) {
    throw new Error(
      `Unable to resize Electron content to ${requested.width}x${requested.height}; `
      + `received ${received}. The E2E viewport requires exactly ${requested.width}px of content width `
      + `and at least ${minimumHeight}px of content height.`,
    );
  }

  return { width, height };
}
