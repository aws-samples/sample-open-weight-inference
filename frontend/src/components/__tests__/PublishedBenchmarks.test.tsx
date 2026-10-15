import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PublishedBenchmarks } from '../PublishedBenchmarks';
import { failEnvelope, okEnvelope, renderWithProviders } from '../../test/harness';
import type { PublicBenchmarks, PublishedBenchmarkRow } from '../../api/publishedBenchmarks';

// Authored test metadata, never downloaded benchmark records.
const row = (id: string, eligible = true): PublishedBenchmarkRow => ({
  id, model: `Test model ${id}`, modelId: `fixture-${id}`, openWeights: true,
  harness: 'mini-SWE-agent', harnessVersion: 'test-1', reasoningEffort: 'Not supplied',
  date: '2026-01-01', sourceReviewFlag: null, tasks: eligible ? 500 : 499,
  outcomesConsistent: eligible, costsConsistent: eligible,
  resolved: eligible ? 300 : null, resolvedPercent: eligible ? 60 : null,
  publishedResolvedPercent: 60, resolutionInterval95: eligible ? [55.7, 64.3] : null,
  costPerTaskUsd: eligible ? '0.1' : null, costPerResolvedUsd: eligible ? '0.166667' : null,
  totalCostUsd: eligible ? '50' : null, taskSetDigest: eligible ? 'a'.repeat(64) : null,
  eligible, reasons: eligible ? [] : ['Complete per-task records are unavailable.'], frontier: eligible,
});
const result: PublicBenchmarks = {
  state: 'READY', source: 'https://www.swebench.com/', benchmark: 'SWE-bench Verified',
  retrievedAt: '2026-01-02T00:00:00Z', sourceSha256: 'b'.repeat(64),
  selectedCohort: 'test-1',
  cohorts: [{ id: 'test-1', label: 'mini-SWE-agent test-1', records: 3, comparable: 2, latestDate: '2026-01-01' }],
  rows: [row('a'), row('b'), row('incomplete', false)], paired: null,
  notes: ['Published costs are historical; production quality still needs evaluation.'],
};

describe('public benchmark evidence', () => {
  it('fetches only on request and exposes excluded records without inventing prices', async () => {
    const { invocations } = renderWithProviders(<PublishedBenchmarks />, {
      handler: (action) => okEnvelope(action, action === 'benchmarks.public' ? result : {}),
    });
    expect(invocations.some((call) => call.action === 'benchmarks.public')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    await screen.findByText('2 of 3 records pass comparison checks');
    // The graph carries the names and values without requiring a table lookup.
    const chart = screen.getByRole('group', { name: 'Published coding correctness versus reported API cost' });
    expect(within(chart).getByRole('button', { name: /Test model a: 60%/ })).toBeVisible();
    expect(within(chart).queryByRole('button', { name: /Test model incomplete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All records and calculations (3)' }));
    const excluded = within(screen.getByRole('row', { name: /Test model incomplete/ }));
    expect(excluded.getByText('Incomplete outcomes')).toBeVisible();
    expect(excluded.getAllByText('Not available')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Review excluded record: Test model incomplete' }));
    expect(screen.getByText('Complete per-task records are unavailable.')).toBeVisible();
    expect(screen.getByText(/Published API costs are historical/)).toBeVisible();
    expect(invocations.find((call) => call.action === 'benchmarks.public')?.payload).toEqual({});
  });

  it('requests paired outcomes with explicit identities from the selected cohort', async () => {
    const { invocations } = renderWithProviders(<PublishedBenchmarks />, {
      handler: (action, payload) => {
        if (action !== 'benchmarks.public') return okEnvelope(action, {});
        const request = payload as { baseline?: string; contender?: string };
        return okEnvelope(action, {
          ...result, paired: request.baseline ? {
            baseline: 'a', contender: 'b', tasks: 500, contenderOnly: 40, baselineOnly: 15,
            bothResolved: 260, neitherResolved: 185, differencePercentagePoints: 5,
          } : null,
        });
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    await userEvent.click(await screen.findByRole('button', { name: /Published baseline/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Test model a' }));
    await userEvent.click(screen.getByRole('button', { name: /Published contender/ }));
    expect(screen.queryByRole('option', { name: 'Test model incomplete' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Test model b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare paired outcomes' }));
    expect(await screen.findByText(/Contender only: 40. Baseline only: 15./)).toBeVisible();
    expect(invocations.filter((call) => call.action === 'benchmarks.public').at(-1)?.payload)
      .toEqual({ cohort: 'test-1', baseline: 'a', contender: 'b' });
  });

  it('selects plotted evidence with the keyboard and keeps uncertainty optional', async () => {
    renderWithProviders(<PublishedBenchmarks />, {
      handler: (action) => okEnvelope(action, action === 'benchmarks.public' ? result : {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    const chart = await screen.findByRole('group', { name: 'Published coding correctness versus reported API cost' });
    const point = within(chart).getByRole('button', { name: /Test model b: 60%/ });
    point.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Evidence: Test model b')).toBeVisible();
    expect(point).toHaveAttribute('aria-pressed', 'true');
    expect(chart.querySelector('.eddie-evidence-interval')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show 95% intervals' }));
    expect(chart.querySelectorAll('.eddie-evidence-interval')).toHaveLength(2);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Start score axis at 0%' }));
    expect(screen.getByText(/Score axis: 0% to/)).toBeVisible();
  });

  it('does not present inconsistent task records as a model scoring zero', async () => {
    const bad = { ...row('inconsistent', false), tasks: 500, resolved: 0, resolvedPercent: 0,
      publishedResolvedPercent: 60, costsConsistent: true, costPerTaskUsd: '0.1',
      reasons: ['The task outcomes do not reproduce the published resolution percentage.'] };
    renderWithProviders(<PublishedBenchmarks />, {
      handler: (action) => okEnvelope(action, action === 'benchmarks.public' ? { ...result, rows: [bad] } : {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    await userEvent.click(await screen.findByRole('button', { name: 'All records and calculations (1)' }));
    const record = within(await screen.findByRole('row', { name: /Test model inconsistent/ }));
    expect(record.getByText('Inconsistent outcomes')).toBeVisible();
    expect(record.queryByText('0 (0%)')).not.toBeInTheDocument();
    expect(screen.getByText(/neither value is used to rank this entry/)).toBeVisible();
  });

  it('does not keep a previous chart under a failed refresh', async () => {
    let calls = 0;
    renderWithProviders(<PublishedBenchmarks />, {
      handler: (action) => action !== 'benchmarks.public' ? okEnvelope(action, {}) :
        ++calls === 1 ? okEnvelope(action, result) : failEnvelope(action, 'unavailable', 'Source is unavailable'),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    await screen.findByText('Compare within one harness version');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh published results' }));
    expect(await screen.findByText(/Source is unavailable/)).toBeVisible();
    expect(screen.queryByText('Compare within one harness version')).not.toBeInTheDocument();
  });

  it('ignores a response after the evidence panel unmounts', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const { invocations, unmount } = renderWithProviders(<PublishedBenchmarks />, {
      handler: (action) => action === 'benchmarks.public' ? pending : okEnvelope(action, {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load published results' }));
    await waitFor(() => expect(invocations.some((call) => call.action === 'benchmarks.public')).toBe(true));
    unmount();
    await act(async () => resolve(okEnvelope('benchmarks.public', result)));
    expect(screen.queryByText('Compare within one harness version')).not.toBeInTheDocument();
  });
});
