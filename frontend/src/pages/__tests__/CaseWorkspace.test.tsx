import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { EvaluateRequest } from '../../api/types';
import { burstyResult } from '../../test/fixtures';
import {
  agentCore424,
  expectDisabled,
  expectEnabled,
  failEnvelope,
  okEnvelope,
  renderWithProviders,
  type ActionHandler,
} from '../../test/harness';
import { RequirementsEditorHarness } from '../../test/harness';

/** Serve `evaluate` as SSE, mirroring the streaming contract. */
function streamingHandler(frames: string[]): ActionHandler {
  return (action, _payload, stream) => {
    if (action !== 'evaluate' || !stream) return okEnvelope(action, {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

function renderWorkspace(handler: ActionHandler) {
  return renderWithProviders(<RequirementsEditorHarness />, {
    handler,
    withCase: true,
  });
}

/** The `evaluate` payload the app actually put on the wire. */
function evaluatePayload(invocations: { action: string; payload: unknown }[]) {
  const call = invocations.find((item) => item.action === 'evaluate');
  if (!call) throw new Error('No evaluate invocation was recorded.');
  return call.payload as EvaluateRequest;
}

async function evaluate() {
  await userEvent.click(
    screen.getByRole('button', { name: 'Compare hosting options' })
  );
}

/** The real <input>: Cloudscape puts `data-testid` on the wrapper element. */
function detailInput(name: string): HTMLInputElement {
  const input = screen.getByTestId(`detail-${name}`).querySelector('input');
  if (!input) throw new Error(`no input inside detail-${name}`);
  return input as HTMLInputElement;
}

/** Open the collapsed technical section that holds the model's properties. */
async function openModelDetails() {
  const header = screen.getByRole('button', { name: /Model details/ });
  if (header.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(header);
  }
  await waitFor(() =>
    expect(screen.getByTestId('detail-architecture')).toBeVisible()
  );
}

describe('CaseWorkspace', () => {
  it('starts with an explicit empty result state and both presets', () => {
    renderWorkspace(streamingHandler([]));
    expect(screen.getByText('No evaluation yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '3-day bursty event' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    ).toBeInTheDocument();
  });

  it('shows the implied duty cycle for the default bursty preset', () => {
    renderWorkspace(streamingHandler([]));
    expect(
      screen.getByText(/Active for an estimated 8.33% of this period/)
    ).toBeInTheDocument();
  });

  it('recomputes the duty cycle when the always-on preset is applied', async () => {
    renderWorkspace(streamingHandler([]));
    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Active for an estimated 100.00% of this period/)
      ).toBeInTheDocument()
    );
  });

  it('streams progress, then renders the KPI row and the winner', async () => {
    renderWorkspace(
      streamingHandler([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({
          event: 'progress',
          message: 'Retrieving regional prices',
        }),
        JSON.stringify({ event: 'result', ok: true, result: burstyResult }),
        JSON.stringify({ event: 'end' }),
      ])
    );

    await userEvent.click(screen.getByRole('button', { name: 'Advanced evidence and assumptions' }));
    await userEvent.click(screen.getByLabelText('Assume account and deployment checks pass'));
    await evaluate();

    await waitFor(() =>
      expect(screen.getByText('Recommended target')).toBeInTheDocument()
    );
    // KPI row values come from the solver output.
    // Appears in the KPI tile and again in the ranked table.
    expect(screen.getAllByText('Bedrock CMI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$41.16').length).toBeGreaterThan(0);
    expect(screen.getAllByText('17.02%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('8.33%').length).toBeGreaterThan(0);
  });

  it('keeps the stipulation warning visible with the result', async () => {
    renderWorkspace(
      streamingHandler([
        JSON.stringify({ event: 'result', ok: true, result: burstyResult }),
      ])
    );
    await evaluate();
    await waitFor(() =>
      expect(
        screen.getByText(
          'Licence, quota, recipe and capacity checks were stipulated, not verified'
        )
      ).toBeInTheDocument()
    );
  });

  it('shows a handled invalid_request detail verbatim, naming the field', async () => {
    renderWorkspace(() =>
      failEnvelope('evaluate', 'invalid_request', 'model.architecture is required')
    );
    await evaluate();
    await waitFor(() =>
      expect(
        screen.getByText('The request was rejected as invalid')
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId('evaluate-error-detail')).toHaveTextContent(
      'model.architecture is required'
    );
    // Not replaced by a generic message.
    expect(
      screen.queryByText('EDDIE could not complete the evaluation')
    ).toBeNull();
  });

  it('shows the generic coordinator error for a 424 without inventing a detail', async () => {
    renderWorkspace(() => agentCore424());
    await evaluate();
    await waitFor(() =>
      expect(
        screen.getByText('The coordinator reported an error')
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId('evaluate-error-detail')).toHaveTextContent(
      /does not pass the underlying detail through/
    );
    expect(
      screen.queryByText(/Received error \(400\) from runtime/)
    ).toBeNull();
  });

  it('shows nothing rather than a partial decision when the stream ends early', async () => {
    renderWorkspace(
      streamingHandler([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({ event: 'progress', message: 'Retrieving prices' }),
        JSON.stringify({ event: 'end' }),
      ])
    );
    await evaluate();
    await waitFor(() =>
      expect(screen.getByTestId('evaluate-error-detail')).toHaveTextContent(
        /connection ended before completion/
      )
    );
    expect(screen.queryByText('Recommended target')).toBeNull();
  });

  it('blocks evaluation when a required field is cleared, explaining why', async () => {
    renderWorkspace(streamingHandler([]));
    // Architecture now lives under Model details. It is still required -- the
    // solver cannot pick a hosting family without it -- so moving it out of basic
    // intake must not have weakened the check.
    await openModelDetails();
    await userEvent.clear(detailInput('architecture'));
    await waitFor(() =>
      expectDisabled(
        screen.getByRole('button', { name: 'Compare hosting options' })
      )
    );
    expect(screen.getByText(/Read the model details before comparing/)).toBeInTheDocument();
  });

  it('does not block evaluation when the optional model facts are cleared', async () => {
    /*
     * The acceptance check from the non-expert review: parameter count, context
     * length, weights size and licence are optional. Clearing all four must raise
     * no required-field error and must leave the request able to run, with those
     * values absent rather than zero.
     *
     * The fix for their presentation was never allowed to make them mandatory, and
     * this is what would catch that regression.
     */
    renderWorkspace(streamingHandler([]));
    await openModelDetails();
    for (const field of ['totalParamsB', 'contextTokens', 'weightsGb']) {
      await userEvent.clear(detailInput(field));
    }
    await waitFor(() => expect(detailInput('weightsGb')).toHaveValue(null));

    expectEnabled(screen.getByRole('button', { name: 'Compare hosting options' }));
    expect(screen.queryByText(/is required/)).toBeNull();
  });
});

describe('preset payloads reach the runtime', () => {
  const okStream = () =>
    streamingHandler([
      JSON.stringify({ event: 'result', ok: true, result: burstyResult }),
    ]);

  it('sends the bursty shape without inventing cleared account checks', async () => {
    const { invocations } = renderWorkspace(okStream());
    await userEvent.click(
      screen.getByRole('button', { name: '3-day bursty event' })
    );
    await evaluate();
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));

    const payload = evaluatePayload(invocations);
    expect(payload.workload.horizonHours).toBe('72');
    expect(payload.workload.billableCopyHours).toBe('6');
    expect(payload.slos).toEqual([]);
    expect(payload.assumeChecksCleared).toBe(false);
    expect(payload.latencyEvidence).toBeNull();
  });

  it('sends the always-on shape without inventing cleared account checks', async () => {
    const { invocations } = renderWorkspace(okStream());
    await userEvent.click(
      screen.getByRole('button', { name: 'Always-on 30 days' })
    );
    await evaluate();
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));

    const payload = evaluatePayload(invocations);
    expect(payload.workload.horizonHours).toBe('720');
    expect(payload.workload.billableCopyHours).toBe('720');
    expect(payload.workload.dedicatedInstanceHours).toBeNull();
    expect(payload.slos).toEqual([]);
    expect(payload.assumeChecksCleared).toBe(false);
  });

  it('keeps a declared latency target when a usage shortcut changes the horizon', async () => {
    const { invocations } = renderWorkspace(okStream());
    await userEvent.click(screen.getByLabelText('Set a response-time target'));
    const threshold = screen.getByLabelText('Response-time target in milliseconds');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '5000');
    await userEvent.click(screen.getByRole('button', { name: 'Always-on 30 days' }));
    await evaluate();
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));
    const payload = evaluatePayload(invocations);
    expect(payload.workload.horizonHours).toBe('720');
    expect(payload.slos).toHaveLength(1);
    expect(payload.slos[0].thresholdMs).toBe('5000');
    expect(payload.slos[0].includeCold).toBe(true);
    expect(payload.assumeChecksCleared).toBe(false);
    expect(payload.latencyEvidence).toBeNull();
  });
});

