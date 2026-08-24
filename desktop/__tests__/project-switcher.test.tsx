// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSwitcher } from '../src/renderer/components/layout/ProjectSwitcher';
import type { ProjectInfo } from '../src/shared/ipc-types';

function project(name: string, root: string): ProjectInfo {
  return { configPath: `${root}/.aumx/aumx.config.json`, name, paneCount: 0, root, sessionName: `aumx-${name}` };
}

const PROJECTS = [project('alpha', '/tmp/alpha'), project('beta', '/tmp/beta'), project('gamma', '/tmp/gamma')];

describe('ProjectSwitcher', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a non-interactive shell for a single project', () => {
    // Arrange + Act
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={[PROJECTS[0]]} />);

    // Assert
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByTestId('sidebar-project-switcher').textContent).toBe('alpha');
  });

  it('opens the listbox on click and lists every project', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');

    // Act
    fireEvent.click(trigger);

    // Assert
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelect with the project root when an option is chosen', () => {
    // Arrange
    const onSelect = vi.fn();
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={onSelect} projects={PROJECTS} />);
    fireEvent.click(screen.getByRole('combobox'));

    // Act
    fireEvent.click(screen.getAllByRole('option')[1]);

    // Assert
    expect(onSelect).toHaveBeenCalledWith('/tmp/beta');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves the active option with arrow keys and selects it with Enter', () => {
    // Arrange
    const onSelect = vi.fn();
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={onSelect} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id);

    // Act
    fireEvent.keyDown(trigger, { key: 'Enter' });

    // Assert
    expect(onSelect).toHaveBeenCalledWith('/tmp/gamma');
  });

  it('closes on Escape and restores focus to the trigger', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.keyDown(trigger, { key: 'Escape' });

    // Assert
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when clicking outside the switcher', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.mouseDown(document.body);

    // Assert
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the listbox on Tab so focus can move on', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.keyDown(trigger, { key: 'Tab' });

    // Assert
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves the active option to the last and first entries with End and Home', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.keyDown(trigger, { key: 'End' });

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id);

    // Act
    fireEvent.keyDown(trigger, { key: 'Home' });

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
  });

  it('highlights the selected project again when reopened', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[2]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
    fireEvent.keyDown(trigger, { key: 'Escape' });

    // Act
    fireEvent.click(trigger);

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id);
  });

  it('keeps the keyboard highlight when an option scrolls under a stationary pointer', () => {
    // Arrange: arrow to the last project, no pointer movement anywhere in the menu
    const onSelect = vi.fn();
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={onSelect} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'End' });

    // Act: scrolling slides a different option under the still cursor, firing mouseenter
    fireEvent.mouseEnter(screen.getAllByRole('option')[0]);

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('/tmp/gamma');
  });

  it('highlights on hover once the pointer has genuinely moved', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // Act
    fireEvent.mouseMove(screen.getByRole('listbox'));
    fireEvent.mouseEnter(screen.getAllByRole('option')[1]);

    // Assert
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
  });

  it('closes without notifying when the already-active project is re-selected', () => {
    // Arrange
    const onSelect = vi.fn();
    render(<ProjectSwitcher activeProject={PROJECTS[1]} onSelect={onSelect} projects={PROJECTS} />);
    fireEvent.click(screen.getByRole('combobox'));

    // Act
    fireEvent.click(screen.getAllByRole('option')[1]);

    // Assert
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('sizes the menu to its own content instead of the demoted trigger width', () => {
    // Arrange
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);

    // Act
    fireEvent.click(screen.getByRole('combobox'));

    // Assert — the trigger measures ~0 in jsdom, so a readable floor must come from the menu itself
    const menu = screen.getByRole('listbox');
    expect(menu.style.minWidth).toBe('260px');
    expect(menu.style.maxWidth).toBe('380px');
    expect(menu.style.width).toBe('');
  });

  it('pins the menu inside the window when the trigger sits near the right edge', () => {
    // Arrange
    const rect = { bottom: 40, height: 24, left: 900, right: 990, top: 16, width: 90, x: 900, y: 16 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={PROJECTS} />);

    // Act
    fireEvent.click(screen.getByRole('combobox'));

    // Assert — left + maxWidth must stay clear of the 8px viewport margin
    const menu = screen.getByRole('listbox');
    const left = Number.parseFloat(menu.style.left);
    expect(left + Number.parseFloat(menu.style.maxWidth)).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(left).toBeLessThan(rect.left);
  });

  it('truncates a long project root from the start so the tail stays readable', () => {
    // Arrange
    const deep = project('deep', '/Users/someone/work/clients/acme/services/backend/api-gateway');

    // Act
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={[...PROJECTS, deep]} />);
    fireEvent.click(screen.getByRole('combobox'));

    // Assert
    const rendered = screen.getAllByRole('option')[3].textContent ?? '';
    expect(rendered).toContain('api-gateway');
    expect(rendered).not.toContain('/Users/someone');
  });

  it('demotes the single project to plain text so the sidebar wordmark stays the heading', () => {
    // Arrange + Act
    render(<ProjectSwitcher activeProject={PROJECTS[0]} onSelect={vi.fn()} projects={[PROJECTS[0]]} />);

    // Assert
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByTestId('sidebar-project-switcher').textContent).toBe('alpha');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('names the trigger with the current project now that the heading is gone', () => {
    // Arrange + Act
    render(<ProjectSwitcher activeProject={PROJECTS[1]} onSelect={vi.fn()} projects={PROJECTS} />);

    // Assert
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Switch project, current: beta' })).toBeTruthy();
  });

  it('falls back to the app name when no project is active', () => {
    // Arrange + Act
    render(<ProjectSwitcher activeProject={null} onSelect={vi.fn()} projects={PROJECTS} />);

    // Assert
    expect(screen.getByRole('combobox', { name: 'Switch project, current: Amux' })).toBeTruthy();
  });
});
