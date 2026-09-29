import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ResultsPanel } from '../ResultsPanel';
import { burstyResult, steadyResult } from '../../test/fixtures';
import type { EvaluateResponse } from '../../api/types';

function renderResult(result: EvaluateResponse | null) {
  return render(
    <ResultsPanel
      result={result}
      loading={false}
      error={null}
      neverRun={result === null}
    />
  );
}

describe('ResultsPanel — cost honesty', () => {
  it('renders an unpriced cost total as UNKNOWN and never as $0', () => {
    renderResult(burstyResult);

    // The unresolved candidate `cmi-prewarmed-scheduled` has cost.total === null.
    const unknowns = screen.getAllByTestId('money-unknown');
    expect(unknowns.length).toBeGreaterThan(0);
    for (const node of unknowns) {
      expect(node).toHaveTextContent('UNKNOWN');
    }

    // No rendered money amount is a bare zero.
    for (const node of screen.queryAllByTestId('money-amount')) {
      expect(node.textContent).not.toBe('$0.00');
    }
  });

  it('labels the incomplete cost of the winner rather than hiding it', () => {
    renderResult(burstyResult);
    expect(screen.getByTestId('winner-cost')).toHaveTextContent('$41.16');
  });
});

describe('ResultsPanel — candidate set separation', () => {
  it('never places an excluded candidate in the ranked table', () => {
    renderResult(burstyResult);

    const rankedTable = screen.getByRole('table', {
      name: 'Ranked qualified candidates',
    });

    // Ranked candidates are present.
    expect(
      within(rankedTable).getByText('cmi-scale-to-zero')
    ).toBeInTheDocument();
    expect(
      within(rankedTable).getByText('sagemaker-dedicated-warm')
    ).toBeInTheDocument();

    // The excluded candidate is not.
    expect(
      within(rankedTable).queryByText('sagemaker-scale-to-zero')
    ).toBeNull();
    // Nor is the unresolved candidate.
    expect(
      within(rankedTable).queryByText('cmi-prewarmed-scheduled')
    ).toBeNull();
  });

  it('lists excluded and unresolved candidates in their own labelled sections', () => {
    renderResult(burstyResult);

    expect(screen.getByText('Excluded candidates')).toBeInTheDocument();
    expect(screen.getByText('Unresolved candidates')).toBeInTheDocument();
    // Each appears in its section header and again in its detail table.
    expect(screen.getAllByText('sagemaker-scale-to-zero').length).toBeGreaterThan(
      0
    );
    expect(
      screen.getAllByText('cmi-prewarmed-scheduled').length
    ).toBeGreaterThan(0);
  });

  it('shows the failing gate reason for an excluded candidate', () => {
    renderResult(burstyResult);
    // Listed as the headline failing reason and again in the full gate table.
    expect(
      screen.getAllByText(/Cold restoration of 240000 ms exceeds/).length
    ).toBeGreaterThan(0);
  });

  it('shows the unknown gate reason for an unresolved candidate', () => {
    renderResult(burstyResult);
    expect(
      screen.getAllByText(/No latency evidence exists for this candidate key/)
        .length
    ).toBeGreaterThan(0);
  });

  it('reports empty excluded and unresolved sets honestly', () => {
    renderResult(steadyResult);
    expect(screen.getByText('No candidates were excluded')).toBeInTheDocument();
    expect(screen.getByText('No candidates are unresolved')).toBeInTheDocument();
  });
});

describe('ResultsPanel — stipulation warning', () => {
  it('warns when checksStipulated is true', () => {
    renderResult(burstyResult);
    expect(
      screen.getByText(
        'Licence, quota, recipe and capacity checks were stipulated, not verified'
      )
    ).toBeInTheDocument();
  });

  it('does not warn when checksStipulated is false', () => {
    renderResult(steadyResult);
    expect(
      screen.queryByText(
        'Licence, quota, recipe and capacity checks were stipulated, not verified'
      )
    ).toBeNull();
  });
});

describe('ResultsPanel — latency provenance', () => {
  it('labels supplied latency evidence as supplied, not measured', () => {
    renderResult(burstyResult);
    expect(
      screen.getByText('Latency evidence was supplied, not measured by')
    ).toHaveTextContent(/Latency evidence was supplied, not measured by EDDIE/);
  });

  it('states plainly when no latency evidence was supplied', () => {
    renderResult(steadyResult);
    expect(
      screen.getByText('No latency evidence was supplied')
    ).toBeInTheDocument();
  });
});

describe('ResultsPanel — price freshness', () => {
  it('warns when any rate family is pinned rather than live', () => {
    renderResult(burstyResult);
    expect(
      screen.getByText('Some prices are pinned or unknown')
    ).toBeInTheDocument();
  });

  it('confirms when every rate family is live', () => {
    renderResult(steadyResult);
    expect(screen.getByText('All prices retrieved live')).toBeInTheDocument();
  });
});

describe('ResultsPanel — non-success states', () => {
  it('shows an explicit empty state before the first evaluation', () => {
    renderResult(null);
    expect(screen.getByText('No evaluation yet')).toBeInTheDocument();
  });

  it('shows a loading state rather than a blank panel', () => {
    render(
      <ResultsPanel result={null} loading error={null} neverRun={false} />
    );
    expect(screen.getByText('Evaluating placement')).toBeInTheDocument();
  });

  it('shows the error detail and a retry affordance on failure', () => {
    render(
      <ResultsPanel
        result={null}
        loading={false}
        error={new Error('model.architecture is required')}
        neverRun={false}
        onRetry={() => {}}
      />
    );
    expect(
      screen.getByText('model.architecture is required')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Retry evaluation/ })
    ).toBeInTheDocument();
  });
});
