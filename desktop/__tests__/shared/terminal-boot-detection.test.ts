import { describe, expect, it } from 'vitest';
import {
  appendTerminalTail,
  hasAgentStartupMarker,
  hasUserInputPrompt,
  isAgentBootReady,
  normalizeTerminalText,
} from '../../src/renderer/lib/terminal-boot-detection';

describe('terminal boot detection', () => {
  it('normalizes ANSI terminal chunks before matching', () => {
    const raw = '\u001b[33mQuick safety check:\u001b[0m\r\n1. Yes, I trust this folder';
    const normalized = normalizeTerminalText(raw);
    expect(normalized).toContain('Quick safety check:');
    expect(normalized).toContain('I trust this folder');
    expect(normalized).not.toContain('\u001b[');
  });

  it('detects user-input prompts from trust flow content', () => {
    const chunk = 'Enter to confirm · Esc to cancel';
    expect(hasUserInputPrompt(chunk)).toBe(true);
  });

  it('detects agent startup markers by agent type', () => {
    expect(hasAgentStartupMarker('claude', 'Claude Code')).toBe(true);
    expect(hasAgentStartupMarker('codex', 'Codex ready')).toBe(true);
    expect(hasAgentStartupMarker('opencode', 'OpenCode')).toBe(true);
    expect(hasAgentStartupMarker('pi', 'pi v0.83.0')).toBe(true);
    expect(hasAgentStartupMarker('codex', 'unrelated output')).toBe(false);
  });

  it('keeps only the configured terminal tail window', () => {
    const start = 'x'.repeat(100);
    const appended = appendTerminalTail(start, 'y'.repeat(120), 150);
    expect(appended.length).toBe(150);
    expect(appended.endsWith('y'.repeat(120))).toBe(true);
  });

  it('matches the claude-opus-latest marker (not just opus + digit)', () => {
    expect(hasAgentStartupMarker('claude', 'claude-opus-latest with xhigh')).toBe(true);
    expect(hasAgentStartupMarker('claude', 'ClaudeCode')).toBe(true);
  });

  it('reports ready once the agent header paints after a resolved trust prompt', () => {
    // Arrange: the boot-time trust prompt appears first, then the Claude Code
    // header — the prompt is stale/answered by the time the header renders.
    const tail = 'I trust this folder\nEsc to cancel\n...\nClaude Code v2.1 ready';

    // Act + Assert: old marker+!prompt logic would veto this; positional logic clears.
    expect(hasUserInputPrompt(tail)).toBe(true);
    expect(isAgentBootReady('claude', tail)).toBe(true);
  });

  it('stays not-ready while a genuinely pending prompt trails the output', () => {
    // Arrange: header already shown, but a fresh prompt is now the last thing.
    const tail = 'Claude Code v2.1\n...\nContinue? (y/n)\nEnter to confirm · Esc to cancel';

    // Act + Assert: the trailing prompt is newer than the marker → not ready.
    expect(isAgentBootReady('claude', tail)).toBe(false);
  });

  it('is ready when the marker is present and no prompt appeared at all', () => {
    expect(isAgentBootReady('opencode', 'OpenCode\n> ready')).toBe(true);
    expect(isAgentBootReady('claude', 'no marker here yet')).toBe(false);
  });

  it('reports ready from the steady ready UI when the boot banner scrolled out', () => {
    // Arrange: the "Claude Code" boot banner has aged out of the rolling tail;
    // only the persistent bottom bar (auto mode / /effort) remains — exactly the
    // settled ready screen from the reported bug.
    const tail = 'high effort · API Usage Billing\n'
      + '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n'
      + '◉ xhigh · /effort';

    // Act + Assert: no startup marker present, but the ready marker is authoritative.
    expect(hasAgentStartupMarker('claude', tail)).toBe(false);
    expect(isAgentBootReady('claude', tail)).toBe(true);
  });

  it('ready UI after a lingering trust prompt clears the overlay', () => {
    const tail = 'I trust this folder\nEnter to confirm · Esc to cancel\n...\n'
      + '⏵⏵ auto mode on · /effort';
    expect(isAgentBootReady('claude', tail)).toBe(true);
  });

  it('falls back to the startup marker for agents without a ready marker', () => {
    // codex/opencode have no verified ready-UI token, so readiness comes from the
    // startup marker — the pre-fix behavior that already worked for them.
    expect(isAgentBootReady('codex', 'Codex v1.0 started')).toBe(true);
    expect(isAgentBootReady('opencode', 'opencode ready')).toBe(true);
    expect(isAgentBootReady('pi', 'pi v0.83.0\nesc interrupt · / commands')).toBe(true);
    // A ready-only token that Claude uses must NOT make codex ready on its own.
    expect(isAgentBootReady('codex', 'auto mode on')).toBe(false);
  });
});
