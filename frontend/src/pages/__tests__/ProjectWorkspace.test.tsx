import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectWorkspace from '../ProjectWorkspace';
import { DEFAULT_FORM, EMPTY_PROJECT, toEvaluateRequest } from '../../state/caseForm';
import { evaluatedRequestChanges } from '../../state/evaluatedRequest';
import { renderWithProviders, defaultHandler, okEnvelope } from '../../test/harness';
import { healthFixture } from '../../test/fixtures';

const deployment = {
  deployments: [], residual: null, storeConfigured: false,
  capability: { targets: [], canCreatePlans: false, note: 'No execution adapter installed' },
};

function start(initialForm = EMPTY_PROJECT) {
  return renderWithProviders(<ProjectWorkspace />, {
    route: '/requirements',
    withCase: true,
    initialForm,
    handler: defaultHandler({ health: healthFixture, 'deployment.list': deployment }),
  });
}

describe('a workspace for beginners and experienced users', () => {
  it('starts with the customer task and no selected model or architecture homework', async () => {
    start();
    expect(await screen.findByRole('textbox', { name: 'Your goal' })).toBeVisible();
    expect(screen.getByText('You haven’t chosen one yet')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Architecture' })).toBeNull();
    expect(screen.queryByText('Llama 3.1 8B')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'All settings' })).toBeEnabled();
  });

  it('allows direct jumps with incomplete intake and never evaluates on navigation', async () => {
    const { invocations } = start();
    await userEvent.click(screen.getByRole('tab', { name: 'Tests' }));
    expect(screen.getByText('Check answer accuracy')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Compare hosting' }));
    expect(screen.getByText('A little more information is needed to calculate costs')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Models & sources' }));
    expect(screen.getByRole('textbox', { name: 'Hugging Face model source' })).toBeVisible();
    expect(invocations.filter((call) => call.action === 'evaluate' || call.action === 'inspect_model')).toHaveLength(0);
  });

  it('preserves the project and test examples when moving freely through settings', async () => {
    start();
    await userEvent.type(screen.getByRole('textbox', { name: 'Your goal' }), 'Sort support requests');
    await userEvent.click(screen.getByRole('tab', { name: 'Tests' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Example 1 expected answer' }), 'billing');
    await userEvent.click(screen.getByRole('tab', { name: 'Your needs' }));
    expect(screen.getByRole('textbox', { name: 'Your goal' })).toHaveValue('Sort support requests');
    await userEvent.click(screen.getByRole('button', { name: 'All settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Tests' }));
    expect(screen.getByRole('textbox', { name: 'Example 1 expected answer' })).toHaveValue('billing');
  });

  it('lets an expert edit all settings without completing a guided sequence', async () => {
    const { invocations } = start(DEFAULT_FORM);
    await userEvent.click(screen.getByRole('button', { name: 'All settings' }));
    expect(screen.getByRole('combobox', { name: 'Which model do you want to use?' })).toHaveValue(DEFAULT_FORM.modelName);
    expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(0);
  });

  it('represents private connections as unavailable capabilities, not successful connections', async () => {
    const { invocations } = start();
    await userEvent.click(screen.getByRole('tab', { name: 'Models & sources' }));
    await userEvent.click(screen.getByRole('button', { name: 'Your fine-tuned model' }));
    await userEvent.click(screen.getByRole('button', { name: 'Another company source or vendor integration' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Company model source' }), 's3://company-models/my-model/');
    expect(screen.getByText('Private source access needs an adapter')).toBeVisible();
    expect(invocations.filter((call) => call.action === 'inspect_model')).toHaveLength(0);
  });

  it('carries the quality goal, token mix and exact revision into evaluation identity', () => {
    const form = {
      ...DEFAULT_FORM, successCriteria: 'Correct category in at least 95% of examples',
      requests: '2880', inputTokensPerRequest: '500', outputTokensPerRequest: '200',
      hfCommit: 'commit-a',
    };
    const request = toEvaluateRequest(form);
    expect(request.qualityGoal).toBe(form.successCriteria);
    expect(request.workload).toMatchObject({ requests: '2880', inputTokensPerRequest: '500', outputTokensPerRequest: '200' });
    expect(request.model.hfCommit).toBe('commit-a');
    expect(evaluatedRequestChanges(request, toEvaluateRequest({ ...form, successCriteria: 'Different quality goal' }))).toContain('Answer-quality goal');
    expect(evaluatedRequestChanges(request, toEvaluateRequest({ ...form, hfCommit: 'commit-b' }))).toContain('Model revision');
  });

  it('scores supplied answers only after an explicit action and labels the evidence', async () => {
    const fallback = defaultHandler({ health: healthFixture });
    const { invocations } = renderWithProviders(<ProjectWorkspace />, {
      withCase: true, initialForm: EMPTY_PROJECT, route: '/requirements?view=tests',
      handler: (action, payload, stream) => action === 'evaluation.score' ? okEnvelope(action, {
        evaluationId: 'example-report', scorerVersion: 'exact-answer/1',
        provenance: 'SUPPLIED_OUTPUTS', modelInvoked: false, latencyMeasured: false,
        total: 1, passed: 1, failed: 0, matchPercent: '100.00', targetPercent: '95',
        sampleTargetMet: true, confidence95Percent: [20.65, 100], results: [],
        note: 'EDDIE scored supplied responses. It did not invoke a model.',
      }) : fallback(action, payload, stream),
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Question or task' }), 'What is this charge?');
    await userEvent.type(screen.getByRole('textbox', { name: 'Example 1 expected answer' }), 'billing');
    await userEvent.type(screen.getByRole('textbox', { name: 'Example 1 actual answer' }), 'billing');
    expect(invocations.filter((call) => call.action === 'evaluation.score')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Score supplied answers' }));
    await waitFor(() => expect(screen.getByText('EDDIE scored supplied responses. It did not invoke a model.')).toBeVisible());
    expect(invocations.find((call) => call.action === 'evaluation.score')?.payload).toMatchObject({
      examples: [{ input: 'What is this charge?', expected: 'billing', actual: 'billing' }],
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Example 1 actual answer' }), ' changed');
    expect(screen.getByText('These results are for earlier inputs')).toBeVisible();
  });
});
