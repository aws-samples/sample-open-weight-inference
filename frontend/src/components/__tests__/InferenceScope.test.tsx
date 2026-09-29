import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectBrief } from '../ProjectBrief';
import { useCase } from '../../state/CaseContext';
import { DEFAULT_FORM, EMPTY_PROJECT, emptyLatencyEntry, validateForm, type CaseFormState } from '../../state/caseForm';
import { defaultHandler, renderWithProviders } from '../../test/harness';

function FormProbe() {
  const { form } = useCase();
  return <output data-testid="inference-form">{JSON.stringify(form)}</output>;
}

function currentForm(): CaseFormState {
  return JSON.parse(screen.getByTestId('inference-form').textContent!);
}

function start(form: CaseFormState) {
  return renderWithProviders(<><ProjectBrief onModels={() => {}} /><FormProbe /></>, {
    withCase: true, initialForm: form,
    handler: defaultHandler({ 'case.get': {}, 'case.list': {} }),
  });
}

describe('inference-only intake', () => {
  it('treats an already fine-tuned model as inference without offering training', async () => {
    start(EMPTY_PROJECT);
    expect(screen.queryByLabelText('What kind of work do you need?')).toBeNull();
    expect(screen.queryByText('Train or fine-tune a model')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Has your model been customized/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Yes — we have fine-tuned weights' }));
    expect(currentForm()).toMatchObject({ modelStage: 'fine-tuned' });
    expect(currentForm().workloadType).not.toBe('training');
    expect(validateForm(currentForm()).some((issue) => issue.field === 'workloadType')).toBe(false);
    expect(screen.queryByText('Confirm the inference workload')).toBeNull();
  });

  it('does not add a new requirement to an older inference project on opening it', () => {
    start(DEFAULT_FORM);
    expect(currentForm()).toEqual(DEFAULT_FORM);
    expect(screen.queryByText('Confirm the inference workload')).toBeNull();
  });

  it.each(['training', 'both'] as const)(
    'keeps a legacy %s project readable but never reuses its job estimates',
    async (workloadType) => {
      const original = {
        ...DEFAULT_FORM, workloadType, modelStage: 'fine-tuned' as const,
        description: 'Host Acme’s existing fine-tuned model.',
        requests: '4500', requestsPerMinute: '25', concurrency: '4',
        billableCopyHours: '72', dedicatedInstanceHours: '72',
        inputTokensPerRequest: '500', outputTokensPerRequest: '100',
        provideSlo: true, sloThresholdMs: '5000', budgetUsd: '2000',
        provideLatencyEvidence: true,
        latencyEvidence: [{ ...emptyLatencyEntry('sagemaker-ml.g5.2xlarge'), p99Ms: '100' }],
      };
      const { invocations } = start(original);
      expect(screen.getByText('Confirm the inference workload')).toBeVisible();
      expect(currentForm().requests).toBe('4500');
      expect(validateForm(currentForm()).some((issue) => issue.field === 'workloadType')).toBe(true);

      await userEvent.click(screen.getByRole('button', { name: 'Use this project for inference' }));
      const updated = currentForm();
      expect(updated).toMatchObject({
        workloadType: 'inference', modelStage: 'fine-tuned',
        modelName: original.modelName, hfRepo: original.hfRepo,
        description: original.description, budgetUsd: original.budgetUsd,
        requests: '', requestsPerMinute: '', concurrency: '',
        inputTokensPerRequest: '', outputTokensPerRequest: '',
        billableCopyHours: '', dedicatedInstanceHours: '',
        trafficPattern: 'unknown', provideSlo: false, sloThresholdMs: '',
        provideLatencyEvidence: false, latencyEvidence: [],
      });
      expect(validateForm(updated).some((issue) => issue.field === 'workloadType')).toBe(false);
      expect(screen.queryByText('Confirm the inference workload')).toBeNull();
      expect(invocations.some((call) => call.action === 'evaluate')).toBe(false);
    }
  );
});
