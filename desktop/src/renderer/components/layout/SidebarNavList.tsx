import { rendererLog } from '../../lib/rendererLog';
import { SidebarCreateButton } from './SidebarCreateButton';
import { FILE_BROWSER_ACTION_ID, type ResolvedSidebarAction } from './sidebarActions';
import { SidebarNavRow } from './SidebarRow';

const SIDEBAR_LOG_SCOPE = 'sidebar';

interface SidebarNavListProps {
  actions: ResolvedSidebarAction[];
}

export function SidebarNavList({ actions }: Readonly<SidebarNavListProps>) {
  return (
    <nav className="flex shrink-0 flex-col gap-[1px] px-[8px] pt-[2px] pb-[6px]">
      <SidebarCreateButton />
      {actions.map((action) => (
        <SidebarActionRow key={action.id} action={action} />
      ))}
    </nav>
  );
}

function SidebarActionRow({ action }: Readonly<{ action: ResolvedSidebarAction }>) {
  const handleSelect = () => {
    if (action.id === FILE_BROWSER_ACTION_ID) {
      rendererLog.info(SIDEBAR_LOG_SCOPE, 'File browser action selected', {
        active: action.active,
        collapsed: false,
        title: action.title,
      });
    }
    action.onSelect();
  };

  return (
    <SidebarNavRow
      Icon={action.Icon}
      ariaCurrent={action.behavior === 'view' && action.active ? 'page' : undefined}
      ariaPressed={action.behavior === 'toggle' ? action.active : undefined}
      label={action.expandedLabel}
      onSelect={handleSelect}
      testId={action.testId}
    />
  );
}
