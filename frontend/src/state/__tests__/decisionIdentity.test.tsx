import { useEffect, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORM, WORKLOAD_PRESETS, toEvaluateRequest } from '../caseForm';
import {
  canonicalEvaluatePayload,
  evaluatedRequestChanges,
  evaluatedRequestMatches,
} from '../evaluatedRequest';
import { useCase } from '../CaseContext';
import { useChat } from '../ChatContext';
import { burstyResult, chatWithDecisionFixture, steadyResult } from '../../test/fixtures';
import {
  okEnvelope,
  renderWithProviders as renderFixtureProviders,
  streamOnce,
  type ActionHandler,
} from '../../test/harness';


// These historical fixtures explicitly represent assumed account checks. Opt in
// for identity tests; the production default now correctly leaves them unverified.
function FixtureAssumptions() {
  const { patch } = useCase();
  useEffect(() => patch({ assumeChecksCleared: true }), [patch]);
  return null;
}
function renderWithProviders(ui: ReactNode, options: Parameters<typeof renderFixtureProviders>[1]) {
  return renderFixtureProviders(<><FixtureAssumptions />{ui}</>, options);
}

/* ------------------------------------------------------------- snapshots */

describe('a decision is bound to the request that produced it', () => {
  const payloadFor = (patch: Partial<typeof DEFAULT_FORM> = {}) =>
    toEvaluateRequest({ ...DEFAULT_FORM, ...patch });

  it('treats a renamed case or edited description as inconsequential', () => {
    // The backend hashes over solver-relevant fields only; these two are not.
    const changes = evaluatedRequestChanges(
      payloadFor(),
      payloadFor({ caseId: 'renamed', description: 'A different note entirely' })
    );
    expect(changes).toEqual([]);
    expect(
      evaluatedRequestMatches(
        payloadFor(),
        payloadFor({ caseId: 'x', description: 'y' })
      )
    ).toBe(true);
  });

  it('detects the horizon change that previously left a stale result current', () => {
    const bursty = { ...DEFAULT_FORM, ...WORKLOAD_PRESETS[0].patch };
    const alwaysOn = { ...DEFAULT_FORM, ...WORKLOAD_PRESETS[1].patch };
    const changes = evaluatedRequestChanges(
      toEvaluateRequest(bursty),
      toEvaluateRequest(alwaysOn)
    );
    expect(changes).toContain('Horizon (hours)');
    expect(changes).toContain('Billable copy hours');
  });

  it('detects a stipulation change, which an advisor turn can make', () => {
    // The reason a form snapshot was the wrong basis: strictness can flip after
    // the snapshot was taken.
    expect(
      evaluatedRequestChanges(payloadFor({ assumeChecksCleared: true }), payloadFor({ assumeChecksCleared: false }))
    ).toEqual(['Stipulated checks']);
  });

  it('detects every consequential field, including constraints', () => {
    const cases: Array<[Partial<typeof DEFAULT_FORM>, string]> = [
      [{ permittedRegions: 'us-west-2' }, 'Permitted regions'],
      [{ budgetUsd: '200' }, 'Budget (USD)'],
      [{ concurrency: '4' }, 'Concurrency'],
      [{ provideSlo: true }, 'Latency objective'],
      [{ requireHeldCapacity: true }, 'Require held capacity'],
      [{ maxOpsBurden: 'SERVICE_API' }, 'Maximum ops burden'],
      [{ architecture: 'MistralForCausalLM' }, 'Architecture'],
      [{ weightsExportable: false }, 'Weights exportable'],
      [{ precision: 'INT4' }, 'Weight precision'],
      [{ dedicatedInstanceHours: '10' }, 'Dedicated instance hours'],
      [{ scheduled: true }, 'Scheduled workload'],
    ];
    for (const [patch, label] of cases) {
      const changes = evaluatedRequestChanges(payloadFor(), payloadFor(patch));
      expect(changes, `${label} should invalidate a decision`).toContain(label);
    }
  });

  it('detects an edited latency-evidence figure', () => {
    const withEvidence = {
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [
        {
          candidateId: 'cmi-scale-to-zero',
          p50Ms: '120',
          p99Ms: '500',
          coldStartMs: '45000',
          sampleCount: '12000',
          violationRateUpperBound: '0.004',
        },
      ],
    };
    const edited = {
      ...withEvidence,
      latencyEvidence: [
        { ...withEvidence.latencyEvidence[0], coldStartMs: '900' },
      ],
    };
    expect(
      evaluatedRequestChanges(
        toEvaluateRequest(withEvidence),
        toEvaluateRequest(edited)
      )
    ).toContain('Supplied latency evidence');
  });

  it('normalises the two payload shapes the surfaces produce', () => {
    /*
     * Chat omits keys the user never set; the form sends them as null. Without
     * normalisation every chat-produced decision would read as instantly stale.
     */
    const chatShaped = {
      caseId: 'chat-case',
      model: {
        name: 'Llama 3.1 8B',
        architecture: 'LlamaForCausalLM',
        modality: 'TEXT',
        totalParamsB: '8',
        contextTokens: 128000,
        weightsGb: '16',
        licenseId: 'llama-3.1-community',
        hfRepo: 'meta-llama/Llama-3.1-8B-Instruct',
        weightsExportable: true,
        precision: 'BF16',
      },
      // No `slos`, no `latencyEvidence`, no empty constraint keys at all.
      workload: { horizonHours: '72', billableCopyHours: '6', description: 'x' },
      constraints: { permittedRegions: ['us-east-1'] },
      assumeChecksCleared: true,
    };
    expect(evaluatedRequestChanges(chatShaped, payloadFor({ assumeChecksCleared: true }))).toEqual([]);
  });

  it('compares a numeric string and a number as the same requirement', () => {
    // The form holds decimals as strings; the advisor may send JSON numbers.
    expect(
      evaluatedRequestMatches(
        { workload: { horizonHours: 72 }, assumeChecksCleared: true },
        { workload: { horizonHours: '72' }, assumeChecksCleared: true }
      )
    ).toBe(true);
  });

  it('drops caseId and workload.description from the canonical form', () => {
    const canonical = canonicalEvaluatePayload(payloadFor());
    expect(canonical.caseId).toBeUndefined();
    expect(
      (canonical.workload as Record<string, unknown>).description
    ).toBeUndefined();
    expect((canonical.workload as Record<string, unknown>).horizonHours).toBe('72');
  });

  it('reports no change when there is nothing to compare against', () => {
    expect(evaluatedRequestChanges(null, payloadFor())).toEqual([]);
  });
});

