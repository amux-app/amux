// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusDot } from '../../src/renderer/components/shared/StatusDot';

describe('StatusDot', () => {
  it('announces the caller-provided completion label', () => {
    render(<StatusDot status="idle" ready readyLabel="Review complete" />);

    expect(screen.getByRole('status', { name: 'Review complete' })).not.toBeNull();
  });
});
