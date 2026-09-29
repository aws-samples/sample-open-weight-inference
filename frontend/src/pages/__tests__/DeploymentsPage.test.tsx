import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeploymentsPage from '../DeploymentsPage';
import { defaultHandler, okEnvelope, renderWithProviders } from '../../test/harness';
import { healthFixture } from '../../test/fixtures';
import type { DeploymentView } from '../../api/types';

function job(state: DeploymentView['state']): DeploymentView {
  return {
    jobId: 'job-existing', planId: 'plan-existing', projectId: 'user:alice',
    target: 'SAGEMAKER_REALTIME', modelRef: 'Qwen/Qwen2.5-0.5B-Instruct',
    region: 'us-east-1', state, createdAt: '2026-09-19T00:00:00Z',
    updatedAt: '2026-09-19T00:01:00Z', deadlineAt: '2026-09-19T00:25:00Z',
    resourceExpiresAt: '2026-09-19T00:45:00Z', resourcesExpired: false,
    steps: [], resources: [], billableResourceCount: 0,
    failureReason: null, publishedRoute: null,
  };
}

function renderJobs(read: () => DeploymentView[]) {
  const fallback = defaultHandler({ health: healthFixture });
  return renderWithProviders(<DeploymentsPage />, {
    route: '/deployments', withCase: true,
    handler: (action, payload, stream) => action === 'deployment.list'
      ? okEnvelope(action, {
        deployments: read(), residual: null, storeConfigured: true,
        capability: { canCreatePlans: false, targets: [], note: '' },
      })
      : fallback(action, payload, stream),
  });
}

describe('deployment selection and cleanup continuity', () => {
  it('keeps old receipts in the table until the user opens one', async () => {
    renderJobs(() => [job('DELETED')]);
    const oldTest = await screen.findByRole('radio', { name: /Open Qwen/ });
    expect(screen.queryByTestId('deployment-details')).not.toBeInTheDocument();
    await userEvent.click(oldTest);
    expect(await screen.findByRole('heading', { name: 'Test removed' })).toBeVisible();
  });

  it('keeps the active test selected when AWS confirms its cleanup', async () => {
    let current = job('RUNNING');
    renderJobs(() => [current]);
    expect(await screen.findByRole('heading', { name: 'Setting up your test' })).toBeVisible();
    current = job('DELETED');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Cleanup confirmed', { exact: true })).toBeVisible();
  });
});