/* ---------------------------------------------------------- shared state */

/** Surfaces the shared decision so both surfaces can be compared. */
function DecisionProbe() {
  const { result, decisionRecord, isOutdated, outdatedFields, evaluate } =
    useCase();
  return (
    <div>
      <span data-testid="hash">
        {decisionRecord?.evaluatedRequestHash ?? 'none'}
      </span>
      <span data-testid="source">{decisionRecord?.source ?? 'none'}</span>
      <span data-testid="horizon">{result?.horizonHours ?? 'none'}</span>
      <span data-testid="outdated">{String(isOutdated)}</span>
      <span data-testid="changed">{outdatedFields.join(',')}</span>
      <button onClick={() => void evaluate()}>evaluate</button>
    </div>
  );
}

function PresetSwitcher() {
  const { applyPreset } = useCase();
  return (
    <div>
      {WORKLOAD_PRESETS.map((preset) => (
        <button key={preset.id} onClick={() => applyPreset(preset.id)}>
          {preset.label}
        </button>
      ))}
    </div>
  );
}

function ChatSender() {
  const { send } = useChat();
  return <button onClick={() => void send('Evaluate this')}>chat send</button>;
}

function evaluateStream(result: unknown): ActionHandler {
  return (action, _payload, stream) => {
    if (action.startsWith('case.') || action.startsWith('chat.')) return okEnvelope(action, {});
    if (stream) return streamOnce(result);
    return okEnvelope(action, result);
  };
}

describe('CHAT-03: one decision identity across surfaces', () => {
  it('makes a chat decision visible to the case workspace and comparison', async () => {
    renderWithProviders(
      <>
        <ChatSender />
        <DecisionProbe />
      </>,
      { handler: evaluateStream(chatWithDecisionFixture), withChat: true }
    );

    expect(screen.getByTestId('hash')).toHaveTextContent('none');
    await userEvent.click(screen.getByRole('button', { name: 'chat send' }));

    // The same decision record every surface reads, tagged with its origin.
    await waitFor(() =>
      expect(screen.getByTestId('hash')).toHaveTextContent(
        burstyResult.evaluatedRequestHash as string
      )
    );
    expect(screen.getByTestId('source')).toHaveTextContent('chat');
    expect(screen.getByTestId('horizon')).toHaveTextContent('72');
  });

  it('does not mark a fresh chat decision as outdated by its own case patch', async () => {
    renderWithProviders(
      <>
        <ChatSender />
        <DecisionProbe />
      </>,
      { handler: evaluateStream(chatWithDecisionFixture), withChat: true }
    );
    await userEvent.click(screen.getByRole('button', { name: 'chat send' }));
    await waitFor(() =>
      expect(screen.getByTestId('hash')).not.toHaveTextContent('none')
    );
    // The turn patched horizon and billable hours; the snapshot must include
    // that patch or the result would be born stale.
    expect(screen.getByTestId('outdated')).toHaveTextContent('false');
  });
});

