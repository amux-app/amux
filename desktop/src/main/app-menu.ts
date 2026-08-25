import type { MenuItemConstructorOptions } from 'electron';

interface ApplicationMenuOptions {
  checkForUpdates: () => void;
  reloadRenderer: (ignoreCache: boolean) => void;
}

export function createApplicationMenuTemplate({
  checkForUpdates,
  reloadRenderer,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'MuxBase',
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: checkForUpdates,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          accelerator: 'CmdOrCtrl+R',
          click: () => reloadRenderer(false),
          label: 'Reload',
        },
        {
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => reloadRenderer(true),
          label: 'Force Reload',
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
}
