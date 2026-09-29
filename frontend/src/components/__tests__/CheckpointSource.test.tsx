import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointSource } from '../CheckpointSource';
import { TestDeployment } from '../TestDeployment';
import { ProjectTests } from '../ProjectTests';
import { renderWithProviders, okEnvelope, failEnvelope } from '../../test/harness';
import { useCase } from '../../state/CaseContext';
import { EMPTY_PROJECT } from '../../state/caseForm';
import type { ModelInspectionResult } from '../../api/types';
import { patchAfterModelChange, patchFromInspection } from '../../state/modelInspection';

const source = `s3://test-library/checkpoints/eddie-test/shared/acme/${'a'.repeat(64)}/manifest.json`;
const field = (value: string) => ({ origin: 'DETECTED' as const, value, sourceUrl: null, detail: 'Test fixture' });
const inspection: ModelInspectionResult = {
  source, repo: source, revision: 'b'.repeat(64), retrievedAt: '2026-09-20T00:00:00Z',
  ok: true, error: null, access: 'PRIVATE', accessDetail: 'Authorized library', weightFiles: 1, notes: [],
  fields: { architecture: field('Qwen2ForCausalLM'), totalParamsB: field('1.54'),
    contextTokens: field('32768'), weightsGb: field('2.88'), precision: field('BF16'), licenseId: field('apache-2.0') },
  checkpoint: { source, name: 'Acme teaching checkpoint', revision: 'b'.repeat(64),
    manifestVersionId: 'version', artifactFormat: 'merged-checkpoint', customization: 'fine-tuned',
    baseModel: { source: 'Qwen/Qwen2.5-1.5B-Instruct', revision: 'c'.repeat(40) },
    lineage: { trainingRun: 'test-only', trainingDataSha256: 'd'.repeat(64) },
    lineageStatus: 'SUPPLIED', fullContentVerified: false },
};
function Probe() {
  const { form } = useCase();
  return <pre data-testid="form">{JSON.stringify(form)}</pre>;
}
function ChangeCheckpointRevision() {
  const { patch } = useCase();
  return <button onClick={() => patch({ artifactDigest: 'e'.repeat(64) })}>Change checkpoint revision</button>;
}

describe('Private fine-tuned checkpoints', () => {
  it('selects a checkpoint manually, keeps base identity separate and sends its digest to the case', async () => {
    const onCompare = vi.fn();
    const { invocations } = renderWithProviders(<><CheckpointSource onCompare={onCompare} /><Probe /></>, {
      withCase: true, initialForm: EMPTY_PROJECT,
      handler: (action) => {
        if (action === 'checkpoint.list') return okEnvelope(action, {
          checkpoints: [{ source, label: 'acme-teaching', library: 'Shared library' }], truncated: false, note: '',
        });
        if (action === 'checkpoint.inspect') return okEnvelope(action, inspection);
        return okEnvelope(action, {});
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Choose a checkpoint/ }));
    await user.click(await screen.findByRole('option', { name: /acme-teaching/ }));
    await user.click(screen.getByRole('button', { name: 'Read checkpoint details' }));
    await screen.findByText('Checkpoint details read');
    expect(screen.getByText('Acme teaching checkpoint')).toBeInTheDocument();
    expect(screen.getByText('Qwen/Qwen2.5-1.5B-Instruct')).toBeInTheDocument();
    const form = JSON.parse(screen.getByTestId('form').textContent!);
    expect(form).toMatchObject({ sourceKind: 'checkpoint', sourceLocation: source, modelStage: 'fine-tuned',
      artifactDigest: 'b'.repeat(64), hfRepo: '', hfCommit: '' });
    expect(invocations.find((row) => row.action === 'checkpoint.inspect')?.payload).toEqual({ source });
    expect(invocations.some((row) => row.action === 'inspect_model' || row.action === 'chat')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Compare hosting for this checkpoint' }));
    expect(onCompare).toHaveBeenCalledOnce();
  });

  it('offers recovery if the library cannot be read without pretending that it is empty', async () => {
    renderWithProviders(<CheckpointSource onCompare={() => {}} />, {
      withCase: true, initialForm: EMPTY_PROJECT,
      handler: (action) => action === 'checkpoint.list'
        ? failEnvelope(action, 'unavailable', 'unavailable') : okEnvelope(action, {}),
    });
    await screen.findByText('The checkpoint library could not be loaded');
    expect(screen.getByRole('button', { name: 'Refresh library' })).toBeEnabled();
  });

  it('does not offer to replace a committed fine-tune with an unchanged small model', async () => {
    renderWithProviders(<TestDeployment capability={{
      canCreatePlans: true, targets: [], note: '',
      recipes: [{ id: 'stock', version: '1', models: ['Qwen/Qwen2.5-0.5B-Instruct'],
        region: 'us-east-1', instanceType: 'ml.g5.2xlarge', maximumLifetimeMinutes: 60 }],
    }} onStarted={() => {}} />, {
      withCase: true, initialForm: { ...EMPTY_PROJECT, modelStage: 'fine-tuned' },
      handler: (action) => okEnvelope(action, action === 'plan.list' ? { plans: [] } : {}),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose your fine-tuned checkpoint' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Choose Qwen2.5 0.5B for this project' })).not.toBeInTheDocument();
  });

  it('clears old checkpoint identity and supplied latency when a model changes', () => {
    expect(patchAfterModelChange()).toMatchObject({ artifactDigest: '', sourceLocation: '',
      provideLatencyEvidence: false, latencyEvidence: [] });
    expect(patchFromInspection(inspection)).toMatchObject({ artifactDigest: 'b'.repeat(64), hfRepo: '' });
  });

  it('records the checkpoint revision in a quality report and marks it stale when those weights change', async () => {
    const { invocations } = renderWithProviders(<><ProjectTests onHosting={() => {}} /><ChangeCheckpointRevision /></>, {
      withCase: true,
      initialForm: { ...EMPTY_PROJECT, ...patchFromInspection(inspection) },
      handler: (action) => okEnvelope(action, action === 'evaluation.score' ? {
        evaluationId: 'supplied-report', scorerVersion: 'exact-answer/1',
        provenance: 'SUPPLIED_OUTPUTS', modelInvoked: false, latencyMeasured: false,
        total: 1, passed: 1, failed: 0, matchPercent: '100', targetPercent: '95',
        sampleTargetMet: true, confidence95Percent: [20.65, 100], results: [],
        note: 'Supplied test answers only.',
      } : {}),
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Example 1 expected answer' }), 'home');
    await user.type(screen.getByRole('textbox', { name: 'Example 1 actual answer' }), 'home');
    await user.click(screen.getByRole('button', { name: 'Score supplied answers' }));
    await screen.findByText('Supplied test answers only.');
    expect(invocations.find((row) => row.action === 'evaluation.score')?.payload).toMatchObject({
      model: { source, revision: 'b'.repeat(64) },
    });
    await user.click(screen.getByRole('button', { name: 'Change checkpoint revision' }));
    expect(screen.getByText('These results are for earlier inputs')).toBeVisible();
  });
});
