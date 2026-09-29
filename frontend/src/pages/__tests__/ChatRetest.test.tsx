import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacePage } from '../WorkspacePage';
import { ResultKpiRow } from '../../components/KpiCards';
import { DecisionSummaryCard } from '../../components/DecisionSummary';
import {
  ConditionalResultNotice,
  LatencyStatusBadge,
  StrictModeNotice,
  UnsupportedInputsAlert,
} from '../../components/DecisionStatus';
import type { ChatRequest, ChatResponse } from '../../api/types';
import {
  burstyResult,
  chatIntakeOnlyFixture,
  chatStrictWithUnsupportedFixture,
  chatWithDecisionFixture,
  measuredQualification,
  notRequestedQualification,
  suppliedNotQualifiedQualification,
  suppliedNotQualifiedResult,
} from '../../test/fixtures';
import {
  failEnvelope,
  okEnvelope,
  renderWithProviders,
  streamOnce,
  type ActionHandler,
} from '../../test/harness';

function chatHandler(response: ChatResponse): ActionHandler {
  return (action, _payload, stream) =>
    action === 'chat'
      ? stream
        ? streamOnce(response)
        : okEnvelope(action, response)
      : okEnvelope(action, {});
}

function renderChat(handler: ActionHandler) {
  return renderWithProviders(<WorkspacePage />, { handler, withChat: true });
}

function composer() {
  return screen.getByRole('textbox', { name: 'Message EDDIE' });
}

async function ask(text: string) {
  await userEvent.type(composer(), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

function chatCalls(invocations: { action: string; payload: unknown }[]) {
  return invocations
    .filter((item) => item.action === 'chat')
    .map((item) => item.payload as ChatRequest);
}

/* ------------------------------------------------------------- CHAT-07 */

describe('CHAT-07: recovery never repeats the model turn', () => {
  /** The client lost the response, but the server saved the completed answer. */
  function flakyHandler(): ActionHandler {
    let saved: ChatRequest | null = null;
    return (action, payload) => {
      if (action === 'chat.history' && saved) return okEnvelope(action, {
        turns: [{
          turnId: saved.turnId, prompt: saved.message,
          reply: chatWithDecisionFixture.reply, status: 'COMPLETE',
          startedAt: Date.now() / 1000, casePatch: {},
          advisorModelId: chatWithDecisionFixture.advisorModelId,
        }],
        activeTurnId: null, expiresAt: null,
      });
      if (action !== 'chat') return okEnvelope(action, {});
      saved = payload as ChatRequest;
      return failEnvelope('chat', 'internal_error', 'The advisor call timed out.');
    };
  }

  it('replaces the failure instead of appending a duplicate prompt', async () => {
    renderChat(flakyHandler());
    await ask('Evaluate this workload');

    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-error')).toHaveTextContent(
        'The advisor call timed out.'
      )
    );
    // The prompt appears once, with a retry available.
    expect(screen.getAllByText('Evaluate this workload')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' }));

    await waitFor(() =>
      expect(screen.getByTestId('answer-complete')).toBeInTheDocument()
    );
    // One prompt, one current outcome, no stale failure and no stale Retry.
    expect(screen.getAllByText('Evaluate this workload')).toHaveLength(1);
    expect(screen.queryByTestId('chat-turn-error')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check saved answer' })).toBeNull();
  });

  it('never sends the failed prompt twice in the history', async () => {
    const { invocations } = renderChat(flakyHandler());
    await ask('Evaluate this workload');
    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-error')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' }));
    await waitFor(() =>
      expect(screen.getByTestId('answer-complete')).toBeInTheDocument()
    );

    const calls = chatCalls(invocations);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('Evaluate this workload');
    expect(calls[0]).not.toHaveProperty('messages');
  });

  it('uses a read action to recover a saved answer', async () => {
    const { invocations } = renderChat(flakyHandler());
    await ask('Evaluate this workload');
    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-error')).toBeInTheDocument()
    );
    const readsBefore = invocations.filter((call) => call.action === 'chat.history').length;
    await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' }));
    await waitFor(() =>
      expect(screen.getByTestId('answer-complete')).toBeInTheDocument()
    );

    expect(invocations.filter((call) => call.action === 'chat.history').length).toBeGreaterThan(readsBefore);
    expect(chatCalls(invocations)).toHaveLength(1);
  });

  it('does not offer a follow-up turn as a retry of an earlier one', async () => {
    const { invocations } = renderChat(chatHandler(chatIntakeOnlyFixture));
    await ask('First');
    await waitFor(() => expect(chatCalls(invocations)).toHaveLength(1));
    await ask('Second');
    await waitFor(() => expect(chatCalls(invocations)).toHaveLength(2));

    // The server restores history; the browser only sends the new prompt.
    const second = chatCalls(invocations)[1];
    expect(second.message).toBe('Second');
    expect(second).not.toHaveProperty('messages');
  });
});

/* ------------------------------------------------------------- CHAT-02 */

