import { describe, expect, it } from 'vitest';
import { resolveAppIconFileName } from '../../src/main/utils/appIcon';

describe('resolveAppIconFileName', () => {
  it('uses the dev-marked icon in development runtime', () => {
    // Arrange
    const isDev = true;

    // Act
    const iconFileName = resolveAppIconFileName(isDev);

    // Assert
    expect(iconFileName).toBe('icon-dev.png');
  });

  it('uses the regular icon in packaged runtime', () => {
    // Arrange
    const isDev = false;

    // Act
    const iconFileName = resolveAppIconFileName(isDev);

    // Assert
    expect(iconFileName).toBe('icon.png');
  });
});
