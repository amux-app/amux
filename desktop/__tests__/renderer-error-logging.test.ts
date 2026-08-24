// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installRendererErrorLogging } from '../src/renderer/lib/rendererErrorLogging';

const rendererLogSpies = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../src/renderer/lib/rendererLog', () => ({
  rendererLog: {
    error: rendererLogSpies.error,
  },
}));

describe('renderer error logging', () => {
  beforeEach(() => {
    rendererLogSpies.error.mockClear();
  });

  it('bridges uncaught renderer errors and rejected promises to the main log', () => {
    // Arrange
    installRendererErrorLogging();
    const error = new Error('boom');

    // Act
    window.dispatchEvent(new ErrorEvent('error', {
      colno: 9,
      error,
      filename: 'app.tsx',
      lineno: 7,
      message: 'boom',
    }));
    const rejectionEvent = new Event('unhandledrejection') as Event & { reason: unknown };
    Object.defineProperty(rejectionEvent, 'reason', { value: error });
    window.dispatchEvent(rejectionEvent);

    // Assert
    expect(rendererLogSpies.error).toHaveBeenCalledWith(
      'renderer:global-error',
      'Unhandled renderer error',
      expect.objectContaining({
        colno: 9,
        filename: 'app.tsx',
        lineno: 7,
        message: 'boom',
      }),
    );
    expect(rendererLogSpies.error).toHaveBeenCalledWith(
      'renderer:unhandled-rejection',
      'Unhandled renderer promise rejection',
      expect.objectContaining({
        reason: expect.objectContaining({ message: 'boom', name: 'Error' }),
      }),
    );
  });
});
