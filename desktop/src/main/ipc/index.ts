import type { AppFileFlushResultRequest } from '../../shared/ipc-types.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import type { AppBootService } from '../services/AppBootService.js';
import type { UpdateService } from '../services/UpdateService.js';
import { registerActionHandlers } from './action.handlers.js';
import { registerAppHandlers } from './app.handlers.js';
import { registerAgentDefaultsHandlers } from './agent-defaults.handlers.js';
import { registerAgentHandlers } from './agent.handlers.js';
import { registerAgentHealthHandlers } from './agent-health.handlers.js';
import { registerAgentSessionHandlers } from './agent-session.handlers.js';
import { registerDecomposeHandlers } from './decompose.handlers.js';
import { registerElectronSettingsHandlers } from './electron-settings.handlers.js';
import { registerFileHandlers } from './file.handlers.js';
import { registerFormatHandlers } from './format.handlers.js';
import { registerGitHandlers } from './git.handlers.js';
import { registerKanbanHandlers } from './kanban.handlers.js';
import { registerLspHandlers } from './lsp.handlers.js';
import { registerMarketplaceHandlers } from './marketplace.handlers.js';
import { registerPaneHandlers } from './pane.handlers.js';
import { registerPaneActivityHandlers } from './pane-activity.handlers.js';
import { registerPaneSummaryHandlers } from './pane-summary.handlers.js';
import { registerProjectHandlers } from './project.handlers.js';
import { registerProviderStatusHandlers } from './provider-status.handlers.js';
import { registerRecapHandlers } from './recap.handlers.js';
import { registerRendererLogHandlers } from './renderer-log.handlers.js';
import { registerSettingsHandlers } from './settings.handlers.js';
import { registerSystemHandlers } from './system.handlers.js';
import { registerTerminalHandlers } from './terminal.handlers.js';
import { registerTopicsHandlers } from './topics.handlers.js';
import { registerUpdateHandlers } from './update.handlers.js';
import { registerWorkspaceHandlers } from './workspace.handlers.js';
import { registerWorktreeHandlers } from './worktree.handlers.js';

export function registerAllHandlers(
  bridge: AumxBridge,
  bootService: AppBootService,
  completeFileFlush: (request: AppFileFlushResultRequest) => boolean,
  updateService: UpdateService,
): void {
  registerActionHandlers(bridge);
  registerAppHandlers(bootService, completeFileFlush);
  registerAgentDefaultsHandlers(bridge);
  registerAgentHandlers(bridge);
  registerAgentHealthHandlers();
  registerAgentSessionHandlers(bridge);
  registerDecomposeHandlers(bridge);
  registerElectronSettingsHandlers(bridge);
  registerFileHandlers(bridge);
  registerFormatHandlers(bridge);
  registerGitHandlers(bridge);
  registerKanbanHandlers(bridge);
  registerLspHandlers(bridge);
  registerMarketplaceHandlers();
  registerPaneActivityHandlers(bridge);
  registerPaneHandlers(bridge);
  registerPaneSummaryHandlers(bridge);
  registerProjectHandlers(bridge);
  registerProviderStatusHandlers();
  registerRecapHandlers(bridge);
  registerRendererLogHandlers();
  registerSettingsHandlers(bridge);
  registerSystemHandlers(bridge);
  registerTerminalHandlers(bridge);
  registerTopicsHandlers(bridge);
  registerUpdateHandlers(updateService);
  registerWorkspaceHandlers();
  registerWorktreeHandlers(bridge);
}