describe('latency status replaces the misleading measured boolean', () => {
  it('says no objective was requested rather than claiming measurement', () => {
    render(<LatencyStatusBadge qualification={notRequestedQualification} />);
    expect(screen.getByTestId('latency-status')).toHaveTextContent(
      'No latency objective requested'
    );
    // The old contradiction: "Performance measured: Yes" with nothing measured.
    expect(screen.queryByText(/measured: Yes/i)).toBeNull();
  });

  it('distinguishes a demonstrated SLO from one that was never requested', () => {
    const { unmount } = render(
      <LatencyStatusBadge qualification={measuredQualification} />
    );
    expect(screen.getByTestId('latency-status')).toHaveTextContent(
      'Latency measured'
    );
    unmount();
    render(<LatencyStatusBadge qualification={notRequestedQualification} />);
    expect(screen.getByTestId('latency-status')).not.toHaveTextContent(
      'Latency measured'
    );
  });

  it('marks a conditional result as conditional', () => {
    render(<ConditionalResultNotice qualification={notRequestedQualification} />);
    expect(screen.getByTestId('conditional-notice')).toHaveTextContent(
      'This is a conditional result'
    );
    expect(
      screen.getByText(/not\s+a demonstrated placement/)
    ).toBeInTheDocument();
  });

  it('does not mark a measured result as conditional', () => {
    render(<ConditionalResultNotice qualification={measuredQualification} />);
    expect(screen.queryByTestId('conditional-notice')).toBeNull();
  });

  it('carries the conditional marker into the compact summary', () => {
    render(
      <DecisionSummaryCard
        result={{ ...burstyResult, qualification: notRequestedQualification }}
      />
    );
    expect(screen.getByText('Conditional')).toBeInTheDocument();
    expect(screen.getByTestId('latency-status')).toHaveTextContent(
      'No latency objective requested'
    );
  });

  it('carries the latency status onto the KPI row', () => {
    render(
      <ResultKpiRow
        result={{ ...burstyResult, qualification: notRequestedQualification }}
      />
    );
    expect(screen.getByTestId('latency-status')).toBeInTheDocument();
    expect(screen.getByText('Conditional')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- CHAT-01 */

describe('unsupported inputs and strict mode', () => {
  it('names each input the solver could not apply, and why', () => {
    render(
      <UnsupportedInputsAlert
        unsupportedInputs={chatStrictWithUnsupportedFixture.unsupportedInputs}
      />
    );
    const alert = screen.getByTestId('unsupported-inputs');
    expect(alert).toHaveTextContent('1 input could not be applied');
    expect(alert).toHaveTextContent('sloMetric');
    expect(alert).toHaveTextContent('p99_ttfa_ms');
    expect(alert).toHaveTextContent(/not a metric the solver evaluates/);
  });

  it('renders nothing when every input applied', () => {
    render(<UnsupportedInputsAlert unsupportedInputs={[]} />);
    expect(screen.queryByTestId('unsupported-inputs')).toBeNull();
  });

  it('confirms strict mode was honoured', () => {
    render(<StrictModeNotice strict />);
    expect(screen.getByTestId('strict-mode-notice')).toHaveTextContent(
      /switched off at your request/
    );
  });

  it('shows unsupported inputs before the recommendation in a chat turn', async () => {
    renderChat(chatHandler(chatStrictWithUnsupportedFixture));
    await ask('Change this to us-west-2 with a 200 dollar budget');

    await waitFor(() =>
      expect(screen.getByTestId('unsupported-inputs')).toBeInTheDocument()
    );
    expect(screen.getByTestId('strict-mode-notice')).toBeInTheDocument();

    // Ordering matters: the caveat must not be discovered after the ranking.
    const unsupported = screen.getByTestId('unsupported-inputs');
    const summary = screen.getByText('Placement decision');
    expect(
      unsupported.compareDocumentPosition(summary) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('exposes the exact request the solver received', async () => {
    renderChat(chatHandler(chatStrictWithUnsupportedFixture));
    await ask('Change this to us-west-2');
    await waitFor(() =>
      expect(screen.getByTestId('evaluated-request')).toBeInTheDocument()
    );
    const payload = screen.getByTestId('evaluated-request');
    expect(payload).toHaveTextContent('us-west-2');
    expect(payload).toHaveTextContent('200');
  });

  it('reports a strict evaluation with nothing ranked as a real outcome', async () => {
    renderChat(chatHandler(chatStrictWithUnsupportedFixture));
    await ask('Do not assume those checks pass');
    await waitFor(() =>
      expect(screen.getByText('Nothing recommended')).toBeInTheDocument()
    );
    expect(screen.queryByText('Checks stipulated')).toBeNull();
    expect(screen.queryByTestId('chat-turn-error')).toBeNull();
  });
});

/* ------------------------------------------------------------- CHAT-06 */

describe('CHAT-06: the conversation stays readable', () => {
  it('keeps the composer and the summary in the thread, detail behind an action', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );

    // The composer is still present after a turn with a decision.
    expect(composer()).toBeInTheDocument();
    expect(screen.getByTestId('open-decision-detail')).toBeInTheDocument();
    // None of the long report is inline.
    for (const label of [
      'Ranked qualified candidates',
      'Cost line items',
      'Feasibility gates',
    ]) {
      expect(screen.queryByRole('table', { name: label })).toBeNull();
    }
    expect(screen.queryByText('Excluded candidates')).toBeNull();
    expect(screen.queryByText('Assumptions and provenance')).toBeNull();
  });

  it('shows the actual runtime operation, not a fixed pricing claim', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderChat((action) => {
      if (action !== 'chat') return okEnvelope(action, {});
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  event: 'progress',
                  message: 'Asking a clarifying question',
                })}\n\n`
              )
            );
            await gate;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  event: 'result',
                  ok: true,
                  result: chatIntakeOnlyFixture,
                })}\n\n`
              )
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    });

    await ask('What is this?');
    await waitFor(() =>
      expect(screen.getByTestId('chat-progress')).toHaveTextContent(
        'Asking a clarifying question'
      )
    );
    // A clarification turn must not claim live pricing is running.
    expect(screen.queryByText(/live price/i)).toBeNull();
    expect(screen.queryByText(/10 to 30/)).toBeNull();
    release();
  });

  it('does not name a winner or a service in the welcome copy', () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    /*
     * The point of this check is unchanged: nothing on the opening screen may imply an
     * answer before the user has said anything. What changed is the copy it guards.
     * The heading is now "What are you building?" and the subtitle states what EDDIE
     * does, rather than explaining duty cycles to someone who has not yet described a
     * workload.
     */
    expect(
      screen.getByText(
        /Explore models, compare hosting costs and plan how to test your application/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/favours burst-priced/)).toBeNull();
    expect(screen.queryByText(/Custom Model Import/)).toBeNull();
    expect(screen.queryByText(/Traffic shape drives the economics/)).toBeNull();
  });
});

