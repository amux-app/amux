// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewNavigationButton } from '../../src/renderer/components/dashboard/ReviewNavigationButton';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useUiStore } from '../../src/renderer/stores/ui.store';

describe('ReviewNavigationButton', () => {
  beforeEach(() => {
    usePaneStore.setState({ selectedPaneId: null });
    useUiStore.setState({ focusPaneId: null, viewMode: 'fleet' });
  });

  it('selects the related pane from Fleet view', () => {
    render(<ReviewNavigationButton direction="forward" label="Open review" targetPaneId="review-pane" />);

    fireEvent.click(screen.getByRole('button', { name: 'Open review' }));

    expect(usePaneStore.getState().selectedPaneId).toBe('review-pane');
    expect(useUiStore.getState().viewMode).toBe('fleet');
  });

  it('keeps the user in Focus view while switching to the related pane', () => {
    useUiStore.setState({ focusPaneId: 'review-pane', viewMode: 'focus' });
    render(<ReviewNavigationButton direction="back" label="Back to feature" targetPaneId="source-pane" />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to feature' }));

    expect(usePaneStore.getState().selectedPaneId).toBe('source-pane');
    expect(useUiStore.getState().focusPaneId).toBe('source-pane');
  });

  it('renders a disabled closed-source state when the related pane is gone', () => {
    render(<ReviewNavigationButton direction="back" label="Source closed" />);

    expect(screen.getByRole('button', { name: 'Source closed' }).hasAttribute('disabled')).toBe(true);
  });
});
