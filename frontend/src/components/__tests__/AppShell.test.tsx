import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../App';
import { AgentCoreClient } from '../../api/agentcore';
import { AuthProvider } from '../../auth/AuthContext';
import { AppProvider } from '../../state/AppContext';
import { ConversationsProvider } from '../../state/ConversationsContext';
import { NotificationsProvider } from '../../state/NotificationsContext';
import { DetailPanelProvider } from '../../state/DetailPanelContext';
import { EMPTY_PROJECT } from '../../state/caseForm';
import { EMPTY_EVALUATION } from '../../state/evaluationDraft';
import { loadCase, saveCase, type SavedProject } from '../../state/persistence';
import { AppShell } from '../AppShell';
import {
  catalogFixture,
  configFixture,
  demoSleepingFixture,
  healthFixture,
  knowledgeNotInstalledFixture,
  ratesFixture,
} from '../../test/fixtures';
import {
  FakeAuthClient,
  defaultHandler,
  failEnvelope,
  makeSession,
  okEnvelope,
  recordingTransport,
  type ActionHandler,
} from '../../test/harness';

/**
 * The shell after the UXR-01 redesign.
 *
 * Most of this file was rewritten rather than repaired. The previous tests asserted the
 * navigation the redesign exists to remove — eight peer destinations grouped under
 * Evaluate/Evidence/Operate/Resources, plus a diagnostics strip on every screen. Keeping
 * them passing would have meant keeping the interface the product owner could not
 * understand, which UXR-13 explicitly forbids: "do not preserve a confusing layout
 * merely because it already has tests."
 *
 * What is asserted now is the new contract, including the absences. An absence needs a
 * test more than a presence does: nothing stops a diagnostics badge drifting back one
 * commit at a time except a test that says it must not.
 */

const HANDLER = defaultHandler({
  health: healthFixture,
  catalog: catalogFixture,
  rates: ratesFixture,
  knowledge: knowledgeNotInstalledFixture,
  'demo.status': demoSleepingFixture,
  'deployment.list': {
    deployments: [],
    residual: null,
    capability: {
      targets: [
        {
          target: 'SAGEMAKER_REALTIME',
          label: 'Managed endpoint — Amazon SageMaker',
          available: false,
          reason: 'The SageMaker deployment adapter is not implemented yet.',
        },
      ],
      canCreatePlans: false,
      note: 'Creating the resources is not implemented yet.',
    },
    storeConfigured: true,
  },
});

function renderApp(route: string, options: { auth?: FakeAuthClient; handler?: ActionHandler } = {}) {
  const auth = options.auth ?? new FakeAuthClient({ initial: makeSession() });
  const { fetchImpl, invocations } = recordingTransport(options.handler ?? HANDLER);
  const client = new AgentCoreClient({
    config: configFixture,
    getAccessToken: async () => 'access-token-1',
    fetchImpl,
    sessionId: 'eddie-testsessionidtestsessionidtest01',
  });
  return {
    auth,
    invocations,
    ...render(
      <MemoryRouter initialEntries={[route]}>
        <NotificationsProvider>
          <AuthProvider client={auth}>
            <App config={configFixture} client={client} />
          </AuthProvider>
        </NotificationsProvider>
      </MemoryRouter>
    ),
  };
}

function renderShell() {
  const { fetchImpl } = recordingTransport(HANDLER);
  const client = new AgentCoreClient({
    config: configFixture,
    getAccessToken: async () => 'access-token-1',
    fetchImpl,
    sessionId: 'eddie-testsessionidtestsessionidtest01',
  });
  const auth = new FakeAuthClient({ initial: makeSession() });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <NotificationsProvider>
        <AuthProvider client={auth}>
          <AppProvider config={configFixture} client={client}>
            <ConversationsProvider>
              <DetailPanelProvider>
                <AppShell>
                  <div>content</div>
                </AppShell>
              </DetailPanelProvider>
            </ConversationsProvider>
          </AppProvider>
        </AuthProvider>
      </NotificationsProvider>
    </MemoryRouter>
  );
}

