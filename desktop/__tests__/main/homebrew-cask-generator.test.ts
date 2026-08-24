import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('generate-homebrew-cask', () => {
  it('creates a cask with architecture-specific checksums and versioned release URLs', () => {
    // Arrange
    const tempDir = mkdtempSync(join(tmpdir(), 'amux-cask-'));
    const armDmg = join(tempDir, 'Amux-0.1.0-arm64.dmg');
    const intelDmg = join(tempDir, 'Amux-0.1.0-x64.dmg');
    const output = join(tempDir, 'amux.rb');
    const script = resolve(__dirname, '../../../scripts/generate-homebrew-cask.mjs');

    writeFileSync(armDmg, 'arm build');
    writeFileSync(intelDmg, 'intel build');

    // Act
    execFileSync(process.execPath, [
      script,
      '--arm-dmg',
      armDmg,
      '--intel-dmg',
      intelDmg,
      '--output',
      output,
      '--version',
      '0.1.0',
    ]);

    const cask = readFileSync(output, 'utf8');

    // Assert
    expect(cask).toContain('cask "amux" do');
    expect(cask).toContain('arch arm: "arm64", intel: "x64"');
    expect(cask).toContain('version "0.1.0"');
    expect(cask).toContain('sha256 arm:');
    expect(cask).toContain('intel:');
    expect(cask).toContain('https://github.com/amux-app/amux/releases/download/v#{version}/Amux-#{version}-#{arch}.dmg');
    expect(cask).toContain('depends_on formula: ["git", "tmux"]');
    expect(cask).toContain('app "Amux.app"');
    expect(cask).toContain('auto_updates true');
    expect(cask).toContain('preflight do');
    expect(cask).toContain('tmux_bin = Formula["tmux"].opt_bin/"tmux"');
    expect(cask).toContain('system_command tmux_bin, args: ["-V"]');
    expect(cask).not.toContain('system_command "/usr/bin/env"');
    expect(cask).toContain('brew upgrade tmux');
    expect(cask).toContain('caveats <<~EOS');
    expect(cask).toContain('restart tmux completely');
    expect(cask).not.toContain('kill-server');
  });
});
