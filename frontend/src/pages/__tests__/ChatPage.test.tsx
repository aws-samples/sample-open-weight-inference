import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacePage } from '../WorkspacePage';
import type { ChatRequest, ChatResponse } from '../../api/types';
import {
  chatApiOnlyFixture,
  chatIntakeOnlyFixture,
  chatTruncatedFixture,
  chatWithDecisionFixture,
} from '../../test/fixtures';
import {
  failEnvelope,
  okEnvelope,
  renderWithProviders,
  sseFrames,
  streamOnce,
  type ActionHandler,
} from '../../test/harness';

/** Serve `chat` as a stream returning `response`. */
function chatHandler(response: ChatResponse): ActionHandler {
  return (action) => {
    if (action !== 'chat') return okEnvelope(action, {});
    return streamOnce(response);
  };
}

function renderChat(handler: ActionHandler) {
  return renderWithProviders(<WorkspacePage />, { handler, withChat: true });
}

/** The composer textarea. Queried by role: the accessible name is also on a wrapper. */
function composer() {
  return screen.getByRole('textbox', { name: 'Message EDDIE' });
}

async function ask(text: string) {
  await userEvent.type(composer(), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

function chatPayload(invocations: { action: string; payload: unknown }[]) {
  const call = invocations.find((item) => item.action === 'chat');
  if (!call) throw new Error('No chat invocation was recorded.');
  return call.payload as ChatRequest;
}

describe('chat empty state', () => {
  it('opens by asking what the user is building', () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    /*
     * "Ask anything" became "What are you building?" in the UXR-02 redesign. The
     * previous heading was open-ended in a way that did not tell a first-time user what
     * EDDIE is for, and the paragraph beneath it explained the *mechanism* (traffic
     * shape and duty cycle) before the user had said anything.
     */
    expect(screen.getByText('What are you building?')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Explore models, compare hosting costs and plan how to test your application/
      )
    ).toBeInTheDocument();
    // Still must not name a winner or explain economics before anything is known.
    expect(screen.queryByText(/favours burst-priced/)).toBeNull();
    expect(screen.queryByText(/Traffic shape drives the economics/)).toBeNull();
  });

  it('offers a prompt input with a send action', () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    expect(composer()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send message' })
    ).toBeInTheDocument();
  });

  it('offers the three starters before any response has arrived', () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    /*
     * The empty state previously showed backend-supplied example questions, which
     * meant its content depended on a fixture and could name a specific vendor. UXR-02
     * specifies three fixed starters instead, each of which fills the composer.
     */
    expect(screen.getByText('Help me choose a model')).toBeInTheDocument();
    expect(screen.getByText('Host a model I already have')).toBeInTheDocument();
    expect(screen.getByText('Check cost or capacity')).toBeInTheDocument();
  });

  it('prefills the composer from a starter instead of submitting it', async () => {
    const { invocations } = renderChat(chatHandler(chatIntakeOnlyFixture));
    await userEvent.click(screen.getByText('Help me choose a model'));

    /*
     * The starter is editable: its text lands in the box and nothing is sent. UXR-02 is
     * explicit that a starter must not "start work that incurs inference or build
     * costs", so a click that immediately spent a model call would be wrong.
     */
    await waitFor(() =>
      expect((composer() as HTMLTextAreaElement).value).toContain(
        'I need help choosing a model'
      )
    );
    expect(invocations.filter((item) => item.action === 'chat')).toHaveLength(0);
  });

  it('sends the prefilled starter once the user chooses to send', async () => {
    const { invocations } = renderChat(chatHandler(chatIntakeOnlyFixture));
    await userEvent.click(screen.getByText('Host a model I already have'));
    await waitFor(() => expect(composer()).not.toHaveValue(''));
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));
    const payload = chatPayload(invocations);
    expect(payload.message).toContain('I want to host this model');
    expect(payload.turnId).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload).not.toHaveProperty('messages');
  });

  it('disables send until something is typed', () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    const button = screen.getByRole('button', { name: 'Send message' });
    expect(
      button.hasAttribute('disabled') ||
        button.getAttribute('aria-disabled') === 'true'
    ).toBe(true);
  });
});