describe('navigation has two destinations, not eight', () => {
  it('offers a new project and Deployments', () => {
    renderShell();
    const navigation = screen.getByRole('navigation');
    expect(screen.getByText('New project')).toBeInTheDocument();
    expect(screen.getByText('Deployments')).toBeInTheDocument();

    // The destinations the redesign removes. Each was a top-level peer of Chat.
    for (const removed of [
      'Case workspace',
      'Comparison',
      'Price evidence',
      'Model catalog',
      'Knowledge',
      'Demo lifecycle',
    ]) {
      expect(navigation.textContent).not.toContain(removed);
    }
    // And the grouping that made it read as a console.
    for (const group of ['Evaluate', 'Evidence', 'Operate', 'Resources']) {
      expect(navigation.textContent).not.toContain(group);
    }
  });

  it('shows no diagnostics on an ordinary screen', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByRole('navigation')).toBeInTheDocument());
    // Region, solver, release, COA and demo state are operator concerns, in Settings.
    expect(screen.queryByText(/Region us-east-1/)).toBeNull();
    expect(screen.queryByText(/^Solver /)).toBeNull();
    expect(screen.queryByText(/Knowledge NOT_INSTALLED/)).toBeNull();
    expect(screen.queryByText(/Demo SLEEPING/)).toBeNull();
  });

  it('keeps the EDDIE wordmark, without printing the name twice', () => {
    const { container } = renderShell();
    // The identity is an image whose `alt` carries the accessible name. Cloudscape
    // does not render the logo in jsdom, so its appearance is verified in the browser
    // suite; here we pin that no duplicate text wordmark was introduced.
    const identity = container.querySelector('#eddie-top-navigation') as HTMLElement;
    expect(within(identity).queryAllByText('EDDIE', { exact: true })).toHaveLength(0);
  });

  it('offers Tools as a utility rather than a destination', async () => {
    renderShell();
    // In the top bar, not the navigation list: a direct GPU question should not
    // require choosing a destination first.
    // Cloudscape's AppLayout also renders a "Tools" drawer heading, so the utility is
    // located by its trigger rather than by bare text.
    expect(
      screen.getAllByText('Tools').length
    ).toBeGreaterThan(0);
    expect(screen.getByRole('navigation').textContent).not.toContain('Tools');
  });

  it('offers sign-out and Settings under the signed-in identity', async () => {
    renderShell();
    await waitFor(() =>
      expect(
        screen.getAllByLabelText(/Signed in as test-user@example.test/).length
      ).toBeGreaterThan(0)
    );
  });
});

