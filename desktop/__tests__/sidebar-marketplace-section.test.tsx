// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceStore } from '../src/renderer/stores/marketplace.store';
import { useUiStore } from '../src/renderer/stores/ui.store';

vi.mock('../src/renderer/hooks/useMarketplaceBootstrap', () => ({
  useMarketplaceBootstrap: vi.fn(),
}));

import { SidebarMarketplaceSection } from '../src/renderer/components/layout/SidebarMarketplaceSection';

describe('SidebarMarketplaceSection', () => {
  const marketplaceInitial = useMarketplaceStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    useMarketplaceStore.setState({
      ...marketplaceInitial,
      browsedPlugins: {},
      sources: [],
    });
    useUiStore.setState({
      ...uiInitial,
      activeView: 'dashboard',
      settingsCategory: 'appearance',
    });
  });

  afterEach(() => {
    cleanup();
    useMarketplaceStore.setState(marketplaceInitial);
    useUiStore.setState(uiInitial);
  });

  it('starts collapsed when the sidebar is opened', () => {
    render(<SidebarMarketplaceSection />);

    const toggle = screen.getByRole('button', { name: 'Marketplace' });
    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content?.getAttribute('aria-hidden')).toBe('true');
    expect(content?.hasAttribute('inert')).toBe(true);
  });

  it('expands the marketplace categories when requested', () => {
    render(<SidebarMarketplaceSection />);

    const toggle = screen.getByRole('button', { name: 'Marketplace' });
    fireEvent.click(toggle);

    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(content?.getAttribute('aria-hidden')).toBe('false');
    expect(content?.hasAttribute('inert')).toBe(false);
  });
});
