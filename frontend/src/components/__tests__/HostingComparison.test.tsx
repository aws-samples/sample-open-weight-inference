import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EvaluateResponse } from '../../api/types';
import recordedSupportCase from '../../test/fixtures/support-case-live.json';
import { HostingComparison, comparisonPeriod } from '../HostingComparison';

// Recorded from EDDIE's authenticated runtime on 2026-09-18 UTC. This is a
// replay for UI regression tests, not a live price check or a benchmark.
const supportCase = recordedSupportCase as EvaluateResponse;
const props = { loading: false, error: null, neverRun: false };

describe('plain-language hosting comparison', () => {
  it('shows real estimates without turning unverified options into recommendations', () => {
    render(<HostingComparison {...props} result={supportCase} />);
    expect(screen.getByText('Costs are ready. Verification is next.')).toBeVisible();
    expect(screen.getByText('$879.84')).toBeVisible();
    expect(screen.getByText('$1,090.80')).toBeVisible();
    expect(screen.getByText('Test response time.')).toBeVisible();
    expect(screen.getByText('Check account availability.')).toBeVisible();
    expect(screen.getByText('Confirm the model can be deployed.')).toBeVisible();
    expect(screen.queryByText('UNKNOWN', { exact: true })).toBeNull();
    expect(screen.queryByText('Recommended', { exact: true })).toBeNull();
    expect(screen.queryByTestId('winner-cost')).toBeNull();
    // No frontend cost ranking: unverified candidates retain the runtime's order.
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('ml.g5.2xlarge');
    expect(rows[2]).toHaveTextContent('ml.g6.2xlarge');
  });

  it('keeps a budget failure distinct from an untested response-time target', () => {
    render(<HostingComparison {...props} result={supportCase} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    const g6 = rows.find((row) => row.textContent?.includes('ml.g6.2xlarge'));
    const bedrock = rows.find((row) => row.textContent?.includes('pause when idle'));
    expect(g6).toHaveTextContent('Needs verification');
    expect(bedrock).toHaveTextContent('Over budget');
    expect(bedrock).not.toHaveTextContent('Passed declared checks');
  });

  it('replaces an old comparison with one next action, without old costs or duty figures', async () => {
    const update = vi.fn();
    render(
      <HostingComparison
        {...props}
        result={{ ...supportCase, horizonHours: '8760' }}
        outdatedFields={['Horizon (hours)', 'Billable copy hours']}
        onReevaluate={update}
      />
    );
    expect(screen.getAllByText('Your requirements changed')).toHaveLength(1);
    expect(screen.queryByText('$879.84')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/8760|8,760|365 days|100\\.00%/)).toBeNull();
    expect(screen.queryByText('Costs are ready. Verification is next.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Update comparison' }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('lets a person deliberately inspect history and closes it after a new comparison', async () => {
    const { rerender } = render(
      <HostingComparison {...props} result={supportCase} outdatedFields={['Budget']} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous comparison' }));
    expect(screen.getByText(/Saved for reference only/)).toBeVisible();
    expect(screen.getByText('$879.84')).toBeVisible();
    rerender(<HostingComparison {...props} result={supportCase} outdatedFields={[]} />);
    rerender(<HostingComparison {...props} result={supportCase} outdatedFields={['Budget']} />);
    expect(screen.queryByText('$879.84')).toBeNull();
  });

  it('does not render a missing price as zero or an unexplained UNKNOWN', () => {
    const candidate = { ...supportCase.unresolved[0], cost: null };
    render(
      <HostingComparison
        {...props}
        result={{ ...supportCase, unresolved: [candidate], excluded: [] }}
      />
    );
    expect(screen.getByText('Price unavailable')).toBeVisible();
    expect(screen.getByText('More information is needed')).toBeVisible();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.queryByText('UNKNOWN', { exact: true })).toBeNull();
  });

  it('keeps assumed checks explicit, including a cost-only result', () => {
    render(
      <HostingComparison
        {...props}
        result={{
          ...supportCase,
          checksStipulated: true,
          qualification: {
            ...supportCase.qualification!,
            latencyStatus: 'NOT_REQUESTED',
            sloRequested: false,
            conditional: true,
          },
        }}
      />
    );
    expect(screen.getByText('Account checks were assumed')).toBeVisible();
    expect(screen.getByText(/No response-time target was set/)).toBeVisible();
    expect(screen.queryByText(/Latency measured/)).toBeNull();
  });

  it('closes candidate details when a different comparison arrives', async () => {
    const { rerender } = render(<HostingComparison {...props} result={supportCase} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'View details for Amazon SageMaker · ml.g6.2xlarge' })
    );
    expect(screen.getByRole('button', { name: 'Close details' })).toBeVisible();
    rerender(
      <HostingComparison
        {...props}
        result={{ ...supportCase, requestHash: 'another-request', horizonHours: '72' }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull();
    expect(screen.getByText('Estimated cost · 3 days')).toBeVisible();
  });

  it('handles a no-candidates reply without manufacturing missing fields', () => {
    render(
      <HostingComparison
        {...props}
        result={{ outcome: 'NO_CANDIDATES', request: {} } as EvaluateResponse}
      />
    );
    expect(screen.getByText('No supported option found')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('formats the comparison period without rounding it into a different duration', () => {
    expect(comparisonPeriod('720')).toBe('30 days');
    expect(comparisonPeriod('72')).toBe('3 days');
    expect(comparisonPeriod('1.5')).toBe('1.5 hours');
    expect(comparisonPeriod(undefined)).toBe('the requested period');
  });
});
