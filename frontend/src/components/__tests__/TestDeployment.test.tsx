import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectWorkspace from '../../pages/ProjectWorkspace';
import { caseFingerprint } from '../TestDeployment';
import { EMPTY_PROJECT } from '../../state/caseForm';
import { defaultHandler, okEnvelope, renderWithProviders } from '../../test/harness';
import { healthFixture } from '../../test/fixtures';
import type { DeploymentPlanReview } from '../../api/types';

beforeAll(() => {
  // Exercise real SHA-256; jsdom's Crypto object lacks SubtleCrypto.
  Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
});

const initialForm = {
  ...EMPTY_PROJECT, hfRepo: 'Qwen/Qwen2.5-0.5B-Instruct', modelName: 'Qwen2.5 0.5B Instruct',
  hfCommit: 'b'.repeat(40), permittedRegions: 'us-east-1',
};
const capability = {
  targets: [{ target: 'SAGEMAKER_REALTIME', label: 'SageMaker', available: true, reason: 'Installed' }],
  canCreatePlans: true, note: 'Trials only',
  recipes: [{ id: 'recipe', version: '1', models: [initialForm.hfRepo], region: 'us-east-1',
    instanceType: 'ml.g5.2xlarge', maximumLifetimeMinutes: 60 }],
};

function review(identity: string): DeploymentPlanReview {
  return {
    plan: {
      planId: 'plan-one', planHash: 'd'.repeat(64), modelRef: initialForm.hfRepo,
      target: 'SAGEMAKER_REALTIME', kind: 'TRIAL', accountId: '123456789012', region: 'us-east-1',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), expired: false, approvable: true,
      evaluatedRequestHash: identity,
      envelope: { instanceType: 'ml.g5.2xlarge', maxInstanceCount: 1, maxSpendUsd: '5',
        maxLifetimeMinutes: 45, executionDeadlineMinutes: 25 },
      estimatedHourlyUsd: '1.52', estimatedSetupUsd: '0.50', checks: [], blockers: [], notes: [],
    },
    model: { source: initialForm.hfRepo, revision: initialForm.hfCommit, license: 'apache-2.0',
      licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/revision/LICENSE', bytes: 1000 },
    cost: { hostingEstimateUsd: '1.14', hourlyUsd: '1.52', admissionEstimateUsd: '2.02',
      additionalAllowanceUsd: '0.50', cleanupBufferMinutes: 15,
      priceEvidence: { amount: '1.52', unit: 'USD/Hrs', sku: 'test-price', source: 'unit fixture',
        retrievedAt: new Date().toISOString() } },
  };
}

function renderReview(saved?: DeploymentPlanReview, overrides = {}) {
  const fallback = defaultHandler({
    health: healthFixture,
    'deployment.list': { deployments: [], residual: null, storeConfigured: true, capability },
    'plan.list': { plans: saved ? [saved.plan] : [], capability },
    'plan.get': saved,
  });
  return renderWithProviders(<ProjectWorkspace />, {
    route: '/requirements?view=deployment', withCase: true,
    initialForm: { ...initialForm, ...overrides },
    handler: (action, payload, stream) => {
      if (action === 'plan.create') {
        return okEnvelope(action, review((payload as { caseFingerprint: string }).caseFingerprint));
      }
      return fallback(action, payload, stream);
    },
  });
}

describe('a reviewable Cloudscape deployment experience', () => {
  it('does not deploy while inspecting the review and requires both acknowledgments', async () => {
    const { invocations } = renderReview();
    const prepare = await screen.findByRole('button', { name: 'Review test deployment' });
    await waitFor(() => expect(prepare).toBeEnabled());
    await userEvent.click(prepare);
    expect(await screen.findByText('$1.14')).toBeVisible();
    const start = screen.getByRole('button', { name: 'Approve and start test' });
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I have reviewed/ }));
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I approve this test/ }));
    expect(start).toBeEnabled();
    expect(invocations.filter((call) => call.action === 'plan.approve' || call.action === 'deployment.start')).toHaveLength(0);
  });

  it('invalidates approval when a user changes a budget in another section', async () => {
    renderReview();
    const prepare = await screen.findByRole('button', { name: 'Review test deployment' });
    await waitFor(() => expect(prepare).toBeEnabled());
    await userEvent.click(prepare);
    await screen.findByText('$1.14');
    await userEvent.click(screen.getByRole('checkbox', { name: /I have reviewed/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /I approve this test/ }));
    await userEvent.click(screen.getByRole('tab', { name: 'Your needs' }));
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Hosting budget in USD' }), '200');
    await userEvent.click(screen.getByRole('tab', { name: 'Deploy & monitor' }));
    expect(await screen.findByText('Your settings changed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve and start test' })).toBeDisabled();
  });

  it('restores the saved plan on reload without restoring consent checkboxes', async () => {
    const identity = await caseFingerprint(JSON.stringify(Object.fromEntries(
      Object.entries(initialForm).sort(([a], [b]) => a.localeCompare(b)),
    )));
    renderReview(review(identity));
    expect(await screen.findByText('$1.14')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /I have reviewed/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve and start test' })).toBeDisabled();
  });

  it('does not overwrite a budget edited while a saved plan is still loading', async () => {
    const identity = await caseFingerprint(JSON.stringify(Object.fromEntries(
      Object.entries(initialForm).sort(([a], [b]) => a.localeCompare(b)),
    )));
    const saved = review(identity);
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    const fallback = defaultHandler({
      health: healthFixture,
      'deployment.list': { deployments: [], residual: null, storeConfigured: true, capability },
      'plan.list': { plans: [saved.plan], capability },
    });
    renderWithProviders(<ProjectWorkspace />, {
      route: '/requirements?view=deployment', withCase: true, initialForm,
      handler: async (action, payload, stream) => {
        if (action === 'plan.get') {
          reading = true;
          await pending;
          return okEnvelope(action, saved);
        }
        return fallback(action, payload, stream);
      },
    });
    await waitFor(() => expect(reading).toBe(true));
    const budget = screen.getByRole('spinbutton', { name: 'Test budget in USD' });
    await userEvent.clear(budget);
    await userEvent.type(budget, '0.50');
    await act(async () => { release(); });
    await waitFor(() => expect(Number((budget as HTMLInputElement).value)).toBe(0.5));
    expect(screen.queryByTestId('test-deployment-review')).not.toBeInTheDocument();
  });

  it('does not replace an unsupported model or Region behind the user’s back', async () => {
    const { invocations } = renderReview(undefined, { permittedRegions: 'us-west-2' });
    expect(await screen.findByText('This Region is not available for deployment here')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review test deployment' })).toBeDisabled();
    expect(invocations.filter((call) => call.action === 'plan.create')).toHaveLength(0);
  });
});
