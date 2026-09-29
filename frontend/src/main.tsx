import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@cloudscape-design/global-styles/index.css';
import './styles/global.css';
import { App } from './App';
import { ConfigError, loadRuntimeConfig } from './api/config';
import { CognitoAuthClient } from './auth/cognito';
import { AuthProvider } from './auth/AuthContext';
import { NotificationsProvider } from './state/NotificationsContext';
import { applyThemeMode, readStoredMode } from './state/theme';
import { ConfigErrorScreen } from './components/ConfigErrorScreen';

// Apply the persisted or system theme before first paint so the shell never
// flashes the wrong mode.
applyThemeMode(readStoredMode());

async function bootstrap() {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Root container #root is missing from index.html.');
  }
  const root = createRoot(container);

  let config;
  try {
    config = await loadRuntimeConfig();
  } catch (caught) {
    // Without the runtime ARN and the Cognito pool there is nothing the app can
    // do, so it says exactly what is missing instead of rendering a shell that
    // fails on every action.
    const detail =
      caught instanceof ConfigError
        ? caught.detail
        : caught instanceof Error
          ? caught.message
          : String(caught);
    root.render(
      <StrictMode>
        <ConfigErrorScreen detail={detail} />
      </StrictMode>
    );
    return;
  }

  const authClient = new CognitoAuthClient(config);

  root.render(
    <StrictMode>
      <BrowserRouter>
        <NotificationsProvider>
          <AuthProvider client={authClient}>
            <App config={config} />
          </AuthProvider>
        </NotificationsProvider>
      </BrowserRouter>
    </StrictMode>
  );
}

void bootstrap();