describe('CHAT-05: an edited input invalidates the recommendation', () => {
  it('marks the result outdated and names the changed fields', async () => {
    renderWithProviders(
      <>
        <PresetSwitcher />
        <DecisionProbe />
      </>,
      { handler: evaluateStream(burstyResult), withCase: true }
    );

    await userEvent.click(
      screen.getByRole('button', { name: '3-day bursty event' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'evaluate' }));
    await waitFor(() =>
      expect(screen.getByTestId('outdated')).toHaveTextContent('false')
    );

    // The exact reproduction from the report.
    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    await waitFor(() =>
      expect(screen.getByTestId('outdated')).toHaveTextContent('true')
    );
    expect(screen.getByTestId('changed')).toHaveTextContent('Horizon (hours)');
    // The decision itself is kept as history rather than discarded.
    expect(screen.getByTestId('hash')).toHaveTextContent(
      burstyResult.evaluatedRequestHash as string
    );
  });

  it('clears the outdated flag once the new inputs are evaluated', async () => {
    let response: unknown = burstyResult;
    renderWithProviders(
      <>
        <PresetSwitcher />
        <DecisionProbe />
      </>,
      {
        handler: (action, payload, stream) => {
          if (action.startsWith('case.') || action.startsWith('chat.')) return okEnvelope(action, {});
          const echoed = { ...(response as object), evaluatedRequest: payload };
          return stream ? streamOnce(echoed) : okEnvelope(action, echoed);
        },
        withCase: true,
      }
    );

    await userEvent.click(screen.getByRole('button', { name: 'evaluate' }));
    await waitFor(() =>
      expect(screen.getByTestId('outdated')).toHaveTextContent('false')
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    await waitFor(() =>
      expect(screen.getByTestId('outdated')).toHaveTextContent('true')
    );

    response = steadyResult;
    await userEvent.click(screen.getByRole('button', { name: 'evaluate' }));
    await waitFor(() =>
      expect(screen.getByTestId('horizon')).toHaveTextContent('720')
    );
    expect(screen.getByTestId('outdated')).toHaveTextContent('false');
  });

  it('discards an in-flight response whose inputs have since changed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    renderWithProviders(
      <>
        <PresetSwitcher />
        <DecisionProbe />
      </>,
      {
        handler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                const encoder = new TextEncoder();
                await gate;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      event: 'result',
                      ok: true,
                      result: burstyResult,
                    })}\n\n`
                  )
                );
                controller.close();
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          ),
        withCase: true,
      }
    );

    await userEvent.click(screen.getByRole('button', { name: 'evaluate' }));
    // Inputs change while the request is in flight.
    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    release();

    // The stale response must never become the current recommendation.
    await waitFor(() =>
      expect(screen.getByTestId('horizon').textContent).toBe('none')
    );
    expect(screen.getByTestId('hash').textContent).toBe('none');
  });
});

/* --------------------------------------- acceptance check 3, end to end */

describe('CHAT-03 end to end: Comparison shows the decision chat produced', () => {
  it('renders the chat decision on the comparison page, not "No evaluation yet"', async () => {
    const { ComparisonPage } = await import('../../pages/ComparisonPage');
    renderWithProviders(
      <>
        <ChatSender />
        <ComparisonPage />
      </>,
      { handler: evaluateStream(chatWithDecisionFixture), withChat: true }
    );

    // Before the turn, Comparison correctly reports it has nothing to show.
    await waitFor(() =>
      expect(screen.getByText('No evaluation yet')).toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole('button', { name: 'chat send' }));

    // Afterwards it shows that same decision, and says where it came from.
    await waitFor(() =>
      expect(screen.queryByText('No evaluation yet')).toBeNull()
    );
    expect(
      screen.getByText(/This decision came from the conversation/)
    ).toBeInTheDocument();
    expect(screen.getAllByText('$41.16').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('table', { name: 'Ranked qualified candidates' })
    ).toBeInTheDocument();
  });

  it('marks the comparison view out of date when inputs change afterwards', async () => {
    const { ComparisonPage } = await import('../../pages/ComparisonPage');
    renderWithProviders(
      <>
        <ChatSender />
        <PresetSwitcher />
        <ComparisonPage />
      </>,
      { handler: evaluateStream(chatWithDecisionFixture), withChat: true }
    );

    await userEvent.click(screen.getByRole('button', { name: 'chat send' }));
    await waitFor(() =>
      expect(screen.queryByText('No evaluation yet')).toBeNull()
    );
    expect(screen.queryByTestId('outdated-warning')).toBeNull();

    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('outdated-warning').length).toBeGreaterThan(0)
    );
  });
});