describe('a turn that returns a decision', () => {
  it('renders a compact decision summary from the structured decision', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Where should I host Llama 3.1 8B for a 3-day event?');

    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );
    // Figures come from `decision`, never from parsing the prose.
    expect(screen.getAllByText('Bedrock CMI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$41.16').length).toBeGreaterThan(0);
    expect(screen.getByText('17.02%')).toBeInTheDocument();
    expect(screen.getByText(/Actual 8.33%/)).toBeInTheDocument();
    expect(screen.getByTestId('summary-verdict')).toHaveTextContent(
      /Bursty traffic favours/
    );
  });

  it('keeps the full report out of the thread, behind an explicit action', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByTestId('open-decision-detail')).toBeInTheDocument()
    );
    // The long report is not inline: that is what pushed the composer off
    // screen and made a two-turn conversation 5,094 px tall.
    expect(
      screen.queryByRole('table', { name: 'Ranked qualified candidates' })
    ).toBeNull();
    expect(screen.queryByRole('table', { name: 'Cost line items' })).toBeNull();
    expect(screen.queryByText('Assumptions and provenance')).toBeNull();
  });

  it('marks a stipulated result as stipulated and conditional in the summary', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Checks stipulated')).toBeInTheDocument()
    );
    expect(screen.getByText('Conditional')).toBeInTheDocument();
    expect(screen.getByTestId('latency-status')).toHaveTextContent(
      'Latency supplied, not measured'
    );
  });

  it('renders the advisor markdown as formatted prose', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(
        screen.getByText('Bedrock Custom Model Import wins here')
      ).toBeInTheDocument()
    );
    // Bold inline markup is rendered, not shown as literal asterisks.
    expect(screen.getAllByText('8.33%').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\*\*8\.33%\*\*/)).toBeNull();
  });
});

describe('a turn with no decision', () => {
  it('renders prose only and no cost UI at all', async () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    await ask('I need to host a model');

    await waitFor(() =>
      expect(
        screen.getByText(/Before I can evaluate, I need to know which model/)
      ).toBeInTheDocument()
    );

    // No decision means no summary card, no break-even panel, no ranked table.
    expect(screen.queryByText('Placement decision')).toBeNull();
    expect(screen.queryByTestId('open-decision-detail')).toBeNull();
    expect(screen.queryByText('Duty-cycle break-even')).toBeNull();
    expect(
      screen.queryByRole('table', { name: 'Ranked qualified candidates' })
    ).toBeNull();
    expect(screen.queryByTestId('money-amount')).toBeNull();
    expect(screen.queryByTestId('money-unknown')).toBeNull();
  });

  it('says the advisor called no tool rather than implying it solved anything', async () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    await ask('I need to host a model');
    await waitFor(() =>
      expect(screen.getByText('What the advisor did')).toBeInTheDocument()
    );
    expect(screen.getByText('No evaluation')).toBeInTheDocument();
    expect(
      screen.getByText(/answered from the conversation without calling a tool/)
    ).toBeInTheDocument();
  });
});

describe('tool transparency', () => {
  it('lists the tools called, with the solver call marked', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Solver called')).toBeInTheDocument()
    );
    expect(
      screen.getByText('What the advisor did — including calling the solver')
    ).toBeInTheDocument();
    expect(screen.getByText('Ran the deterministic solver')).toBeInTheDocument();
    expect(screen.getByText('Retrieved live AWS prices')).toBeInTheDocument();
    expect(screen.getByText(/4 model rounds, 3 tool calls/)).toBeInTheDocument();
  });

  it('warns when the tool-call limit was reached', async () => {
    renderChat(chatHandler(chatTruncatedFixture));
    await ask('Something complicated');
    await waitFor(() =>
      expect(screen.getByTestId('chat-truncated-warning')).toBeInTheDocument()
    );
    expect(
      screen.getByText('This answer is incomplete')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the answer may be incomplete/)
    ).toBeInTheDocument();
  });

  it('does not warn about truncation on a normal turn', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Solver called')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('chat-truncated-warning')).toBeNull();
  });

  it('surfaces a failed tool call', async () => {
    renderChat(chatHandler(chatTruncatedFixture));
    await ask('Something complicated');
    await waitFor(() =>
      expect(screen.getByText('1 tool error')).toBeInTheDocument()
    );
  });
});

