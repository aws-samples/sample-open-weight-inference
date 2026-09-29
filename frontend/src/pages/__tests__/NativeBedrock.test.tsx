import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import ProjectWorkspace from '../ProjectWorkspace';
import { DEFAULT_FORM } from '../../state/caseForm';
import { defaultHandler, okEnvelope, renderWithProviders } from '../../test/harness';
import { burstyResult, healthFixture } from '../../test/fixtures';
import type { EvaluateResponse } from '../../api/types';
import { HostingComparison } from '../../components/HostingComparison';

const id = 'amazon.nova-2-lite-v1:0';
const profile = `us.${id}`;
const regions = ['us-east-1', 'us-east-2', 'us-west-2'];
const catalog = {
  region: 'us-east-1', count: 1, note: 'Live catalog fixture',
  models: [{
    modelId: id, modelName: 'Nova 2 Lite', provider: 'Amazon',
    inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'],
    streamingSupported: true, inferenceTypes: ['INFERENCE_PROFILE'],
  }],
  inferenceProfiles: [
    { id: profile, name: 'US Amazon Nova 2 Lite', modelIds: [id], processingRegions: regions, global: false, status: 'ACTIVE' },
    { id: `global.${id}`, name: 'Global Amazon Nova 2 Lite', modelIds: [id], processingRegions: [], global: true, status: 'ACTIVE' },
  ],
};

const nativeResult: EvaluateResponse = {
  ...burstyResult, outcome: 'NO_QUALIFIED_PLACEMENT', winner: null, ranked: [], excluded: [], breakeven: null,
  checksStipulated: false, counts: { ranked: 0, unresolved: 1, excluded: 0 },
  unresolved: [{
    ...burstyResult.ranked[0], candidateId: 'native-fixture', target: 'BEDROCK_NATIVE',
    modelRef: id, instanceType: null, recipeId: null, cost: null,
    inferenceProfileId: profile, processingRegions: regions, isFeasible: false,
    gates: [{ name: 'quota', status: 'UNKNOWN', reason: 'Quota headroom not collected', evidenceRef: null }],
  }],
  nativePricing: [{
    candidateId: 'native-fixture', modelId: id, region: 'us-east-1',
    inferenceProfileId: profile, processingRegions: regions,
    inputRate: { amount: '0.33', unit: 'USD/million tokens', currency: 'USD', region: 'us-east-1', sku: 'fixture-input', source: 'AWS pricing fixture', effectiveDate: '2026-09-01' },
    outputRate: { amount: '2.75', unit: 'USD/million tokens', currency: 'USD', region: 'us-east-1', sku: 'fixture-output', source: 'AWS pricing fixture', effectiveDate: '2026-09-01' },
    missingUsage: ['Requests in the comparison period'], scope: 'Uncached Standard text',
    retrievedAt: '2026-09-19T00:00:00Z',
    pricingSource: 'https://aws.amazon.com/bedrock/pricing/',
    routingSource: 'https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html',
  }],
};

