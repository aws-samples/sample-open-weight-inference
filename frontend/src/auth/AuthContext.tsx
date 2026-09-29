import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { resetSessionId } from '../api/agentcore';
import {
  AuthError,
  type AuthChallenge,
  type AuthClient,
  type AuthSession,
} from './types';
import { needsRefresh, refreshDelayMs } from './refresh';

export type AuthStatus =
  | 'RESTORING'
  | 'SIGNED_OUT'
  | 'CHALLENGE'
  | 'SIGNED_IN';

export interface AuthContextValue {
  status: AuthStatus;
  session: AuthSession | null;
  challenge: AuthChallenge | null;
  /** Last authentication error, for the sign-in form to display. */
  error: AuthError | null;
  busy: boolean;
  /** True while a silent refresh is in flight. */
  refreshing: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  respondToMfa: (code: string) => Promise<void>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  cancelChallenge: () => void;
  /** Returns a valid access token, refreshing silently when needed. */
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  client: AuthClient;
  children: ReactNode;
}

export function AuthProvider({ client, children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('RESTORING');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [error, setError] = useState<AuthError | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Mirrored in a ref so `getAccessToken` never closes over a stale session.
  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;
  // De-duplicates concurrent refreshes into one network call.
  const inFlightRefresh = useRef<Promise<AuthSession> | null>(null);
  const mounted = useRef(true);
  // Async restores/refreshes belong to the identity that started them. A late
  // response must not sign somebody back in after logout or replace a new user.
  const authGeneration = useRef(0);
  const stepInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authGeneration.current += 1;
    };
  }, []);

  const applySession = useCallback((next: AuthSession) => {
    sessionRef.current = next;
    setSession(next);
    setChallenge(null);
    setError(null);
    setStatus('SIGNED_IN');
  }, []);

  const clearSession = useCallback(() => {
    authGeneration.current += 1;
    inFlightRefresh.current = null;
    sessionRef.current = null;
    setSession(null);
    setChallenge(null);
    setStatus('SIGNED_OUT');
  }, []);

  /* --------------------------------------------------------- restore */

  useEffect(() => {
    let active = true;
    const generation = ++authGeneration.current;
    setStatus('RESTORING');
    sessionRef.current = null;
    setSession(null);
    client
      .restore()
      .then((restored) => {
        if (!active || generation !== authGeneration.current) return;
        if (restored) {
          applySession(restored);
        } else {
          clearSession();
        }
      })
      .catch(() => {
        if (active && generation === authGeneration.current) clearSession();
      });
    return () => {
      active = false;
    };
  }, [client, applySession, clearSession]);

  /* --------------------------------------------------- silent refresh */

  const doRefresh = useCallback(async (): Promise<AuthSession> => {
    if (inFlightRefresh.current) return inFlightRefresh.current;
    const generation = authGeneration.current;
    const subject = sessionRef.current?.sub;
    const promise = client
      .refresh()
      .then((next) => {
        if (!mounted.current || generation !== authGeneration.current || subject !== sessionRef.current?.sub) {
          throw new AuthError('SessionChanged', 'The signed-in session changed.');
        }
        if (next.sub !== subject) throw new AuthError('SessionChanged', 'The refreshed session has a different user.');
        if (mounted.current) {
          sessionRef.current = next;
          setSession(next);
        }
        return next;
      })
      .finally(() => {
        if (inFlightRefresh.current === promise) {
          inFlightRefresh.current = null;
          if (mounted.current) setRefreshing(false);
        }
      });
    inFlightRefresh.current = promise;
    if (mounted.current) setRefreshing(true);
    return promise;
  }, [client]);

  // Proactive refresh timer: the access token lasts 60 minutes inside an
  // 8-hour refresh window, so this keeps a long working session alive without
  // the user noticing.
  useEffect(() => {
    if (status !== 'SIGNED_IN' || !session) return;
    const delay = refreshDelayMs(session);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      const generation = authGeneration.current;
      void doRefresh().catch(() => {
        // The refresh window has closed — surface it as a sign-out rather
        // than leaving a dead session in place.
        if (!mounted.current || generation !== authGeneration.current) return;
        setError(
          new AuthError(
            'SessionExpired',
            'Your session expired. Sign in again to continue.'
          )
        );
        clearSession();
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [status, session, doRefresh, clearSession]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const generation = authGeneration.current;
    const current = sessionRef.current;
    if (!current) return null;
    if (!needsRefresh(current)) return current.accessToken;
    try {
      const refreshed = await doRefresh();
      return refreshed.accessToken;
    } catch {
      if (mounted.current && generation === authGeneration.current) {
        setError(
          new AuthError(
            'SessionExpired',
            'Your session expired. Sign in again to continue.'
          )
        );
        clearSession();
      }
      return null;
    }
  }, [doRefresh, clearSession]);

  /* ------------------------------------------------------- sign in */

  const runStep = useCallback(
    async (step: () => Promise<{ status: string } & Record<string, unknown>>) => {
      if (stepInFlight.current) return;
      stepInFlight.current = true;
      const generation = ++authGeneration.current;
      setBusy(true);
      setError(null);
      try {
        const outcome = (await step()) as
          | { status: 'SIGNED_IN'; session: AuthSession }
          | { status: 'CHALLENGE'; challenge: AuthChallenge };
        if (!mounted.current || generation !== authGeneration.current) return;
        if (outcome.status === 'SIGNED_IN') {
          applySession(outcome.session);
        } else {
          setChallenge(outcome.challenge);
          setStatus('CHALLENGE');
        }
      } catch (caught) {
        if (!mounted.current || generation !== authGeneration.current) return;
        const asAuthError =
          caught instanceof AuthError
            ? caught
            : new AuthError(
                'AuthError',
                caught instanceof Error ? caught.message : String(caught)
              );
        setError(asAuthError);
        throw asAuthError;
      } finally {
        stepInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [applySession]
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      // A fresh principal gets a fresh runtime session id.
      resetSessionId();
      await runStep(() => client.signIn(username.trim(), password)).catch(
        () => undefined
      );
    },
    [client, runStep]
  );

  const respondToMfa = useCallback(
    async (code: string) => {
      await runStep(() => client.respondToMfa(code.trim())).catch(
        () => undefined
      );
    },
    [client, runStep]
  );

  const completeNewPassword = useCallback(
    async (newPassword: string) => {
      await runStep(() => client.completeNewPassword(newPassword)).catch(
        () => undefined
      );
    },
    [client, runStep]
  );

  const cancelChallenge = useCallback(() => {
    authGeneration.current += 1;
    setChallenge(null);
    setError(null);
    setStatus('SIGNED_OUT');
  }, []);

  const signOut = useCallback(async () => {
    // Invalidate in-flight credentials before awaiting the network.
    clearSession();
    setRefreshing(false);
    setBusy(true);
    try {
      await client.signOut();
    } catch {
      // A failed global sign-out must still clear local state.
    } finally {
      resetSessionId();
      setError(null);
      clearSession();
      setBusy(false);
    }
  }, [client, clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      challenge,
      error,
      busy,
      refreshing,
      signIn,
      respondToMfa,
      completeNewPassword,
      signOut,
      cancelChallenge,
      getAccessToken,
    }),
    [
      status,
      session,
      challenge,
      error,
      busy,
      refreshing,
      signIn,
      respondToMfa,
      completeNewPassword,
      signOut,
      cancelChallenge,
      getAccessToken,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return value;
}
