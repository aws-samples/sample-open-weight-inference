import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AgentCoreClient } from '../api/agentcore';
import type { HealthResponse, RuntimeConfig } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useAsync, type AsyncResult } from './useAsync';
import {
  applyThemeMode,
  persistMode,
  readStoredMode,
  type ThemeMode,
} from './theme';

export interface AppContextValue {
  config: RuntimeConfig;
  client: AgentCoreClient;
  health: AsyncResult<HealthResponse>;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export interface AppProviderProps {
  config: RuntimeConfig;
  /** Injectable for tests; otherwise built from the config and auth token. */
  client?: AgentCoreClient;
  children: ReactNode;
}

export function AppProvider({ config, client, children }: AppProviderProps) {
  const { getAccessToken } = useAuth();

  const apiClient = useMemo(
    () =>
      client ??
      new AgentCoreClient({
        config,
        getAccessToken,
      }),
    [client, config, getAccessToken]
  );

  const health = useAsync<HealthResponse>(
    (signal) => apiClient.health(signal),
    [apiClient]
  );

  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    persistMode(next);
    setModeState(next);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      persistMode(next);
      return next;
    });
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ config, client: apiClient, health, mode, setMode, toggleMode }),
    [config, apiClient, health, mode, setMode, toggleMode]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside <AppProvider>.');
  }
  return value;
}
