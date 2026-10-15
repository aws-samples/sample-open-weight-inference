import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import createWrapper from '@cloudscape-design/components/test-utils/dom';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { App } from '../../App';
import { AgentCoreClient } from '../../api/agentcore';
import { AuthProvider } from '../../auth/AuthContext';
import { NotificationsProvider } from '../../state/NotificationsContext';
import { configFixture, healthFixture } from '../../test/fixtures';
import {
  defaultHandler, FakeAuthClient, makeSession, recordingTransport, renderWithProviders,
} from '../../test/harness';
import { RequirementsUpdated } from '../ChatTurn';

function RouteControls({ legacyTarget }: { legacyTarget: string }) {
  const { pathname, search, hash } = useLocation();
  return <>
    <output data-testid="current-project-url">{pathname}{search}{hash}</output>
    <Link to={legacyTarget}>Open legacy project link</Link>
  </>;
}

function renderProject(route: string, legacyTarget = '/case') {
  const { fetchImpl, invocations } = recordingTransport(defaultHandler({
    health: healthFixture, 'case.get': {}, 'case.list': {}, 'chat.history': {}, 'evaluation.compare': {},
  }));
  const client = new AgentCoreClient({
    config: configFixture, getAccessToken: async () => 'access-token-1', fetchImpl,
  });
  render(
    <MemoryRouter initialEntries={[route]}>
      <NotificationsProvider>
        <AuthProvider client={new FakeAuthClient({ initial: makeSession() })}>
          <RouteControls legacyTarget={legacyTarget} />
          <App config={configFixture} client={client} />
        </AuthProvider>
      </NotificationsProvider>
    </MemoryRouter>
  );
  return invocations;
}

describe('project links from an existing workspace', () => {
  it('keeps the project and unsaved form visible when following the old bare /case link', async () => {
    renderProject('/requirements?case=project-advisor-link&view=needs');
    const goal = await screen.findByLabelText('Your goal');
    await userEvent.type(goal, 'Keep this project and its unsaved edits.');
    await userEvent.click(screen.getByRole('link', { name: 'Open legacy project link' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Your goal')).toHaveValue('Keep this project and its unsaved edits.');
      expect(screen.getByTestId('current-project-url')).toHaveTextContent(
        '/requirements?case=project-advisor-link'
      );
    });
    expect(createWrapper(document.body).findAllModals().some((modal) => modal.isVisible())).toBe(false);
  }, 20_000);

  it('preserves the project, section, query and fragment in a legacy bookmark', async () => {
    renderProject('/case?case=project-bookmark&view=tests&source=library#examples');
    await waitFor(() => expect(screen.getByTestId('current-project-url')).toHaveTextContent(
      '/requirements?case=project-bookmark&view=tests&source=library#examples'
    ));
    expect(await screen.findByRole('tab', { name: 'Tests' }))
      .toHaveAttribute('aria-selected', 'true');
  }, 20_000);

  it('still protects unsaved work when a legacy link requests another project', async () => {
    renderProject('/requirements?case=project-current&view=needs', '/case?case=project-other');
    await userEvent.type(await screen.findByLabelText('Your goal'), 'Keep my draft.');
    await userEvent.click(screen.getByRole('link', { name: 'Open legacy project link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this project before leaving?' });
    expect(createWrapper(document.body).findAllModals().some((modal) => modal.isVisible())).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }));
    await waitFor(() => {
      expect(createWrapper(document.body).findAllModals().some((modal) => modal.isVisible())).toBe(false);
      expect(screen.getByLabelText('Your goal')).toHaveValue('Keep my draft.');
      expect(screen.getByTestId('current-project-url')).toHaveTextContent(
        '/requirements?case=project-current&view=needs'
      );
    });
  }, 20_000);

  it('links the Advisor update directly to this project’s needs', async () => {
    renderWithProviders(
      <RequirementsUpdated changes={[{ field: 'requests', label: 'Requests', value: '4500' }]} />,
      { route: '/requirements?case=project-advisor-link&view=hosting' }
    );
    expect(screen.getByRole('link', { name: 'Edit in case workspace' })).toHaveAttribute(
      'href', '/requirements?case=project-advisor-link&view=needs'
    );
  });

  it('protects imported benchmark reports even when the project has no form or chat edits', async () => {
    renderProject('/requirements?case=project-benchmark-only&view=tests', '/case?case=project-other');
    const report = {
      schemaVersion: 'eddie-benchmark/1', runId: 'imported-run', createdAt: '2026-01-01T00:00:00Z',
      configuration: { label: 'Imported configuration', model: 'example/model', revision: 'test',
        runtime: 'fixture', harness: 'test/1', region: 'us-east-1', hardware: 'test', provider: 'external' },
      workload: { name: 'Authored example', datasetDigest: 'a'.repeat(64),
        rubricDigest: 'b'.repeat(64), taskIds: ['one'] },
      protocol: { repetitions: 1, concurrency: 1, maxOutputTokens: 10, temperature: 0,
        warmupRequests: 0, measurement: 'client_end_to_end', loadModel: 'closed_loop', acceptance: 'exact/1' },
      state: 'completed', durationSeconds: 1,
      samples: [{ taskId: 'one', repetition: 1, status: 'ok', accepted: true, elapsedMs: 100 }],
      cost: { basis: 'unknown', scope: 'benchmark_window' },
    };
    const content = JSON.stringify(report);
    const file = new File([content], 'benchmark.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => content });
    await userEvent.upload(await screen.findByLabelText('Benchmark report files'), file);
    await screen.findByText('Imported 1 report. Set your targets and compare.');
    await userEvent.click(screen.getByRole('link', { name: 'Open legacy project link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this project before leaving?' });
    expect(createWrapper(document.body).findAllModals().some((modal) => modal.isVisible())).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }));
    await waitFor(() => expect(screen.getByTestId('current-project-url')).toHaveTextContent(
      '/requirements?case=project-benchmark-only&view=tests'
    ));
    expect(screen.getByText('Imported configuration')).toBeVisible();
  }, 20_000);
});
