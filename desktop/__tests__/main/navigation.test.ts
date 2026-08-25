import { describe, expect, it } from 'vitest';
import { isAllowedAppNavigationUrl } from '../../src/main/utils/navigation';

describe('isAllowedAppNavigationUrl', () => {
  it('allows packaged renderer URLs', () => {
    expect(isAllowedAppNavigationUrl('file:///Applications/MuxBase.app/index.html', { isDev: false })).toBe(true);
    expect(isAllowedAppNavigationUrl('app://renderer/index.html', { isDev: false })).toBe(true);
  });

  it('rejects external navigation in production', () => {
    expect(isAllowedAppNavigationUrl('https://example.com', { isDev: false })).toBe(false);
  });

  it('allows only the configured renderer origin in dev', () => {
    expect(isAllowedAppNavigationUrl('http://localhost:5173/app', {
      isDev: true,
      rendererUrl: 'http://localhost:5173',
    })).toBe(true);
    expect(isAllowedAppNavigationUrl('http://127.0.0.1:5173/app', {
      isDev: true,
      rendererUrl: 'http://localhost:5173',
    })).toBe(false);
  });

  it('allows only the exact packaged renderer file when configured', () => {
    const rendererUrl = 'file:///Applications/MuxBase.app/Contents/Resources/app.asar/out/renderer/index.html';

    expect(isAllowedAppNavigationUrl(rendererUrl, { isDev: false, rendererUrl })).toBe(true);
    expect(isAllowedAppNavigationUrl('file:///Users/me/Downloads/external.html', {
      isDev: false,
      rendererUrl,
    })).toBe(false);
  });
});
