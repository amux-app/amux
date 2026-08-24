const DEFAULT_APP_ICON_FILE_NAME = 'icon.png';
const DEV_APP_ICON_FILE_NAME = 'icon-dev.png';

export function resolveAppIconFileName(isDev: boolean): string {
  return isDev ? DEV_APP_ICON_FILE_NAME : DEFAULT_APP_ICON_FILE_NAME;
}