describe('manual Bedrock journey', () => {
  it('selects a catalog model and explicit US route without chat or stale artifact fields', async () => {
    const fallback = defaultHandler({
      health: healthFixture, catalog, 'case.get': {}, 'case.list': {}, 'chat.history': {},
      'deployment.list': { deployments: [] },
    });
    const { invocations } = renderWithProviders(<ProjectWorkspace />, {
      withCase: true, route: '/requirements?view=models',
      initialForm: { ...DEFAULT_FORM, provideSlo: false, requests: '30000', inputTokensPerRequest: '1000', outputTokensPerRequest: '250' },
      handler: (action, payload, streaming) => action === 'evaluate'
        ? okEnvelope(action, { ...nativeResult, evaluatedRequest: payload })
        : fallback(action, payload, streaming),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Amazon Bedrock' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use Nova 2 Lite' }));
    const compare = screen.getByRole('button', { name: 'Compare hosting for this model' });
    expect(compare).toBeDisabled();
    expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /Bedrock request route/ }));
    expect(screen.getByRole('option', { name: /Global Amazon Nova 2 Lite/ })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('option', { name: /US Amazon Nova 2 Lite/ }));
    await userEvent.click(compare);
    await waitFor(() => expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(1));
    expect(invocations.find((call) => call.action === 'evaluate')?.payload).toMatchObject({
      model: { name: id, sourceKind: 'bedrock', architecture: 'vendor-api', weightsExportable: false,
        hfRepo: null, hfCommit: null, totalParamsB: null, weightsGb: null, inferenceProfileId: profile },
      constraints: { permittedRegions: ['us-east-1'], permittedProcessingRegions: regions },
      workload: { requests: '30000', inputTokensPerRequest: '1000', outputTokensPerRequest: '250' },
    });
    expect(invocations.filter((call) => ['chat', 'inspect_model', 'plan.create', 'plan.approve'].includes(call.action))).toHaveLength(0);
    expect(await screen.findByText('How the Bedrock estimate was calculated')).toBeVisible();
    expect(screen.queryByText('Dedicated GPU · billed while running')).toBeNull();
  });

  it('shows token rates and a request for missing usage, never a zero total or a winner', () => {
    renderWithProviders(<HostingComparison result={nativeResult} loading={false} error={null}
      onRetry={() => {}} onCancel={() => {}} neverRun={false} />);
    expect(screen.getByText('$0.33 per million tokens')).toBeVisible();
    expect(screen.getByText('$2.75 per million tokens')).toBeVisible();
    expect(screen.getByText('Add usage for a total')).toBeVisible();
    expect(screen.getByText(/To calculate a total, enter:/)).toBeVisible();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText('Needs verification')).toBeVisible();
  });

  it('opens an older saved project directly from the workspace picker', async () => {
    function Location() { const location = useLocation(); return <output data-testid="project-location">{location.search}</output>; }
    renderWithProviders(<><ProjectWorkspace /><Location /></>, {
      withCase: true, caseId: 'newer-project', initialForm: { ...DEFAULT_FORM, caseId: 'newer-project' },
      route: '/requirements?case=newer-project&view=needs',
      handler: defaultHandler({
        health: healthFixture, 'case.get': {}, 'chat.history': {}, 'deployment.list': { deployments: [] },
        'case.list': { projects: [
          { caseId: 'newer-project', title: 'Newer Bedrock project', savedAt: '2026-09-19T14:00:00Z' },
          { caseId: 'older-project', title: 'Older Qwen project', savedAt: '2026-09-19T13:00:00Z' },
        ], hasMore: false },
      }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch project/ })).toHaveTextContent('Newer Bedrock project'));
    await userEvent.click(screen.getByRole('button', { name: /Switch project/ }));
    await userEvent.click(screen.getByRole('option', { name: /Older Qwen project/ }));
    expect(screen.getByTestId('project-location')).toHaveTextContent('case=older-project&view=needs');
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
  });

  it('keeps API usage edits controlled while moving between inputs', async () => {
    renderWithProviders(<ProjectWorkspace />, {
      withCase: true, route: '/requirements?view=hosting',
      initialForm: { ...DEFAULT_FORM, sourceKind: 'bedrock', architecture: 'vendor-api', modelName: id, weightsExportable: false, provideSlo: false },
      handler: defaultHandler({ health: healthFixture, 'case.get': {}, 'case.list': {}, 'deployment.list': { deployments: [] } }),
    });
    const fields = within(screen.getByTestId('native-usage'));
    const requests = fields.getByRole('spinbutton', { name: 'API requests during comparison period' });
    await userEvent.clear(requests);
    await userEvent.type(requests, '30000');
    await userEvent.type(fields.getByRole('spinbutton', { name: 'API average input tokens' }), '1000');
    expect(requests).toHaveValue(30000);
  });

  it('shows native API guidance even when GPU deployment is not installed', async () => {
    renderWithProviders(<ProjectWorkspace />, {
      withCase: true, route: '/requirements?view=deployment',
      initialForm: { ...DEFAULT_FORM, sourceKind: 'bedrock', architecture: 'vendor-api', modelName: id, weightsExportable: false },
      handler: defaultHandler({
        health: healthFixture, 'case.get': {}, 'case.list': {},
        'deployment.list': { deployments: [], capability: { canCreatePlans: false, targets: [], note: '' } },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Use your selected Bedrock model' })).toBeVisible();
    expect(screen.queryByText('Nothing deployed yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose Qwen2.5 0.5B for this project' })).toBeNull();
  });
});