/* ------------------------------------------------------------- CHAT-05 */

describe('a stale decision is visibly stale wherever it appears', () => {
  it('marks the compact summary out of date and drops the recommended framing', () => {
    render(
      <DecisionSummaryCard
        result={burstyResult}
        outdatedFields={['Horizon (hours)', 'Billable copy hours']}
      />
    );
    expect(screen.getByTestId('outdated-warning')).toHaveTextContent(
      'This result is out of date'
    );
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    // The "this is the recommendation" framing is withdrawn.
    expect(screen.queryByText('Recommended')).toBeNull();
    expect(
      screen.getByText(/Changed since: Horizon \(hours\), Billable copy hours\./)
    ).toBeInTheDocument();
  });

  it('marks the KPI row out of date', () => {
    render(
      <ResultKpiRow result={burstyResult} outdatedFields={['Horizon (hours)']} />
    );
    expect(screen.getByTestId('outdated-warning')).toBeInTheDocument();
    expect(
      screen.getByText('Recommended target (out of date)')
    ).toBeInTheDocument();
  });

  it('keeps the recommended framing when the inputs still match', () => {
    render(<DecisionSummaryCard result={burstyResult} />);
    expect(screen.queryByTestId('outdated-warning')).toBeNull();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });
});

/* --------------------------- latencyStatus semantics tightened (v1.1.0) */

describe('SUPPLIED names why the evidence did not qualify as a measurement', () => {
  it('surfaces the solver gate reason alongside the status', async () => {
    render(
      <LatencyStatusBadge
        qualification={suppliedNotQualifiedQualification}
        ranked={suppliedNotQualifiedResult.ranked}
      />
    );
    // The generic status is not enough: the gate says which metric the run
    // actually covered.
    await userEvent.click(screen.getByTestId('latency-status'));
    expect(await screen.findByTestId('latency-gate-reason')).toHaveTextContent(
      'covers p99_latency_ms but not ttft_ms'
    );
  });

  it('puts the reason in the conditional notice too', () => {
    render(
      <ConditionalResultNotice
        qualification={suppliedNotQualifiedQualification}
        ranked={suppliedNotQualifiedResult.ranked}
      />
    );
    expect(screen.getByTestId('conditional-gate-reason')).toHaveTextContent(
      'not qualified as a measurement'
    );
  });

  it('does not invent a reason when the status is not SUPPLIED', () => {
    render(
      <ConditionalResultNotice
        qualification={notRequestedQualification}
        ranked={suppliedNotQualifiedResult.ranked}
      />
    );
    // The gate reason belongs to supplied evidence; a never-requested objective
    // has nothing to explain.
    expect(screen.queryByTestId('conditional-gate-reason')).toBeNull();
  });

  it('reports SUPPLIED, not MEASURED, when no validated run exists', () => {
    expect(suppliedNotQualifiedQualification.performanceMeasured).toBe(false);
    expect(suppliedNotQualifiedQualification.benchmarkRunIds).toEqual([]);
    render(
      <DecisionSummaryCard result={suppliedNotQualifiedResult} />
    );
    expect(screen.getByTestId('latency-status')).toHaveTextContent(
      'Latency supplied, not measured'
    );
    expect(screen.getByText('Conditional')).toBeInTheDocument();
  });
});

describe('solver version', () => {
  it('reports the 1.1.0 solver from the fixtures', () => {
    expect(suppliedNotQualifiedResult.solverVersion).toMatch(/^1\.1\.0/);
  });
});
