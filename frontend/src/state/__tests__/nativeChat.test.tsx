import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AdvisorPanel } from '../../components/AdvisorPanel';
import { okEnvelope, renderWithProviders } from '../../test/harness';
import { EMPTY_PROJECT } from '../caseForm';
import type { ChatRequest } from '../../api/types';
import type { ProjectDocument } from '../persistence';
import sizingFixtures from '../../test/fixtures/inference-sizing.json';
import { DEFAULT_SIZING } from '../sizingDraft';
import { useCase } from '../CaseContext';

function SizingProbe() {
  const { sizingDraft, patchSizingDraft } = useCase();
  return <>
    <output data-testid="current-cache-budget">{sizingDraft.settings.contextTokens}</output>
    <button onClick={() => patchSizingDraft({
      settings: { ...sizingDraft.settings, contextTokens: '1024' },
    })}>Edit cache budget during answer</button>
  </>;
}

function SaveProbe() {
  const { projectSave, form, patch } = useCase();
  return <>
    <output data-testid="project-dirty">{String(projectSave.dirty)}</output>
    <button disabled={!projectSave.ready} onClick={() => void projectSave.save()}>Save test project</button>
    <button onClick={() => patch({ ...form, description: 'A real manual edit' })}>Edit test goal</button>
  </>;
}

function channel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    controller,
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    delta(text: string) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ event: 'answer_delta', delta: text })}\n\n`
      ));
    },
  };
}

async function ask() {
  await userEvent.type(screen.getByRole('textbox', { name: 'Message EDDIE Advisor' }), 'Help with my support pilot');
  await userEvent.click(screen.getByRole('button', { name: 'Send to Advisor' }));
}

describe('native Advisor browser state', () => {
  it.each([true, false])('only acknowledged conversation saves clear chat-only dirtiness (acknowledged: %s)', async acknowledged => {
    const pipe = channel();
    let request: ChatRequest | undefined;
    renderWithProviders(<><AdvisorPanel /><SaveProbe /></>, {
      withChat: true, initialForm: EMPTY_PROJECT,
      handler: (action, body) => {
        if (action === 'case.get') return okEnvelope(action, { project: null });
        if (action === 'case.save') {
          const payload = body as { caseId: string; document: ProjectDocument };
          return okEnvelope(action, { project: {
            caseId: payload.caseId, document: payload.document, revision: 'saved-1',
            savedAt: '2026-09-29T00:00:00Z', title: 'Test project',
          } });
        }
        if (action === 'chat') { request = body as ChatRequest; return pipe.response; }
        return okEnvelope(action, {});
      },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save test project' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save test project' }));
    await waitFor(() => expect(screen.getByTestId('project-dirty')).toHaveTextContent('false'));
    await ask();
    await act(async () => {
      const result = {
        ...(acknowledged ? { turnId: request!.turnId } : {}),
        reply: 'CPU needs a representative measurement.', status: 'COMPLETE', case: {}, casePatch: {},
        decision: null, toolCalls: [], rounds: 1, truncated: false, advisorModelId: 'test-model',
      };
      pipe.controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ event: 'complete', ok: true, result })}\n\n`
      ));
      pipe.controller.close();
    });
    await waitFor(() => expect(screen.getByTestId('answer-complete')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('project-dirty')).toHaveTextContent(acknowledged ? 'false' : 'true'));
    await userEvent.click(screen.getByRole('button', { name: 'Edit test goal' }));
    expect(screen.getByTestId('project-dirty')).toHaveTextContent('true');
  });

  it.each([false, true])('shares the sizing result and protects concurrent edits (manual edit: %s)', async (edit) => {
    const pipe = channel();
    renderWithProviders(<><AdvisorPanel /><SizingProbe /></>, {
      withChat: true, initialForm: EMPTY_PROJECT,
      handler: (action) => action === 'chat' ? pipe.response : okEnvelope(action, {}),
    });
    await ask();
    if (edit) await userEvent.click(screen.getByRole('button', { name: 'Edit cache budget during answer' }));
    await act(async () => {
      const result = {
        reply: 'The sizing sheet is ready to review.', case: {}, casePatch: {}, decision: null,
        toolCalls: [], rounds: 1, truncated: false, advisorModelId: 'test-model',
        usage: null, suggestedPrompts: [], provenance: null, evaluatedRequest: null,
        unsupportedInputs: [], strictRequestedByAdvisor: false,
        sizingReport: { ...sizingFixtures.gpu, settings: { ...DEFAULT_SIZING, contextTokens: '8192' } },
      };
      pipe.controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ event: 'complete', ok: true, result })}\n\n`
      ));
      pipe.controller.close();
    });
    await waitFor(() => expect(screen.getByTestId('current-cache-budget')).toHaveTextContent(edit ? '1024' : '8192'));
  });

  it('renders answer text during generation and preserves it after a broken stream', async () => {
    const pipe = channel();
    const { invocations } = renderWithProviders(<AdvisorPanel />, {
      withChat: true, initialForm: EMPTY_PROJECT,
      handler: (action) => action === 'chat' ? pipe.response : okEnvelope(action, {}),
    });
    await ask();
    await act(async () => pipe.delta('Start with a representative set of support tickets.'));
    await waitFor(() => expect(screen.getByTestId('answer-stream')).toHaveTextContent('representative set'));
    expect(screen.getByTestId('answer-stream')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('answer-complete')).toBeNull();
    await act(async () => pipe.delta(' Include rare categories too.'));
    expect(screen.getByTestId('answer-stream')).toHaveTextContent('Include rare categories too.');
    await act(async () => pipe.controller.error(new TypeError('Connection interrupted')));
    await waitFor(() => expect(screen.getByTestId('chat-turn-error')).toBeInTheDocument());
    expect(screen.getByTestId('answer-stream')).toHaveTextContent('representative set');
    expect(screen.getByRole('button', { name: 'Check saved answer' })).toBeInTheDocument();
    expect(invocations.filter((call) => call.action === 'chat')).toHaveLength(1);
  });

  it('accepts cancellation that finished before the explicit Stop request arrived', async () => {
    const pipe = channel();
    let request: ChatRequest | undefined;
    let cancelled = false;
    const { invocations } = renderWithProviders(<AdvisorPanel />, {
      withChat: true, initialForm: EMPTY_PROJECT,
      handler: (action, body) => {
        if (action === 'chat') { request = body as ChatRequest; return pipe.response; }
        if (action === 'chat.cancel') {
          cancelled = true;
          pipe.controller.error(new DOMException('Stopped', 'AbortError'));
          return okEnvelope(action, { requested: false, detail: 'No active matching turn was found.' });
        }
        if (action === 'chat.history' && cancelled && request) return okEnvelope(action, {
          activeTurnId: null, expiresAt: null, turns: [{
            turnId: request.turnId, prompt: request.message, reply: 'Keep this partial answer.',
            status: 'CANCELLED', startedAt: Date.now() / 1000, casePatch: {}, advisorModelId: 'test-model',
          }],
        });
        return okEnvelope(action, {});
      },
    });
    await ask();
    await act(async () => pipe.delta('Keep this partial answer.'));
    await waitFor(() => expect(screen.getByTestId('answer-stream')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stopping' })).toBeNull());
    expect(screen.getByText('Keep this partial answer.')).toBeInTheDocument();
    expect(screen.queryByText('Conversation recovery needs attention')).toBeNull();
    expect(invocations.filter((call) => call.action === 'chat')).toHaveLength(1);
    expect(invocations.filter((call) => call.action === 'chat.cancel')).toHaveLength(1);
  });
});
