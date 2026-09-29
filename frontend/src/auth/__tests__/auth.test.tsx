import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from '../AuthContext';
import { AuthError } from '../types';
import {
  REFRESH_SKEW_MS,
  isExpired,
  minutesRemaining,
  needsRefresh,
  refreshDelayMs,
} from '../refresh';
import { FakeAuthClient, makeSession } from '../../test/harness';

describe('refresh scheduling', () => {
  const now = 1_800_000_000_000;

  it('does not refresh a token with plenty of life left', () => {
    const session = makeSession({ expiresAt: now + 60 * 60 * 1000 });
    expect(needsRefresh(session, now)).toBe(false);
    expect(isExpired(session, now)).toBe(false);
  });

  it('refreshes once inside the skew window, before actual expiry', () => {
    const session = makeSession({ expiresAt: now + REFRESH_SKEW_MS - 1000 });
    expect(needsRefresh(session, now)).toBe(true);
    // Still usable — the point is to refresh *before* it breaks.
    expect(isExpired(session, now)).toBe(false);
  });

  it('reports an elapsed token as expired', () => {
    expect(isExpired(makeSession({ expiresAt: now - 1 }), now)).toBe(true);
    expect(isExpired(null, now)).toBe(true);
  });

  it('schedules the next refresh before expiry and never instantly', () => {
    const session = makeSession({ expiresAt: now + 60 * 60 * 1000 });
    const delay = refreshDelayMs(session, now);
    expect(delay).toBe(60 * 60 * 1000 - REFRESH_SKEW_MS);

    // A token already inside the window refreshes soon, but not in 0 ms.
    const soon = makeSession({ expiresAt: now + 1000 });
    expect(refreshDelayMs(soon, now)).toBeGreaterThan(0);
  });

  it('reports remaining minutes for display, floored at zero', () => {
    expect(minutesRemaining(makeSession({ expiresAt: now + 90_000 }), now)).toBe(1);
    expect(minutesRemaining(makeSession({ expiresAt: now - 90_000 }), now)).toBe(0);
    expect(minutesRemaining(null, now)).toBeNull();
  });
});

/** Surfaces the auth context for assertions. */
function AuthProbe() {
  const { status, session, challenge, error, getAccessToken } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="token">{session?.accessToken ?? 'none'}</span>
      <span data-testid="challenge">{challenge?.kind ?? 'none'}</span>
      <span data-testid="error">{error?.message ?? 'none'}</span>
      <button
        onClick={() => {
          void getAccessToken();
        }}
      >
        get token
      </button>
    </div>
  );
}

function renderAuth(client: FakeAuthClient) {
  return render(
    <AuthProvider client={client}>
      <AuthProbe />
    </AuthProvider>
  );
}

describe('AuthProvider lifecycle', () => {
  it('restores a persisted session on mount', async () => {
    const client = new FakeAuthClient({
      initial: makeSession({ accessToken: 'restored' }),
    });
    renderAuth(client);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
    expect(screen.getByTestId('token')).toHaveTextContent('restored');
    expect(client.calls.restore).toBe(1);
  });

  it('lands on SIGNED_OUT when there is nothing to restore', async () => {
    renderAuth(new FakeAuthClient({ initial: null }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT')
    );
  });

  it('reuses a valid access token without calling refresh', async () => {
    const client = new FakeAuthClient({
      initial: makeSession({ expiresAt: Date.now() + 60 * 60 * 1000 }),
    });
    renderAuth(client);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
    await userEvent.click(screen.getByRole('button', { name: 'get token' }));
    expect(client.calls.refresh).toBe(0);
  });

  it('silently refreshes a token that is inside the skew window', async () => {
    const client = new FakeAuthClient({
      initial: makeSession({ expiresAt: Date.now() + 60 * 1000 }),
      refreshResult: makeSession({ accessToken: 'silently-refreshed' }),
    });
    renderAuth(client);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
    await userEvent.click(screen.getByRole('button', { name: 'get token' }));
    await waitFor(() =>
      expect(screen.getByTestId('token')).toHaveTextContent('silently-refreshed')
    );
    expect(client.calls.refresh).toBeGreaterThanOrEqual(1);
  });

  it('signs the user out when the refresh window has closed', async () => {
    const client = new FakeAuthClient({
      initial: makeSession({ expiresAt: Date.now() + 60 * 1000 }),
      refreshResult: () =>
        Promise.reject(new AuthError('NotAuthorizedException', 'Refresh Token has expired')),
    });
    renderAuth(client);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
    await userEvent.click(screen.getByRole('button', { name: 'get token' }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT')
    );
    expect(screen.getByTestId('error')).toHaveTextContent('Your session expired');
  });

  it('de-duplicates concurrent refreshes into a single call', async () => {
    const client = new FakeAuthClient({
      initial: makeSession({ expiresAt: Date.now() + 60 * 1000 }),
    });
    let captured: (() => Promise<string | null>) | null = null;
    function Capture() {
      const { getAccessToken, status } = useAuth();
      captured = getAccessToken;
      return <span data-testid="s">{status}</span>;
    }
    render(
      <AuthProvider client={client}>
        <Capture />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('s')).toHaveTextContent('SIGNED_IN')
    );
    const getToken = captured as unknown as () => Promise<string | null>;
    await Promise.all([getToken(), getToken(), getToken()]);
    expect(client.calls.refresh).toBe(1);
  });
});

describe('AuthProvider sign-in flow', () => {
  it('raises the MFA challenge before granting a session', async () => {
    const client = new FakeAuthClient({
      initial: null,
      signInOutcome: {
        status: 'CHALLENGE',
        challenge: { kind: 'SOFTWARE_TOKEN_MFA' },
      },
    });
    function Flow() {
      const { status, challenge, signIn, respondToMfa } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="challenge">{challenge?.kind ?? 'none'}</span>
          <button onClick={() => void signIn('u', 'p')}>sign in</button>
          <button onClick={() => void respondToMfa('123456')}>mfa</button>
        </div>
      );
    }
    render(
      <AuthProvider client={client}>
        <Flow />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT')
    );

    await userEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('CHALLENGE')
    );
    expect(screen.getByTestId('challenge')).toHaveTextContent(
      'SOFTWARE_TOKEN_MFA'
    );

    await userEvent.click(screen.getByRole('button', { name: 'mfa' }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
  });

  it('exposes a sign-in failure without throwing to the caller', async () => {
    const client = new FakeAuthClient({
      initial: null,
      signInError: new AuthError(
        'NotAuthorizedException',
        'Incorrect username or password.'
      ),
    });
    function Flow() {
      const { status, error, signIn } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="error">{error?.message ?? 'none'}</span>
          <button onClick={() => void signIn('u', 'bad')}>sign in</button>
        </div>
      );
    }
    render(
      <AuthProvider client={client}>
        <Flow />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT')
    );
    await userEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent(
        'Incorrect username or password.'
      )
    );
    expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT');
  });

  it('clears the session on sign-out even if the remote call fails', async () => {
    const client = new FakeAuthClient({ initial: makeSession() });
    vi.spyOn(client, 'signOut').mockRejectedValueOnce(new Error('network down'));
    function Flow() {
      const { status, signOut } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <button onClick={() => void signOut()}>sign out</button>
        </div>
      );
    }
    render(
      <AuthProvider client={client}>
        <Flow />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_IN')
    );
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('SIGNED_OUT')
    );
  });
});
