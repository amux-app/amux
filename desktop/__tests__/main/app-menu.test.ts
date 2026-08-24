import { describe, expect, it, vi } from 'vitest';
import { createApplicationMenuTemplate } from '../../src/main/app-menu';

describe('application menu', () => {
  it('routes Check for Updates through the shared service action', () => {
    const checkForUpdates = vi.fn();
    const template = createApplicationMenuTemplate({
      checkForUpdates,
      reloadRenderer: vi.fn(),
    });
    const appMenu = template[0];
    const submenu = Array.isArray(appMenu?.submenu) ? appMenu.submenu : [];
    const updateItem = submenu.find((item) => 'label' in item && item.label === 'Check for Updates…');

    expect(updateItem).toBeTruthy();
    if (updateItem && 'click' in updateItem && typeof updateItem.click === 'function') {
      updateItem.click({} as never, {} as never, {} as never);
    }
    expect(checkForUpdates).toHaveBeenCalledOnce();
  });
});
