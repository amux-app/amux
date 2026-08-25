import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Locator, Page } from 'playwright';

const BASELINE_DIR = resolve(__dirname, 'visual-baselines');
const FAILURE_DIR = resolve(__dirname, '..', '..', 'out', 'visual-regression');
const CHANNEL_TOLERANCE = 24;
const MAX_CHANGED_PIXEL_RATIO = 0.01;
// Chromium's macOS software/GPU paths can produce a small full-frame delta for
// identical gradients and antialiased text. Keep enough headroom for the
// observed runner variance while the changed-pixel budget guards local changes.
const MAX_MEAN_CHANNEL_DELTA = 2;

export interface VisualDiff {
  actualHeight: number;
  actualWidth: number;
  baselineHeight: number;
  baselineWidth: number;
  changedPixelRatio: number;
  meanChannelDelta: number;
}

export function assertVisualDiff(name: string, diff: VisualDiff): void {
  if (diff.actualWidth !== diff.baselineWidth || diff.actualHeight !== diff.baselineHeight) {
    throw new Error(
      `${name} dimensions changed: expected ${diff.baselineWidth}x${diff.baselineHeight}, `
      + `received ${diff.actualWidth}x${diff.actualHeight}`,
    );
  }

  if (diff.changedPixelRatio > MAX_CHANGED_PIXEL_RATIO) {
    throw new Error(
      `${name} changed pixels ${(diff.changedPixelRatio * 100).toFixed(2)}% exceed `
      + `${(MAX_CHANGED_PIXEL_RATIO * 100).toFixed(2)}%`,
    );
  }

  if (diff.meanChannelDelta > MAX_MEAN_CHANNEL_DELTA) {
    throw new Error(
      `${name} mean channel delta ${diff.meanChannelDelta.toFixed(2)} exceeds `
      + MAX_MEAN_CHANNEL_DELTA.toFixed(2),
    );
  }
}

async function measureVisualDiff(
  page: Page,
  actualPng: Buffer,
  baselinePng: Buffer,
): Promise<VisualDiff> {
  return page.evaluate(async ({ actual, baseline, channelTolerance }) => {
    const decode = async (base64: string): Promise<HTMLImageElement> => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      return image;
    };
    const pixels = (image: HTMLImageElement): Uint8ClampedArray => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Visual regression canvas is unavailable');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    const [actualImage, baselineImage] = await Promise.all([
      decode(actual),
      decode(baseline),
    ]);
    const dimensionsMatch = actualImage.naturalWidth === baselineImage.naturalWidth
      && actualImage.naturalHeight === baselineImage.naturalHeight;
    if (!dimensionsMatch) {
      return {
        actualHeight: actualImage.naturalHeight,
        actualWidth: actualImage.naturalWidth,
        baselineHeight: baselineImage.naturalHeight,
        baselineWidth: baselineImage.naturalWidth,
        changedPixelRatio: 1,
        meanChannelDelta: 255,
      };
    }

    const actualPixels = pixels(actualImage);
    const baselinePixels = pixels(baselineImage);
    let changedPixels = 0;
    let channelDelta = 0;
    for (let offset = 0; offset < actualPixels.length; offset += 4) {
      const red = Math.abs(actualPixels[offset] - baselinePixels[offset]);
      const green = Math.abs(actualPixels[offset + 1] - baselinePixels[offset + 1]);
      const blue = Math.abs(actualPixels[offset + 2] - baselinePixels[offset + 2]);
      channelDelta += red + green + blue;
      if (Math.max(red, green, blue) > channelTolerance) changedPixels += 1;
    }

    const pixelCount = actualPixels.length / 4;
    return {
      actualHeight: actualImage.naturalHeight,
      actualWidth: actualImage.naturalWidth,
      baselineHeight: baselineImage.naturalHeight,
      baselineWidth: baselineImage.naturalWidth,
      changedPixelRatio: changedPixels / pixelCount,
      meanChannelDelta: channelDelta / (pixelCount * 3),
    };
  }, {
    actual: actualPng.toString('base64'),
    baseline: baselinePng.toString('base64'),
    channelTolerance: CHANNEL_TOLERANCE,
  });
}

export async function assertVisualBaseline(
  page: Page,
  target: Locator,
  name: string,
): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const screenshot = await target.screenshot({ animations: 'disabled', caret: 'hide' });
  const baselinePath = resolve(BASELINE_DIR, `${name}.png`);

  if (process.env.MUXBASE_UPDATE_VISUAL_BASELINES === '1') {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(baselinePath, screenshot);
  }

  if (!existsSync(baselinePath)) {
    throw new Error(
      `Missing visual baseline ${baselinePath}. Run with MUXBASE_UPDATE_VISUAL_BASELINES=1 to create it.`,
    );
  }

  const diff = await measureVisualDiff(page, screenshot, readFileSync(baselinePath));
  try {
    assertVisualDiff(name, diff);
  } catch (error) {
    mkdirSync(FAILURE_DIR, { recursive: true });
    const actualPath = resolve(FAILURE_DIR, `${name}.actual.png`);
    writeFileSync(actualPath, screenshot);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Actual screenshot: ${actualPath}`);
  }
}