describe('case sync', () => {
  it('summarises the requirements the turn recorded, with a link to the form', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('3-day event, 6 hours of traffic, Llama 3.1 8B');

    await waitFor(() =>
      expect(screen.getByTestId('requirements-updated')).toBeInTheDocument()
    );
    const panel = screen.getByTestId('requirements-updated');
    expect(panel).toHaveTextContent('Requirements updated — 3 fields');
    expect(panel).toHaveTextContent('Architecture: LlamaForCausalLM');
    expect(panel).toHaveTextContent('Horizon (hours): 72');
    expect(panel).toHaveTextContent('Billable copy hours: 6');
    expect(panel).toHaveTextContent(/declared inputs.*not\s+measurements/s);
    expect(
      screen.getByRole('button', { name: 'Edit in case workspace' })
    ).toBeInTheDocument();
  });

  it('shows no summary when the turn changed nothing', async () => {
    renderChat(chatHandler(chatIntakeOnlyFixture));
    await ask('Hello');
    await waitFor(() =>
      expect(screen.getByText('What the advisor did')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('requirements-updated')).toBeNull();
  });

  it('sends the accumulated case back on the next turn', async () => {
    const { invocations } = renderChat(chatHandler(chatWithDecisionFixture));
    await ask('First question');
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );
    await ask('Follow-up question');
    await waitFor(() =>
      expect(
        invocations.filter((item) => item.action === 'chat').length
      ).toBe(2)
    );

    const second = invocations.filter((item) => item.action === 'chat')[1]
      .payload as ChatRequest;
    // Native server history, not browser-authored assistant/tool messages.
    expect(second.message).toBe('Follow-up question');
    expect(second).not.toHaveProperty('messages');
    expect(second.turnId).not.toBe(chatPayload(invocations).turnId);
    expect(second.case.architecture).toBe('LlamaForCausalLM');
    expect(second.case.horizonHours).toBe('72');
  });
});

describe('provenance', () => {
  it('names the advisor model and states it did not compute the numbers', async () => {
    renderChat(chatHandler(chatWithDecisionFixture));
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByTestId('chat-provenance')).toBeInTheDocument()
    );
    const line = screen.getByTestId('chat-provenance');
    expect(line).toHaveTextContent(/deterministic solver and live\s+AWS prices/s);
    expect(line).toHaveTextContent('it does not compute it');
    expect(line).toHaveTextContent(/claude-sonnet-4-5/);
  });
});

describe('API-only refusal reads as a correct outcome', () => {
  it('shows the refusal prose and the capability gap, not an error', async () => {
    renderChat(chatHandler(chatApiOnlyFixture));
    await ask('We want ElevenLabs voices. Can we host that ourselves?');

    await waitFor(() =>
      expect(
        screen.getByText(/does not distribute weights/)
      ).toBeInTheDocument()
    );
    // The capability gap is summarised; the failing gate detail is in the panel.
    expect(screen.getByText('Nothing recommended')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-turn-error')).toBeNull();
    // Cost is absent, so it never reads as $0.
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

describe('streaming and failure', () => {
  it('shows the runtime progress messages verbatim while working', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderChat((action) => {
      if (action !== 'chat') return okEnvelope(action, {});
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                event: 'progress',
                message: 'Retrieving regional prices',
              })}\n\n`
            )
          );
          await gate;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                event: 'result',
                ok: true,
                result: chatWithDecisionFixture,
              })}\n\n`
            )
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    await ask('Evaluate it');
    await waitFor(() =>
      expect(
        screen.getByText('Retrieving regional prices')
      ).toBeInTheDocument()
    );
    // The actual operation, not a claim that pricing is running.
    expect(screen.getByTestId('chat-progress')).toHaveTextContent(
      'Retrieving regional prices'
    );

    release();
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );
  });

  it('keeps the prompt visible and offers saved-answer recovery when a turn fails', async () => {
    renderChat(() =>
      failEnvelope('chat', 'internal_error', 'The advisor call timed out.')
    );
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-error')).toHaveTextContent(
        'The advisor call timed out.'
      )
    );
    expect(screen.getByText('Evaluate it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check saved answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('fails rather than showing a partial answer when the stream ends early', async () => {
    renderChat((action) => {
      if (action !== 'chat') return okEnvelope(action, {});
      return sseFrames([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({ event: 'progress', message: 'Working' }),
        JSON.stringify({ event: 'end' }),
      ]);
    });
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-error')).toHaveTextContent(
        /connection ended before completion/
      )
    );
    expect(screen.queryByText('Placement decision')).toBeNull();
  });
});
