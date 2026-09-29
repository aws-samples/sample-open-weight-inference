import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  sectionsToOpen,
  summariseBlockingGates,
} from '../blockingGates';
import { NoQualifiedCandidates } from '../CandidateTable';
import { ResultsPanel } from '../ResultsPanel';
import { noQualifiedResult, steadyResult } from '../../test/fixtures';
import type { Candidate } from '../../api/types';

function candidate(
  candidateId: string,
  gates: Candidate['gates']
): Candidate {
  return {
    ...noQualifiedResult.unresolved[0],
    candidateId,
    gates,
  };
}

describe('summariseBlockingGates', () => {
  it('aggregates one row per gate, listing every candidate it blocks', () => {
    const gates = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'quota', status: 'UNKNOWN', reason: 'No headroom observed.', evidenceRef: null },
        ]),
        candidate('b', [
          { name: 'quota', status: 'UNKNOWN', reason: 'No headroom observed.', evidenceRef: null },
        ]),
      ],
      []
    );
    expect(gates).toHaveLength(1);
    expect(gates[0].gateName).toBe('quota');
    expect(gates[0].affectedCandidates).toEqual(['a', 'b']);
    // The identical reason is not repeated.
    expect(gates[0].reasons).toEqual(['No headroom observed.']);
  });

  it('lists unresolved gates before failures', () => {
    const gates = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'quota', status: 'UNKNOWN', reason: null, evidenceRef: null },
        ]),
      ],
      [
        candidate('b', [
          { name: 'p99_latency_ms', status: 'FAIL', reason: null, evidenceRef: null },
        ]),
      ]
    );
    expect(gates.map((gate) => gate.status)).toEqual(['UNKNOWN', 'FAIL']);
  });

  it('keeps the same gate name separate when it both fails and is unresolved', () => {
    const gates = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'p99_latency_ms', status: 'UNKNOWN', reason: 'No evidence.', evidenceRef: null },
        ]),
      ],
      [
        candidate('b', [
          { name: 'p99_latency_ms', status: 'FAIL', reason: 'Cold start busts it.', evidenceRef: null },
        ]),
      ]
    );
    expect(gates).toHaveLength(2);
  });

  it('ignores passing gates', () => {
    const gates = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'artifact', status: 'PASS', reason: 'Fine.', evidenceRef: null },
          { name: 'quota', status: 'UNKNOWN', reason: null, evidenceRef: null },
        ]),
      ],
      []
    );
    expect(gates.map((gate) => gate.gateName)).toEqual(['quota']);
  });

  it('points a latency gate at the objective and the evidence control', () => {
    const [gate] = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'p99_latency_ms', status: 'UNKNOWN', reason: null, evidenceRef: null },
        ]),
      ],
      []
    );
    expect(gate.remedy).toContain('Supply latency evidence');
    expect(gate.remedy).toContain('Set a response-time target');
    expect(gate.section).toBe('Response time');
  });

  it('names real verification steps instead of treating assumptions as verification', () => {
    for (const name of ['licence', 'license', 'quota', 'recipe', 'capacity']) {
      const [gate] = summariseBlockingGates(
        [candidate('a', [{ name, status: 'UNKNOWN', reason: null, evidenceRef: null }])],
        []
      );
      expect(gate.remedy).toBeTruthy();
      expect(gate.remedy).not.toMatch(/Stipulate|assuming they pass|Turn on/);
      expect(gate.section).toBe('Advanced evidence and assumptions');
    }
  });

  it('points budget, region and ops gates at Constraints', () => {
    for (const name of ['budget', 'residency', 'ops_burden']) {
      const [gate] = summariseBlockingGates(
        [candidate('a', [{ name, status: 'UNKNOWN', reason: null, evidenceRef: null }])],
        []
      );
      expect(gate.section).toBe('Region and budget');
    }
  });

  it('offers no remedy rather than a wrong one for an unrecognised gate', () => {
    const [gate] = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'some_future_gate', status: 'UNKNOWN', reason: 'Unclear.', evidenceRef: null },
        ]),
      ],
      []
    );
    expect(gate.remedy).toBeNull();
    expect(gate.section).toBeNull();
    // The gate still reports itself, so the user is not left guessing.
    expect(gate.gateName).toBe('some_future_gate');
    expect(gate.reasons).toEqual(['Unclear.']);
  });

  it('collects the distinct sections a user has to open', () => {
    const gates = summariseBlockingGates(
      [
        candidate('a', [
          { name: 'licence', status: 'UNKNOWN', reason: null, evidenceRef: null },
          { name: 'quota', status: 'UNKNOWN', reason: null, evidenceRef: null },
          { name: 'p99_latency_ms', status: 'UNKNOWN', reason: null, evidenceRef: null },
        ]),
      ],
      []
    );
    expect(sectionsToOpen(gates)).toEqual([
      'Advanced evidence and assumptions',
      'Response time',
    ]);
  });
});

