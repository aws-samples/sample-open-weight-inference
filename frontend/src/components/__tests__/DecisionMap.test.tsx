import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Candidate, EvaluateResponse } from '../../api/types';
import recordedSupportCase from '../../test/fixtures/support-case-live.json';
import { HostingComparison } from '../HostingComparison';
import { candidateExplanation, candidateStatus, checkStatus, hostingBranches } from '../decisionMapModel';

// A replay of a recorded response, not a new AWS measurement or price lookup.
const result = recordedSupportCase as EvaluateResponse;
const base = { loading: false, error: null, neverRun: false };
const dialog = () => within(screen.getByRole('dialog', { name: 'How EDDIE reached this result' }));
async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'View decision map' }));
  return dialog();
}

describe('interactive explanation of a recorded placement decision', () => {
  it('makes the map discoverable and exposes actual reasons without qualifying unknowns', async () => {
    render(<HostingComparison {...base} result={result} />);
    const map = await open();
    expect(map.getByText('Verify the gaps before choosing')).toBeVisible();
    for (const id of ['native', 'import', 'sagemaker', 'cpu', 'gpu']) {
      expect(map.getByTestId(`decision-branch-${id}`)).toBeVisible();
    }
    const checks = within(map.getByRole('region', { name: 'Recorded requirement checks' }));
    await userEvent.click(checks.getByRole('button', { name: 'Account quota' }));
    expect(checks.getByText('Quota headroom not collected')).toBeVisible();
    expect(map.queryByText('Selected by solver')).toBeNull();
    expect(map.queryByText('UNKNOWN', { exact: true })).toBeNull();
    await userEvent.click(map.getByRole('button', { name: 'Cost ranking and tie-breaks' }));
    expect(map.getByText(/solver produced no cost ranking/)).toBeVisible();
    expect(map.queryByRole('table', { name: 'Recorded solver ranking' })).toBeNull();
    const threePending = {
      ...result.unresolved[0],
      gates: result.unresolved[0].gates.filter((gate) => gate.status === 'UNKNOWN').slice(0, 3),
    };
    expect(candidateExplanation(threePending, result)).toContain('1 other check needs evidence.');
  });

  it('opens the exact configuration requested from a table row and shows price provenance', async () => {
    render(<HostingComparison {...base} result={result} />);
    await userEvent.click(screen.getByRole('button', { name: 'Explain Amazon SageMaker · ml.g6.2xlarge' }));
    const map = dialog();
    expect(map.getByRole('button', { name: /Configuration to explain/ })).toHaveTextContent('ml.g6.2xlarge');
    expect(map.getByText('$879.84')).toBeVisible();
    await userEvent.click(map.getByRole('button', { name: 'Price evidence for this configuration' }));
    const candidate = result.unresolved.find((item) => item.instanceType === 'ml.g6.2xlarge')!;
    expect(map.getByText(candidate.cost!.items[0].rate!.source!)).toBeVisible();
    expect(map.getByText(/SKU:/)).toHaveTextContent(candidate.cost!.items[0].rate!.sku!);
  });

  it('distinguishes an unevaluated route from a failed check', async () => {
    render(<HostingComparison {...base} result={result} />);
    const map = await open();
    await userEvent.click(map.getByRole('button', { name: 'Explore EC2 / EKS GPUs' }));
    const selected = within(map.getByRole('region', { name: 'Selected hosting path' }));
    expect(selected.getByText('Not evaluated', { exact: true })).toBeVisible();
    expect(selected.getByText(/AWS availability has not been ruled out/)).toBeVisible();
    expect(selected.queryByText('Ruled out', { exact: true })).toBeNull();
    expect(selected.queryByText('$0.00')).toBeNull();
    expect(selected.queryByRole('region', { name: 'Recorded requirement checks' })).toBeNull();
    await userEvent.click(map.getByRole('button', { name: 'All paths' }));
    await userEvent.click(map.getByRole('button', { name: 'Explore Bedrock model API' }));
    expect(selected.getByText(/native Bedrock option was not evaluated/)).toBeVisible();
  });

  it('keeps assumed checks and an absent speed target distinct from verified performance', async () => {
    const candidate: Candidate = {
      ...result.unresolved[0], isFeasible: true,
      gates: [
        { name: 'quota', status: 'PASS', reason: 'Stipulated by caller', evidenceRef: null },
        { name: 'latency', status: 'PASS', reason: 'No latency objective declared', evidenceRef: null },
      ],
    };
    const assumed: EvaluateResponse = {
      ...result, winner: candidate, ranked: [candidate], unresolved: [], excluded: [],
      checksStipulated: true, qualification: {
        performanceMeasured: false, latencyStatus: 'NOT_REQUESTED', sloRequested: false,
        benchmarkRunIds: [], conditional: true, note: null,
      },
    };
    render(<HostingComparison {...base} result={assumed} />);
    const map = await open();
    expect(map.getByText('A cost leader, with conditions')).toBeVisible();
    const checks = within(map.getByRole('region', { name: 'Recorded requirement checks' }));
    expect(checks.getByText('Assumed', { exact: true })).toBeVisible();
    expect(checks.getByText('Not requested', { exact: true })).toBeVisible();
    expect(checks.queryByText('Met', { exact: true })).toBeNull();
    expect(map.getByText(/No speed claim is being made/)).toBeVisible();
  });

  it('hands a challenge to the Advisor without submitting it or changing requirements', async () => {
    const ask = vi.fn();
    const edit = vi.fn();
    render(<HostingComparison {...base} result={result} onAsk={ask} onEditNeeds={edit} />);
    const map = await open();
    await userEvent.click(map.getByRole('button', { name: 'Challenge this option' }));
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).toContain(result.requestHash);
    expect(ask.mock.calls[0][0]).toContain(result.unresolved[0].candidateId);
    expect(ask.mock.calls[0][0]).toContain('Ask before changing my requirements');
    expect(edit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the map when inputs become stale and never presents history as current', async () => {
    const { rerender } = render(<HostingComparison {...base} result={result} />);
    await open();
    rerender(<HostingComparison {...base} result={result} outdatedFields={['Budget']} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View decision map' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Previous comparison' }));
    expect(screen.queryByRole('button', { name: 'View decision map' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Explain Amazon/ })).toBeNull();
  });

  it('closes a map when the evidence changes even if the request hash is unchanged', async () => {
    const { rerender } = render(<HostingComparison {...base} result={result} />);
    await open();
    rerender(<HostingComparison {...base} result={{ ...result, snapshotHash: 'new-evidence' }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the supplied rank order and does not sort unqualified prices into a winner', async () => {
    const first = { ...result.unresolved[0], gates: [{ name: 'region', status: 'PASS' as const, reason: 'Permitted', evidenceRef: null }] };
    const second = { ...result.unresolved[1], gates: first.gates };
    const ranked = { ...result, winner: first, ranked: [first, second], unresolved: [], excluded: [] };
    render(<HostingComparison {...base} result={ranked} />);
    const map = await open();
    await userEvent.click(map.getByRole('button', { name: 'Cost ranking and tie-breaks' }));
    const rows = within(map.getByRole('table', { name: 'Recorded solver ranking' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent(first.instanceType!);
    expect(rows[2]).toHaveTextContent(second.instanceType!);
  });

  it('keeps untrusted model and gate text inert', async () => {
    const text = '<img src=x onerror=alert(1)>';
    const changed = {
      ...result, evaluatedRequest: { model: { name: text } },
      unresolved: [{ ...result.unresolved[0], gates: [{ name: 'quota', status: 'UNKNOWN' as const, reason: text, evidenceRef: 'javascript:alert(1)' }] }],
    };
    render(<HostingComparison {...base} result={changed} />);
    const map = await open();
    expect(map.getByRole('heading', { name: text })).toBeVisible();
    const checks = within(map.getByRole('region', { name: 'Recorded requirement checks' }));
    await userEvent.click(checks.getByRole('button', { name: 'Account quota' }));
    expect(checks.getByText(text)).toBeVisible();
    expect(map.queryByRole('img')).toBeNull();
    expect(map.queryByRole('link')).toBeNull();
  });

  it('does not invent a check or price when the solver returns no candidates', async () => {
    render(<HostingComparison {...base} result={{ outcome: 'NO_CANDIDATES', request: {} } as EvaluateResponse} />);
    const map = await open();
    expect(map.getByText('No configuration has been evaluated')).toBeVisible();
    expect(map.queryByText('$0.00')).toBeNull();
    expect(map.queryByText('Selected by solver')).toBeNull();
    expect(hostingBranches(result).find((branch) => branch.id === 'gpu')?.candidates).toEqual([]);
    expect(candidateStatus({ ...result.unresolved[0], gates: [] }, result).tone).toBe('pending');
    expect(checkStatus({ name: 'quality', status: 'PASS', reason: 'No answer-quality objective declared', evidenceRef: null }, result).label).toBe('Not requested');
  });

  it('offers a refresh for saved comparisons that predate CPU candidates', async () => {
    const refresh = vi.fn();
    render(<HostingComparison {...base} result={result} onReevaluate={refresh} />);
    expect(screen.getByText(/This saved comparison does not include CPU/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Include CPU options' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shows actual CPU candidates and their unresolved checks without inventing a total', async () => {
    const cpu: Candidate = {
      ...result.unresolved[0], candidateId: 'ec2-cpu-c7i.8xlarge', target: 'EC2_CPU',
      instanceType: 'c7i.8xlarge', recipeId: null, isFeasible: false,
      cost: { total: null, totalExact: null, knownSubtotal: '1028.16', isComplete: false,
        unpriced: ['Supporting services'], items: [
          { label: 'EC2 CPU allocated compute', phase: 'serving', quantity: '720',
            quantityUnit: 'instance-hour', rate: null, amount: '1028.16',
            evidence: 'PROJECTED', note: 'Assumes continuous allocation.' },
        ] },
      gates: [
        { name: 'latency', status: 'PASS', reason: 'No latency objective declared', evidenceRef: null },
        { name: 'cpu_runtime', status: 'UNKNOWN', reason: 'Validate the exact CPU runtime.', evidenceRef: 'recorded-example:qwen-tts-cpu-20260923' },
        { name: 'cpu_delivery', status: 'UNKNOWN', reason: 'Ask about live output, deadline, concurrency and volume.', evidenceRef: null },
      ],
    };
    const cpuResult = { ...result, winner: null, ranked: [], excluded: [], unresolved: [cpu],
      evaluatedRequest: { model: { name: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', weightsExportable: true },
        workload: { horizonHours: '720' }, slos: [] } };
    render(<HostingComparison {...base} result={cpuResult} />);
    expect(screen.getByText('CPU only · billed while allocated')).toBeVisible();
    expect(screen.getByText(/Known subtotal:/)).toHaveTextContent('$1,028.16');
    const map = await open();
    expect(map.getByTestId('decision-branch-cpu')).toHaveTextContent('1 configuration evaluated');
    expect(map.getByText('Speed target not set')).toBeVisible();
    await userEvent.click(map.getByRole('button', { name: 'Does it meet the workload?' }));
    expect(within(map.getByRole('region', { name: 'Decision steps' })).getByText(
      'Ask about live output, deadline, concurrency and volume.', { exact: false })).toBeVisible();
    expect(map.queryByText('Selected by solver')).toBeNull();
  });
});
