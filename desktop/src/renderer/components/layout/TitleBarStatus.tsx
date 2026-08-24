import { AppUpdateControl } from './AppUpdateControl';

export function TitleBarStatus() {
  return (
    <div className="absolute inset-y-0 right-2 flex items-center gap-1.5 [-webkit-app-region:no-drag]">
      <AppUpdateControl />
    </div>
  );
}