describe('NoQualifiedCandidates empty state', () => {
  it('names each blocking gate, its reason, and the candidates it affected', () => {
    render(
      <NoQualifiedCandidates
        unresolved={noQualifiedResult.unresolved}
        excluded={noQualifiedResult.excluded}
      />
    );
    expect(screen.getByText('No qualified candidates')).toBeInTheDocument();
    expect(screen.getByText('p99_latency_ms — UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('licence — UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('quota — UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('p99_latency_ms — FAIL')).toBeInTheDocument();

    expect(
      screen.getByText('Licence terms were not verified for this artifact.')
    ).toBeInTheDocument();
    // Each gate names only the candidates it actually blocked: the licence and
    // latency gates hit the CMI candidate, quota hits the SageMaker one.
    expect(
      screen.getAllByText('Affects cmi-scale-to-zero.').length
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText('Affects sagemaker-ml.g5.2xlarge.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Affects cmi-cold-excluded.')
    ).toBeInTheDocument();
  });

  it('names the control that resolves each gate, not a generic instruction', () => {
    render(
      <NoQualifiedCandidates
        unresolved={noQualifiedResult.unresolved}
        excluded={noQualifiedResult.excluded}
      />
    );
    const remedies = screen.getAllByTestId('gate-remedy');
    expect(remedies.length).toBeGreaterThanOrEqual(3);
    const text = remedies.map((node) => node.textContent ?? '').join(' ');
    expect(text).toContain('Verify the model licence');
    expect(text).toContain('Check the applied quota');
    expect(text).not.toContain('Stipulate');
    expect(text).toContain('Supply latency evidence');
    // And it says which collapsed section holds the control.
    expect(text).toContain('Advanced evidence and assumptions');
    expect(text).toContain('requirements form on the left');

    // The old dead-end wording is gone.
    expect(
      screen.queryByText(/Review the excluded and unresolved sections below/)
    ).toBeNull();
  });

  it('counts the unresolved and excluded candidates separately', () => {
    render(
      <NoQualifiedCandidates
        unresolved={noQualifiedResult.unresolved}
        excluded={noQualifiedResult.excluded}
      />
    );
    expect(
      screen.getByText(
        /2 candidates could not be resolved and 1 was excluded, so nothing can be ranked/
      )
    ).toBeInTheDocument();
  });

  it('explains an unresolved-only outcome without mentioning exclusions', () => {
    render(
      <NoQualifiedCandidates
        unresolved={noQualifiedResult.unresolved}
        excluded={[]}
      />
    );
    expect(
      screen.getByText(/An unresolved gate is never treated as a pass/)
    ).toBeInTheDocument();
  });

  it('distinguishes "nothing enumerated" from "nothing qualified"', () => {
    render(<NoQualifiedCandidates unresolved={[]} excluded={[]} />);
    expect(
      screen.getByText('No candidates were enumerated')
    ).toBeInTheDocument();
  });
});

describe('ResultsPanel wiring of the empty state', () => {
  it('renders the blocking gates inside the ranked table when nothing qualifies', () => {
    render(
      <ResultsPanel
        result={noQualifiedResult}
        loading={false}
        error={null}
        neverRun={false}
      />
    );
    const rankedTable = screen.getByRole('table', {
      name: 'Ranked qualified candidates',
    });
    expect(
      within(rankedTable).getByText('No qualified candidates')
    ).toBeInTheDocument();
    expect(
      within(rankedTable).getAllByTestId('gate-remedy').length
    ).toBeGreaterThan(0);
  });

  it('still keeps excluded candidates out of the ranked table', () => {
    render(
      <ResultsPanel
        result={noQualifiedResult}
        loading={false}
        error={null}
        neverRun={false}
      />
    );
    const rankedTable = screen.getByRole('table', {
      name: 'Ranked qualified candidates',
    });
    // The gate summary names the blocked candidates, but none is rendered as a
    // rankable option: every real candidate row carries a "Show detail" action,
    // and there is no such row here.
    expect(
      within(rankedTable).queryByRole('button', { name: /Show detail for/ })
    ).toBeNull();
    expect(
      within(rankedTable).getByText('No qualified candidates')
    ).toBeInTheDocument();
  });

  it('does not show the empty state when candidates did qualify', () => {
    render(
      <ResultsPanel
        result={steadyResult}
        loading={false}
        error={null}
        neverRun={false}
      />
    );
    expect(screen.queryByText('No qualified candidates')).toBeNull();
    expect(screen.queryByTestId('gate-remedy')).toBeNull();
  });
});