describe('routing', () => {
  it('lands on project details with the Advisor closed', async () => {
    renderApp('/');
    await waitFor(
      () => expect(screen.getByRole('heading', { name: 'Your AI project' })).toBeInTheDocument(),
      { timeout: 15_000 }
    );
    expect(screen.getByLabelText('Your goal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EDDIE Advisor' })).toBeInTheDocument();
    expect(screen.queryByRole('log', { name: 'Advisor conversation' })).toBeNull();
    expect(screen.queryByText('What are you building?')).toBeNull();
  }, 20_000);

  it('opens the optional Advisor beside the project form', async () => {
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'EDDIE Advisor' }));
    expect(await screen.findByRole('heading', { name: 'EDDIE Advisor' })).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Advisor conversation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your goal')).toBeInTheDocument();
  });

  it('restores the same project from an old conversation bookmark', async () => {
    const { invocations } = renderApp('/c/saved-support-project');
    await screen.findByRole('heading', { name: 'Your AI project' });
    await waitFor(() => expect(invocations).toContainEqual(expect.objectContaining({
      action: 'case.get',
      payload: expect.objectContaining({ caseId: 'saved-support-project' }),
    })));
    expect(screen.queryByRole('log', { name: 'Advisor conversation' })).toBeNull();
  });

  it('opens saved project details from Recent and respects staying or discarding an unsaved edit', async () => {
    const projects: SavedProject[] = [
      { caseId: 'project-cedar', title: 'Cedar support', revision: 'cedar-1' },
      { caseId: 'project-maple', title: 'Maple search', revision: 'maple-1' },
    ].map((project) => ({
      ...project,
      savedAt: '2026-09-19T17:00:00Z',
      document: {
        form: { ...EMPTY_PROJECT, caseId: project.caseId, description: project.title },
        decision: null, turns: [], draft: '', inspection: null,
        fieldOrigins: {}, evaluationDraft: EMPTY_EVALUATION,
      },
    }));
    const handler: ActionHandler = (action, payload, stream) => {
      if (action === 'case.list') return okEnvelope(action, { projects, hasMore: false });
      if (action === 'case.get') return okEnvelope(action, {
        project: projects.find((project) => project.caseId === (payload as { caseId: string }).caseId) ?? null,
      });
      if (action === 'chat.history') return okEnvelope(action, {});
      return HANDLER(action, payload, stream);
    };
    const { invocations } = renderApp('/requirements?case=project-cedar&view=needs', { handler });
    const goal = await screen.findByRole('textbox', { name: 'Your goal' });
    await waitFor(() => expect(goal).toHaveValue('Cedar support'));
    const maple = await screen.findByRole('link', { name: 'Maple search' });
    expect(maple).toHaveAttribute('href', '/requirements?case=project-maple&view=needs');

    await userEvent.clear(goal);
    await userEvent.type(goal, 'Unsaved Cedar changes');
    await userEvent.click(maple);
    expect(await screen.findByRole('dialog', { name: 'Save this project before leaving?' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(goal).toHaveValue('Unsaved Cedar changes');

    await userEvent.click(maple);
    await userEvent.click(await screen.findByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your goal' })).toHaveValue('Maple search'));
    expect(screen.queryByRole('log', { name: 'Advisor conversation' })).toBeNull();
    await userEvent.click(await screen.findByRole('link', { name: 'Cedar support' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your goal' })).toHaveValue('Cedar support'));
    expect(invocations.some((call) => call.action === 'case.save')).toBe(false);
  });

  it('shows no technical model fields on first use', async () => {
    renderApp('/');
    await waitFor(
      () => expect(screen.getByRole('heading', { name: 'Your AI project' })).toBeInTheDocument(),
      { timeout: 15_000 }
    );
    // UXR-14's simplicity gate: no architecture, parameter or weight fields, and no
    // case id, before the user has said anything.
    expect(screen.queryByText(/Architecture/)).toBeNull();
    expect(screen.queryByText(/parameters/i)).toBeNull();
    expect(screen.queryByText(/Case ID/i)).toBeNull();
    expect(screen.queryByText(/case-001/)).toBeNull();
  }, 20_000);

  it('renders Deployments with a truthful empty state', async () => {
    renderApp('/deployments');
    await waitFor(
      () => expect(screen.getByText('Nothing deployed yet')).toBeInTheDocument(),
      { timeout: 15_000 }
    );
    // The capability report comes from the backend, so an unavailable target says so
    // rather than offering a control that fails.
    expect(screen.getAllByText(/not implemented yet/).length).toBeGreaterThan(0);
    expect(screen.getByText('Not available in this installation')).toBeInTheDocument();
  }, 20_000);

  it('renders Settings, where the operator detail now lives', async () => {
    renderApp('/settings');
    await waitFor(
      () => expect(screen.getByText('This installation')).toBeInTheDocument(),
      { timeout: 15_000 }
    );
    expect(screen.getByRole('button', { name: 'EDDIE infrastructure' })).toBeInTheDocument();
    // Labelled so it cannot be mistaken for deploying a workload.
    expect(
      screen.getByText(/does not deploy or affect any model you are hosting/)
    ).toBeInTheDocument();
  }, 20_000);

  it('opens a tool directly, without a model intake form', async () => {
    renderApp('/tools/find-gpu');
    await waitFor(
      () => expect(screen.getByText('Find GPU capacity')).toBeInTheDocument(),
      { timeout: 15_000 }
    );
    // Not implemented, and it says why rather than showing an empty page.
    expect(screen.getByTestId('tool-unavailable')).toBeInTheDocument();
  }, 20_000);

  it('explains an unknown route instead of rendering a blank page', async () => {
    renderApp('/no-such-page');
    await waitFor(() =>
      expect(screen.getByText('Page not found')).toBeInTheDocument()
    );
  });
});

describe('legacy links keep working (UXR-13)', () => {
  it.each([
    // /case was the old dedicated requirements page, and that is a page again, so the
    // old link goes back to the thing it used to be rather than to the conversation.
    ['/case', 'Your AI project'],
    ['/comparison', 'Your AI project'],
    ['/index.html', 'Your AI project'],
  ])('redirects %s to where its function now lives', async (route, expected) => {
    renderApp(route);
    await waitFor(
      () => expect(screen.getAllByText(expected).length).toBeGreaterThan(0),
      { timeout: 15_000 }
    );
  }, 20_000);

  it('redirects /catalog to the Find a model tool', async () => {
    renderApp('/catalog');
    await waitFor(
      () => expect(screen.getByText('Find a model')).toBeInTheDocument(),
      { timeout: 15_000 }
    );
  }, 20_000);

  it('redirects /rates to the Compare prices tool', async () => {
    renderApp('/rates');
    await waitFor(
      () => expect(screen.getByText('Compare prices')).toBeInTheDocument(),
      { timeout: 15_000 }
    );
  }, 20_000);

  it.each([['/knowledge'], ['/demo']])(
    'redirects %s into Settings, where administration lives',
    async (route) => {
      renderApp(route);
      await waitFor(
        () => expect(screen.getByText('This installation')).toBeInTheDocument(),
        { timeout: 15_000 }
      );
    },
    20_000
  );
});

function removalAccount() {
  const projects: SavedProject[] = ['Cedar', 'Maple'].map((name) => ({
    caseId: `project-${name.toLowerCase()}`, title: `${name} support`, revision: `${name}-1`,
    savedAt: '2026-09-20T06:00:00Z',
    document: {
      form: { ...EMPTY_PROJECT, caseId: `project-${name.toLowerCase()}`, description: `${name} support` },
      decision: null, turns: [], draft: '', inspection: null,
      fieldOrigins: {}, evaluationDraft: EMPTY_EVALUATION,
    },
  }));
  const removed = new Set<string>();
  const handler: ActionHandler = (action, payload, stream) => {
    const { caseId } = payload as { caseId: string };
    if (action === 'case.list') return okEnvelope(action, {
      projects: projects.filter((project) => !removed.has(project.caseId)),
      removedCaseIds: [...removed], hasMore: false,
    });
    if (action === 'case.get') return okEnvelope(action, {
      project: removed.has(caseId) ? null : projects.find((project) => project.caseId === caseId) ?? null,
      removed: removed.has(caseId),
    });
    if (action === 'case.remove') {
      removed.add(caseId);
      return okEnvelope(action, { caseId, removed: true });
    }
    if (action === 'chat.history') return okEnvelope(action, {});
    return HANDLER(action, payload, stream);
  };
  return { handler, removed, projects };
}

describe('Remove from Recent', () => {
  it('confirms without opening the row, supports Cancel, and persists removal across remounts', async () => {
    const account = removalAccount();
    const first = renderApp('/requirements?case=project-cedar&view=needs', { handler: account.handler });
    await waitFor(() => expect(screen.getByLabelText('Your goal')).toHaveValue('Cedar support'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Maple support' }));
    let dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
    expect(within(dialog).getByText(/Running deployments stay available/)).toBeVisible();
    expect(first.invocations.filter((call) => call.action === 'case.get').some(
      (call) => (call.payload as { caseId: string }).caseId === 'project-maple'
    )).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(account.removed.size).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Maple support' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Maple support' })).toBeNull());
    expect(screen.getByLabelText('Your goal')).toHaveValue('Cedar support');
    expect(first.invocations).toContainEqual(expect.objectContaining({
      action: 'case.remove', payload: { caseId: 'project-maple', expectedRevision: 'Maple-1' },
    }));
    expect(first.invocations.some((call) => call.action === 'deployment.delete' || call.action === 'case.save')).toBe(false);
    first.unmount();
    renderApp('/requirements?case=project-cedar&view=needs', { handler: account.handler });
    await screen.findByRole('link', { name: 'Cedar support' });
    expect(screen.queryByRole('link', { name: 'Maple support' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    expect(screen.queryByRole('option', { name: /Maple support/ })).toBeNull();
  });

  it('removes the active draft without another save prompt and opens remaining project details', async () => {
    const account = removalAccount();
    const { invocations } = renderApp('/requirements?case=project-cedar&view=needs', { handler: account.handler });
    await waitFor(() => expect(screen.getByLabelText('Your goal')).toHaveValue('Cedar support'));
    await userEvent.type(screen.getByLabelText('Your goal'), ' unsaved edits');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Cedar support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByLabelText('Your goal')).toHaveValue('Maple support'));
    expect(screen.queryByRole('dialog', { name: 'Save this project before leaving?' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Cedar support' })).toBeNull();
    expect(screen.queryByRole('log', { name: 'Advisor conversation' })).toBeNull();
    expect(loadCase({
      userPoolId: configFixture.userPoolId, sub: makeSession().sub, caseId: 'project-cedar',
    }).data).toBeNull();
    expect(invocations.some((call) => call.action === 'case.save')).toBe(false);
  });

  it('keeps the project and draft when the server refuses removal', async () => {
    const account = removalAccount();
    const handler: ActionHandler = (action, payload, stream) => action === 'case.remove'
      ? failEnvelope(action, 'save_conflict', 'The project changed. Review it and try Remove again.')
      : account.handler(action, payload, stream);
    renderApp('/requirements?case=project-cedar&view=needs', { handler });
    await waitFor(() => expect(screen.getByLabelText('Your goal')).toHaveValue('Cedar support'));
    await userEvent.type(screen.getByLabelText('Your goal'), ' kept');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Cedar support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('Project could not be removed')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('link', { name: 'Cedar support' })).toBeVisible();
    expect(screen.getByLabelText('Your goal')).toHaveValue('Cedar support kept');
    expect(account.removed.size).toBe(0);
  });

  it('honors account removals over stale browser drafts and follows pages containing only removed projects', async () => {
    const account = removalAccount();
    account.removed.add('project-cedar');
    saveCase({ userPoolId: configFixture.userPoolId, sub: makeSession().sub, caseId: 'project-cedar' },
      account.projects[0].document);
    const handler: ActionHandler = (action, payload, stream) => {
      if (action === 'case.list' && !(payload as { afterCaseId?: string }).afterCaseId) {
        return okEnvelope(action, { projects: [], removedCaseIds: ['project-cedar'],
          hasMore: true, nextCaseId: 'project-cedar' });
      }
      return account.handler(action, payload, stream);
    };
    const { invocations } = renderApp('/requirements?case=project-cedar&view=needs', { handler });
    await screen.findByRole('link', { name: 'Maple support' });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Cedar support' })).toBeNull());
    expect(invocations).toContainEqual(expect.objectContaining({
      action: 'case.list', payload: { afterCaseId: 'project-cedar' },
    }));
    expect(screen.queryByRole('dialog', { name: 'Save this project before leaving?' })).toBeNull();
  });
});

describe('authentication gate', () => {
  it('shows only the sign-in screen when there is no session', async () => {
    renderApp('/', { auth: new FakeAuthClient({ initial: null }) });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    );
    expect(screen.queryByText('Your AI project')).toBeNull();
    expect(screen.queryByText('Deployments')).toBeNull();
  });

  it('states that accounts are administrator-created, with no sign-up link', async () => {
    renderApp('/', { auth: new FakeAuthClient({ initial: null }) });
    await waitFor(() =>
      expect(
        screen.getByText(/Accounts are created by an administrator/)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/Sign up/i)).toBeNull();
  });

  it('shows a restoring state rather than flashing the sign-in screen', () => {
    const auth = new FakeAuthClient({ initial: null });
    auth.restore = () => new Promise(() => {});
    renderApp('/', { auth });
    expect(screen.getByText('Restoring your session.')).toBeInTheDocument();
  });

  it('requires a new password for an administrator-created account', async () => {
    const auth = new FakeAuthClient({
      initial: null,
      signInOutcome: {
        status: 'CHALLENGE',
        challenge: { kind: 'NEW_PASSWORD_REQUIRED' },
      },
    });
    renderApp('/', { auth });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    );
    await userEvent.type(screen.getByLabelText('Username'), 'new-user');
    await userEvent.type(screen.getByLabelText('Password'), 'Temp-Pass-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByText('Set a new password')).toBeInTheDocument()
    );
  });

  it('asks for the authenticator code when MFA is required', async () => {
    const auth = new FakeAuthClient({
      initial: null,
      signInOutcome: {
        status: 'CHALLENGE',
        challenge: { kind: 'SOFTWARE_TOKEN_MFA' },
      },
    });
    renderApp('/', { auth });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    );
    await userEvent.type(screen.getByLabelText('Username'), 'u');
    await userEvent.type(screen.getByLabelText('Password'), 'p');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(
        screen.getByText('Enter your verification code')
      ).toBeInTheDocument()
    );
  });
});
