import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AgentCoreClient } from '../../api/agentcore';
import { AuthProvider } from '../../auth/AuthContext';
import { AppProvider } from '../../state/AppContext';
import { DetailPanelProvider } from '../../state/DetailPanelContext';
import { NotificationsProvider } from '../../state/NotificationsContext';
import { AppShell } from '../AppShell';
import { ConversationsProvider } from '../../state/ConversationsContext';
import { ComparisonPage } from '../../pages/ComparisonPage';
import { configFixture, healthFixture } from '../../test/fixtures';
import {
  FakeAuthClient,
  defaultHandler,
  makeSession,
  recordingTransport,
  renderWithProviders,
} from '../../test/harness';

function renderShell() {
  const { fetchImpl } = recordingTransport(
    defaultHandler({ health: healthFixture })
  );
  const client = new AgentCoreClient({
    config: configFixture,
    getAccessToken: async () => 'access-token-1',
    fetchImpl,
    sessionId: 'eddie-testsessionidtestsessionidtest01',
  });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <NotificationsProvider>
        <AuthProvider client={new FakeAuthClient({ initial: makeSession() })}>
          <AppProvider config={configFixture} client={client}>
            <DetailPanelProvider>
              <ConversationsProvider><AppShell>
                <h1>Page content</h1>
              </AppShell></ConversationsProvider>
            </DetailPanelProvider>
          </AppProvider>
        </AuthProvider>
      </NotificationsProvider>
    </MemoryRouter>
  );
}

describe('CHAT-08: landmarks', () => {
  it('shows no diagnostics strip, because it is not part of first use', async () => {
    /*
     * This previously asserted a seven-item environment strip existed inside a
     * labelled region -- an accessibility fix for content that should not have been
     * on every screen in the first place.
     *
     * UXR-02 removes it: Region, solver version, release id, COA state and demo state
     * appear on no ordinary screen, including the empty one. They are real and useful
     * to an operator, and they live in Settings. Asserting their absence is what stops
     * them drifting back one badge at a time.
     */
    renderShell();
    await waitFor(() =>
      expect(screen.getByRole('navigation')).toBeInTheDocument()
    );
    expect(
      screen.queryByRole('region', { name: 'Environment and service status' })
    ).toBeNull();
    expect(screen.queryByText(/Region us-east-1/)).toBeNull();
    expect(screen.queryByText(/^Solver /)).toBeNull();
    expect(screen.queryByText(/^Release /)).toBeNull();
    expect(screen.queryByText(/^Knowledge /)).toBeNull();
    expect(screen.queryByText(/^Demo /)).toBeNull();
  });
});

describe('CHAT-08: keyboard behaviour', () => {
  it('closes the navigation drawer on Escape', async () => {
    renderShell();
    // The drawer starts open; Escape must close it. Leaving it open at phone
    // width traps the reader on a screen whose heading is then unreachable.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Close side navigation' })
      ).toBeInTheDocument()
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Close side navigation' })
      ).toBeNull()
    );
  });

  it('leaves the page heading reachable after Escape', async () => {
    renderShell();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Page content' })
      ).toBeInTheDocument()
    );
  });
});

describe('CHAT-08: the comparison route link', () => {
  it('points at /case, not at chat', async () => {
    renderWithProviders(<ComparisonPage />, { withCase: true });
    await waitFor(() =>
      expect(screen.getByText('No evaluation yet')).toBeInTheDocument()
    );
    const link = screen
      .getByRole('button', { name: 'Go to the case workspace' })
      .closest('a') as HTMLAnchorElement;
    expect(link).toHaveAttribute('href', '/case');
  });

  it('tells the user an evaluation can come from chat as well as the form', async () => {
    renderWithProviders(<ComparisonPage />, { withCase: true });
    await waitFor(() =>
      expect(
        screen.getByText(/Run an evaluation in Chat or on the case workspace/)
      ).toBeInTheDocument()
    );
  });
});