describe('usage shortcuts and optional evidence', () => {
  it('explains the actual usage without promising a winning service', async () => {
    renderWorkspace(streamingHandler([]));
    await userEvent.click(screen.getByRole('button', { name: '3-day bursty event' }));
    expect(screen.getByText(/estimated 6 billable hours/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Latency gate' })).toBeNull();
    expect(screen.queryByText(/should rank first/)).toBeNull();
  });

  it('explains assumptions once and keeps their status visible when collapsed', async () => {
    renderWorkspace(streamingHandler([]));
    await userEvent.click(screen.getByRole('button', { name: 'Advanced evidence and assumptions' }));
    await userEvent.click(screen.getByLabelText('Assume account and deployment checks pass'));
    expect(screen.getByText('For a hypothetical estimate only. This does not verify your account or allow deployment.')).toBeVisible();
    expect(screen.getByLabelText('Assume account and deployment checks pass')).toBeChecked();
    expect(screen.queryByText('Checks will be stipulated, not verified')).toBeNull();
    expect(screen.queryByText('Assumptions or supplied results in use')).toBeNull();
    expect(screen.queryByText(/Without latency evidence, a latency gate/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Advanced evidence and assumptions' }));
    expect(screen.getByText('Assumptions or supplied results in use')).toBeVisible();
  });

  it('opens an empty evidence editor without manufacturing performance numbers', async () => {
    renderWorkspace(streamingHandler([]));
    await userEvent.click(screen.getByRole('button', { name: 'Advanced evidence and assumptions' }));
    await userEvent.click(screen.getByLabelText('Supply latency evidence for a candidate'));
    expect(screen.getByLabelText('Candidate ID for evidence record 1')).toHaveValue('cmi-scale-to-zero');
    expect(screen.getByLabelText('Cold start for evidence record 1')).toHaveValue(null);
    expect(screen.getByText(/These figures are attributed to you, not measured by/)).toBeVisible();
  });

  it('explains that a response-time target needs a benchmark', async () => {
    renderWorkspace(streamingHandler([]));
    await userEvent.click(screen.getByLabelText('Set a response-time target'));
    const explanation = screen.getByText(/needs benchmark results before it can confirm this target/);
    expect(explanation).toBeVisible();
    expect(explanation).toHaveTextContent(/EDDIE needs benchmark results before it can confirm this target/);
  });
});
