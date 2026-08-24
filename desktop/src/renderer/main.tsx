import '@xterm/xterm/css/xterm.css';
import 'highlight.js/styles/github-dark.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { RendererErrorBoundary } from './components/shared/RendererErrorBoundary';
import { applyDocumentTheme } from './lib/document-theme';
import { installRendererErrorLogging } from './lib/rendererErrorLogging';
import { useUiStore } from './stores';
import './styles/fonts.css';
import './styles/theme.css';
import './styles/globals.css';
import './styles/sidebar.css';

installRendererErrorLogging();
// Paint the persisted theme before React mounts so light users never see the
// dark default frame.
applyDocumentTheme(useUiStore.getState().theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary
      description="The renderer crashed before the workspace could finish drawing. Retry to remount the desktop shell."
      scope="app-root"
      title="Renderer unavailable"
    >
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
