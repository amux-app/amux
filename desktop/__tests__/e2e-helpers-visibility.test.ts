import type { ElectronApplication, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { ensureAppWindowVisible, setAppWindowVisibility } from './e2e/e2e-helpers.js';

describe('setAppWindowVisibility', () => {
  it('uses BrowserWindow visibility outside macOS without calling Darwin-only app APIs', async () => {
    const windowEvaluate = vi.fn().mockResolvedValue(undefined);
    const app = {
      browserWindow: vi.fn().mockResolvedValue({ evaluate: windowEvaluate }),
      evaluate: vi.fn().mockResolvedValue({
        environment: { NODE_ENV: 'test' },
        platform: 'linux',
      }),
    } as unknown as ElectronApplication;
    const page = {} as Page;

    await setAppWindowVisibility(app, page, false);

    expect(app.evaluate).toHaveBeenCalledTimes(1);
    expect(app.browserWindow).toHaveBeenCalledWith(page);
    expect(windowEvaluate).toHaveBeenCalledWith(expect.any(Function), false);
  });

  it('uses application visibility on macOS', async () => {
    const windowEvaluate = vi.fn().mockResolvedValue(undefined);
    const app = {
      browserWindow: vi.fn().mockResolvedValue({ evaluate: windowEvaluate }),
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          environment: { AUMX_E2E_HEADED: '1', NODE_ENV: 'test' },
          platform: 'darwin',
        })
        .mockResolvedValueOnce(undefined),
    } as unknown as ElectronApplication;

    await setAppWindowVisibility(app, {} as Page, true);

    expect(app.evaluate).toHaveBeenCalledTimes(2);
    expect(app.evaluate).toHaveBeenLastCalledWith(expect.any(Function), false);
    expect(app.browserWindow).toHaveBeenCalledWith({});
    expect(windowEvaluate).toHaveBeenCalledWith(expect.any(Function), false);
  });

  it('shows headless macOS windows without activating or focusing the app', async () => {
    const electronApp = {
      focus: vi.fn(),
      isHidden: vi.fn().mockReturnValue(false),
      show: vi.fn(),
    };
    const browserWindow = {
      focus: vi.fn(),
      isMinimized: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      showInactive: vi.fn(),
    };
    const windowEvaluate = vi.fn(async (callback, headless) => callback(browserWindow, headless));
    const app = {
      browserWindow: vi.fn().mockResolvedValue({ evaluate: windowEvaluate }),
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          environment: { AUMX_E2E: '1', NODE_ENV: 'test' },
          platform: 'darwin',
        })
        .mockImplementationOnce(async (callback, headless) => callback({ app: electronApp }, headless)),
    } as unknown as ElectronApplication;

    await setAppWindowVisibility(app, {} as Page, true);

    expect(electronApp.show).toHaveBeenCalledOnce();
    expect(electronApp.focus).not.toHaveBeenCalled();
    expect(browserWindow.showInactive).toHaveBeenCalledOnce();
    expect(browserWindow.show).not.toHaveBeenCalled();
    expect(browserWindow.focus).not.toHaveBeenCalled();
  });
});

describe('ensureAppWindowVisible', () => {
  it('uses showInactive for a headless E2E window', async () => {
    const browserWindow = {
      hide: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      isVisible: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true),
      show: vi.fn(),
      showInactive: vi.fn(),
    };
    const app = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          environment: { AUMX_E2E: '1', NODE_ENV: 'test' },
          platform: 'darwin',
        })
        .mockImplementationOnce(async (callback, headless) => callback({
          BrowserWindow: { getAllWindows: () => [browserWindow] },
        }, headless)),
    } as unknown as ElectronApplication;

    await ensureAppWindowVisible(app);

    expect(browserWindow.hide).toHaveBeenCalledOnce();
    expect(browserWindow.showInactive).toHaveBeenCalledOnce();
    expect(browserWindow.show).not.toHaveBeenCalled();
  });
});
