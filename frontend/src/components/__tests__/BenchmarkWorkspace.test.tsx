import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BenchmarkWorkspace } from '../BenchmarkWorkspace';
import { useCase } from '../../state/CaseContext';
import { projectFingerprint } from '../../state/persistence';
import { failEnvelope, okEnvelope, renderWithProviders } from '../../test/harness';
import type { BenchmarkComparison, BenchmarkRun } from '../../api/benchmarks';

const run: BenchmarkRun = {
  schemaVersion: 'eddie-benchmark/1', runId: 'fixture-run', createdAt: '2026-01-01T00:00:00Z',
  configuration: { label: 'Fixture configuration', model: 'example/model', revision: 'test',
    runtime: 'fixture', harness: 'test/1', region: 'us-east-1', hardware: 'test', provider: 'external' },
  workload: { name: 'Authored example', datasetDigest: 'a'.repeat(64), rubricDigest: 'b'.repeat(64), taskIds: ['one'] },
  protocol: { repetitions: 1, concurrency: 1, maxOutputTokens: 10, temperature: 0,
    warmupRequests: 0, measurement: 'client_end_to_end', loadModel: 'closed_loop', acceptance: 'exact/1' },
  state: 'completed', durationSeconds: 1,
  samples: [{ taskId: 'one', repetition: 1, status: 'ok', accepted: true, elapsedMs: 100 }],
  cost: { basis: 'unknown', scope: 'benchmark_window' },
};
const comparison: BenchmarkComparison = {
  schemaVersion: 'eddie-benchmark/1', comparisonId: 'fixture-comparison', createdAt: '2026-01-01T00:00:00Z',
  provenance: 'SUPPLIED_MEASUREMENTS', deploymentQualified: false, workload: run.workload,
  settings: { minimumAcceptancePercent: 95, maximumP95Ms: null, maximumErrorPercent: 0, minimumTasks: 1 },
  rows: [], lowestCostEligibleRunIds: [], notes: ['Insufficient applicable pricing.'],
};

function Workspace() {
  const { restored, evaluationDraft, patchEvaluationDraft } = useCase();
  return <>
    {restored ? <button onClick={() => patchEvaluationDraft({ benchmarkRuns: [run] })}>Use test report</button> : null}
    <button onClick={() => patchEvaluationDraft(JSON.parse(projectFingerprint(evaluationDraft)))}>
      Restore serialized project
    </button>
    <BenchmarkWorkspace onHosting={() => {}} />
  </>;
}

describe('workload benchmark workspace', () => {
  it('validates imported observations before retaining them and reports server rejection', async () => {
    const { invocations } = renderWithProviders(<Workspace />, {
      withCase: true,
      handler: (action) => action === 'evaluation.compare'
        ? failEnvelope(action, 'invalid', 'The report contains unsupported fields.')
        : okEnvelope(action, {}),
    });
    const file = new File(['{"winner":"untrusted"}'], 'report.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{"winner":"untrusted"}' });
    await userEvent.upload(screen.getByLabelText('Benchmark report files'), file);
    expect(await screen.findByText(/The report contains unsupported fields/)).toBeVisible();
    expect(screen.queryByText('Compare the same workload')).not.toBeInTheDocument();
    expect(invocations.find((call) => call.action === 'evaluation.compare')?.payload)
      .toEqual({ runs: [{ winner: 'untrusted' }] });
  });

  it('ignores a comparison that completes after its thresholds changed', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const { invocations } = renderWithProviders(<Workspace />, {
      withCase: true,
      handler: (action) => action === 'evaluation.compare' ? pending : okEnvelope(action, {}),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Use test report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare benchmark runs' }));
    await waitFor(() => expect(invocations.some((call) => call.action === 'evaluation.compare')).toBe(true));
    const threshold = screen.getByRole('spinbutton', { name: 'Minimum accepted (%)' });
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '90');
    await act(async () => resolve(okEnvelope('evaluation.compare', comparison)));
    expect(await screen.findByText(/Inputs changed while comparing/)).toBeVisible();
    expect(screen.queryByText('Observed quality, speed and cost')).not.toBeInTheDocument();
  });

  it('marks a previous comparison stale and disables its export after editing targets', async () => {
    renderWithProviders(<Workspace />, {
      withCase: true,
      handler: (action) => okEnvelope(action, action === 'evaluation.compare' ? comparison : {}),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Use test report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare benchmark runs' }));
    await screen.findByText('Observed quality, speed and cost');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Maximum observed p95 (ms)' }), '500');
    expect(screen.getByText('Comparison inputs changed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export comparison' })).toBeDisabled();
  });

  it('keeps a current comparison exportable after sorted-key server serialization', async () => {
    renderWithProviders(<Workspace />, {
      withCase: true,
      handler: (action) => okEnvelope(action, action === 'evaluation.compare' ? comparison : {}),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Use test report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare benchmark runs' }));
    await screen.findByText('Observed quality, speed and cost');
    await userEvent.click(screen.getByRole('button', { name: 'Restore serialized project' }));
    expect(screen.queryByText('Comparison inputs changed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export comparison' })).toBeEnabled();
  });
});
