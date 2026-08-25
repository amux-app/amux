/**
 * Unit tests for viewAction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { viewPane } from '../../src/actions/implementations/viewAction.js';
import { createMockPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectNavigation, expectError } from '../helpers/actionAssertions.js';
import { execFileSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('viewAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should successfully jump to pane and return navigation result', async () => {
    const mockPane = createMockPane({
      id: 'muxbase-1',
      slug: 'test-pane',
      paneId: '%42',
    });
    const mockContext = createMockContext([mockPane]);

    // Mock successful tmux command
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));

    const result = await viewPane(mockPane, mockContext);

    // Verify tmux command was called correctly
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['select-pane', '-t', '%42'],
      { stdio: 'pipe' }
    );

    // Verify result
    expectNavigation(result, 'muxbase-1');
    expect(result.message).toContain('test-pane');
    expect(result.dismissable).toBe(true);
  });

  it('should return error when pane selection fails', async () => {
    const mockPane = createMockPane({ paneId: '%99' });
    const mockContext = createMockContext([mockPane]);

    // Mock tmux command failure
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('can\'t find pane %99');
    });

    const result = await viewPane(mockPane, mockContext);

    // Verify error result
    expectError(result, 'closed');
    expect(result.dismissable).toBe(true);
  });

  it('should handle special characters in pane ID', async () => {
    const mockPane = createMockPane({ paneId: '%$special' });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));

    await viewPane(mockPane, mockContext);

    // Verify pane ID is properly quoted in tmux command
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['select-pane', '-t', '%$special'],
      { stdio: 'pipe' }
    );
  });

  it('should include pane slug in success message', async () => {
    const mockPane = createMockPane({ slug: 'my-feature-branch' });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));

    const result = await viewPane(mockPane, mockContext);

    expect(result.message).toContain('my-feature-branch');
  });

  it('should set correct target pane ID for navigation', async () => {
    const mockPane = createMockPane({ id: 'muxbase-42' });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));

    const result = await viewPane(mockPane, mockContext);

    expect(result.targetPaneId).toBe('muxbase-42');
  });
});
