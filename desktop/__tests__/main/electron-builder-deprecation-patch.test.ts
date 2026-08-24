import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireFromTest = createRequire(import.meta.url);

function resolveNodeModulesCollectorPath(): string {
  const electronBuilderPath = requireFromTest.resolve('electron-builder');
  const electronBuilderRequire = createRequire(electronBuilderPath);
  return electronBuilderRequire.resolve('app-builder-lib/out/node-module-collector/nodeModulesCollector.js');
}

describe('electron-builder dependency collector', () => {
  it('spawns package-manager collection without shell mode', () => {
    // Arrange
    const source = readFileSync(resolveNodeModulesCollectorPath(), 'utf8');

    // Act / Assert
    expect(source).toContain('childProcess.spawn(spawnCommand, spawnArgs');
    expect(source).toContain('powershell.exe');
    expect(source).not.toMatch(/^\s*shell:\s*true,/m);
  });
});
