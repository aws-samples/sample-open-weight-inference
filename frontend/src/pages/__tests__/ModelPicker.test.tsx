import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NoQualifiedCandidates } from '../../components/CandidateTable';
import { ResultsPanel } from '../../components/ResultsPanel';
import type { EvaluateRequest } from '../../api/types';
import { apiOnlyResult, burstyResult } from '../../test/fixtures';
import {
  expectDisabled,
  expectEnabled,
  okEnvelope,
  renderWithProviders,
  type ActionHandler,
} from '../../test/harness';
import { RequirementsEditorHarness } from '../../test/harness';

/**
 * The model block after the non-expert amendment.
 *
 * Two contract changes drive most of this file. Technical properties live in a
 * collapsed "Model details" section, so a test that wants one has to open it —
 * which is the acceptance criterion: a first-time user never needs to. And every
 * value carries a visible origin, so a seeded example cannot be mistaken for
 * something read from the model.
 */

function streamResult(): ActionHandler {
  return (action, _payload, stream) => {
    if (action !== 'evaluate' || !stream) return okEnvelope(action, {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              event: 'result',
              ok: true,
              result: burstyResult,
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
  };
}

function renderWorkspace() {
  return renderWithProviders(<RequirementsEditorHarness />, {
    handler: streamResult(),
    withCase: true,
  });
}

const PICKER = 'Which model do you want to use?';

/**
 * The real <input> for a Model details field.
 *
 * Cloudscape puts `data-testid` on its wrapper element, so `getByTestId` returns a
 * div: `toHaveValue` reads undefined on it and `clear()` refuses it as not editable.
 */
function detail(name: string): HTMLInputElement {
  const host = screen.getByTestId(`detail-${name}`);
  const input = host.querySelector('input');
  if (!input) throw new Error(`no input inside detail-${name}`);
  return input as HTMLInputElement;
}

/** Open the collapsed technical section, if it is not already open. */
async function openModelDetails() {
  const header = screen.getByRole('button', { name: /Model details/ });
  if (header.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(header);
  }
  await waitFor(() =>
    expect(screen.getByTestId('detail-architecture')).toBeVisible()
  );
}

async function pickModel(label: string) {
  const picker = screen.getByLabelText(PICKER);
  await userEvent.clear(picker);
  await userEvent.type(picker, label.slice(0, 12));
  // Matched on text content: Cloudscape splits the highlighted substring across
  // elements and gives the option no computed accessible name.
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('[role="option"]')].find(
      (node) => (node.textContent ?? '').startsWith(label)
    );
    if (!found) throw new Error(`Option "${label}" not offered.`);
    return found as HTMLElement;
  });
  await userEvent.click(option);
}

function payloadOf(invocations: { action: string; payload: unknown }[]) {
  const call = invocations.find((item) => item.action === 'evaluate');
  if (!call) throw new Error('No evaluate invocation was recorded.');
  return call.payload as EvaluateRequest;
}

describe('the model block asks a novice only what they know', () => {
  it('opens with the model question, not an architecture class', () => {
    renderWorkspace();
    expect(screen.getByLabelText(PICKER)).toBeInTheDocument();
    // The specific wording the reviewer objected to must be gone.
    expect(screen.queryByText(/Determines the CMI family/)).toBeNull();
    expect(screen.queryByText(/backend modality enum/)).toBeNull();
    expect(screen.queryByText(/sent verbatim to the solver/)).toBeNull();
    expect(screen.queryByText(/null, not as zero/)).toBeNull();
  });

  it('keeps the technical properties collapsed behind Model details', () => {
    renderWorkspace();
    // Present in the tree but not exposed until opened.
    const header = screen.getByRole('button', { name: /Model details/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers an explicit action to read the model, rather than asking for its internals', () => {
    renderWorkspace();
    expect(screen.getByTestId('model-source')).toBeInTheDocument();
    expect(screen.getByTestId('inspect-model')).toBeInTheDocument();
  });

  it('labels a preset value as an example, never as detected', async () => {
    renderWorkspace();
    await pickModel('Qwen2.5 7B Instruct');
    await openModelDetails();

    await waitFor(() =>
      expect(detail('architecture')).toHaveValue(
        'Qwen2ForCausalLM'
      )
    );
    // The badge is the honesty guarantee: a seeded number is an Example.
    expect(screen.getAllByText('Example').length).toBeGreaterThan(0);
    expect(screen.queryByText('Detected from model')).toBeNull();
    expect(
      screen.getByText(/example values for Qwen2.5 7B Instruct, not facts/)
    ).toBeInTheDocument();
  });

  it('fills the model block from one selection', async () => {
    renderWorkspace();
    await pickModel('Mixtral 8x7B Instruct');
    await openModelDetails();

    await waitFor(() =>
      expect(detail('architecture')).toHaveValue(
        'MixtralForCausalLM'
      )
    );
    expect(detail('totalParamsB')).toHaveValue(47);
    expect(detail('contextTokens')).toHaveValue(32768);
    expect(detail('weightsGb')).toHaveValue(94);
    expect(screen.getByTestId('usage-terms-value')).toHaveTextContent('apache-2.0');
  });

  it('sends the picked model block to the runtime', async () => {
    const { invocations } = renderWorkspace();
    await pickModel('DeepSeek-R1-Distill-Llama-8B');
    await waitFor(() =>
      expect(screen.getByTestId('usage-terms-value')).toHaveTextContent('mit')
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Compare hosting options' })
    );
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));

    const payload = payloadOf(invocations);
    expect(payload.model.architecture).toBe('LlamaForCausalLM');
    expect(payload.model.licenseId).toBe('mit');
    expect(payload.model.weightsExportable).toBe(true);
    expect(payload.model.modality).toBe('TEXT');
  });

  it('accepts a custom model name and leaves its properties unknown', async () => {
    renderWorkspace();
    const picker = screen.getByLabelText(PICKER);
    await userEvent.clear(picker);
    await userEvent.type(picker, 'Our Internal Model v4');
    await userEvent.click(
      await waitFor(() => {
        const found = [...document.querySelectorAll('[role="option"]')].find(
          (node) => (node.textContent ?? '').includes('Our Internal Model v4')
        );
        if (!found) throw new Error('Custom-name option not offered.');
        return found as HTMLElement;
      })
    );
    await openModelDetails();

    // Nothing is inherited from the model that was selected before.
    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(null)
    );
    expect(detail('architecture')).toHaveValue('');
    expect(screen.getAllByText('Not detected').length).toBeGreaterThan(0);
    expectEnabled(detail('weightsGb'));
  });

  it('does not inherit the previous model’s properties on a change', async () => {
    renderWorkspace();
    await pickModel('Llama 3.1 70B Instruct');
    await openModelDetails();
    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(140)
    );

    // Mistral 7B publishes a smaller artifact; 140 GiB must not survive.
    await pickModel('Mistral 7B Instruct v0.3');
    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(14)
    );
    expect(detail('architecture')).toHaveValue(
      'MistralForCausalLM'
    );
  });
});

describe('editing a value makes it the user’s, not the model’s', () => {
  it('relabels a hand-edited field as provided', async () => {
    renderWorkspace();
    await pickModel('Mistral 7B Instruct v0.3');
    await openModelDetails();
    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(14)
    );

    const field = detail('weightsGb');
    await userEvent.clear(field);
    await userEvent.type(field, '15');

    // Keeping the previous badge would attribute the user's correction to the
    // model's own metadata.
    await waitFor(() =>
      expect(screen.getAllByText('Provided by you').length).toBeGreaterThan(0)
    );
  });

  it('marks a cleared field as not detected rather than zero', async () => {
    renderWorkspace();
    await openModelDetails();
    const field = detail('totalParamsB');
    await userEvent.clear(field);
    await waitFor(() => expect(field).toHaveValue(null));
    expect(screen.getAllByText('Not detected').length).toBeGreaterThan(0);
  });
});

describe('modality select sends backend enum values', () => {
  it('asks what the model works with, in plain words', () => {
    renderWorkspace();
    expect(
      screen.getByLabelText('What should the model work with?')
    ).toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
  });

  it('sends VISION_LANGUAGE, not a display label, for a vision model', async () => {
    const { invocations } = renderWorkspace();
    await pickModel('Qwen2.5-VL 7B Instruct');
    await waitFor(() =>
      expect(
        screen.getByText('Vision-language (text + image in)')
      ).toBeInTheDocument()
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Compare hosting options' })
    );
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));
    expect(payloadOf(invocations).model.modality).toBe('VISION_LANGUAGE');
  });
});

describe('a model hosted only by its provider', () => {
  it('marks the inapplicable properties as not applicable, not merely blank', async () => {
    renderWorkspace();
    await pickModel('ElevenLabs (vendor API)');
    await openModelDetails();

    await waitFor(() =>
      expectDisabled(detail('totalParamsB'))
    );
    expectDisabled(detail('weightsGb'));
    expectDisabled(detail('contextTokens'));
    // "Not applicable" rather than "Not detected": no inspection will ever find a
    // weights size for a model whose weights are not distributed.
    expect(screen.getAllByText('Not applicable').length).toBeGreaterThan(0);
  });

  it('hides the model-source field, since there is nothing to inspect', async () => {
    renderWorkspace();
    expect(screen.getByTestId('model-source')).toBeInTheDocument();
    await pickModel('ElevenLabs (vendor API)');
    await waitFor(() => expect(screen.queryByTestId('model-source')).toBeNull());
    expect(screen.queryByTestId('inspect-model')).toBeNull();
  });

  it('clears the self-hosting fields rather than leaving Llama defaults behind', async () => {
    renderWorkspace();
    await openModelDetails();
    expect(detail('weightsGb')).toHaveValue(16);
    await pickModel('ElevenLabs (vendor API)');

    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(null)
    );
    expect(detail('totalParamsB')).toHaveValue(null);
    expect(detail('architecture')).toHaveValue('vendor-api');
  });

  it('says an API integration is the honest path, without jargon', async () => {
    renderWorkspace();
    await pickModel('ElevenLabs (vendor API)');
    await waitFor(() =>
      expect(screen.getByTestId('api-only-note')).toBeInTheDocument()
    );
    const note = screen.getByTestId('api-only-note');
    expect(note).toHaveTextContent(/Use the provider’s API/);
    expect(note).toHaveTextContent(/Other vendor API pricing needs a supported connector/);
    expect(note).toHaveTextContent(/Response time stays unverified until it has been tested/);
    // The internal gate name is no longer put in front of the user here.
    expect(note).not.toHaveTextContent(/weights_exportable/);
  });

  it('sends weightsExportable false and the vendor sentinel', async () => {
    const { invocations } = renderWorkspace();
    await pickModel('Amazon Transcribe (native, streaming ASR)');
    await openModelDetails();
    await waitFor(() =>
      expect(detail('architecture')).toHaveValue('vendor-api')
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Compare hosting options' })
    );
    await waitFor(() => expect(invocations.length).toBeGreaterThan(0));

    const payload = payloadOf(invocations);
    expect(payload.model.weightsExportable).toBe(false);
    expect(payload.model.modality).toBe('ASR');
    expect(payload.model.weightsGb).toBeNull();
    expect(payload.model.totalParamsB).toBeNull();
    expect(payload.model.licenseId).toBeNull();
  });

  it('re-enables the fields when switching back to open weights', async () => {
    renderWorkspace();
    await pickModel('ElevenLabs (vendor API)');
    await openModelDetails();
    await waitFor(() => expectDisabled(detail('weightsGb')));
    await pickModel('Llama 3.1 70B Instruct');
    await waitFor(() =>
      expect(detail('weightsGb')).toHaveValue(140)
    );
    expectEnabled(detail('weightsGb'));
  });
});

describe('usage terms replace a bare licence identifier', () => {
  it('states that a licence name is not permission', async () => {
    renderWorkspace();
    expect(screen.getByText('Usage terms')).toBeInTheDocument();
    expect(
      screen.getByText(/A licence name is a label, not permission/)
    ).toBeInTheDocument();
    // No top-level free-text licence input for a novice to guess at.
    expect(screen.queryByLabelText('Licence identifier')).toBeNull();
  });
});

describe('empty state for a correct API-only capability gap', () => {
  it('names the exportability gate and points at an API integration, not a form fix', () => {
    render(
      <NoQualifiedCandidates
        unresolved={apiOnlyResult.unresolved}
        excluded={apiOnlyResult.excluded}
      />
    );
    expect(screen.getByText('weights_exportable — FAIL')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Model is API-only; weights are not exportable for self-hosting'
      )
    ).toBeInTheDocument();

    const remedies = screen
      .getAllByTestId('gate-remedy')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(remedies).toContain('The honest path is an API integration');
    expect(remedies).toContain('Nothing in this form resolves it');
  });

  it('explains the import modality restriction for a speech model', () => {
    render(
      <NoQualifiedCandidates
        unresolved={apiOnlyResult.unresolved}
        excluded={apiOnlyResult.excluded}
      />
    );
    expect(screen.getByText('modality — FAIL')).toBeInTheDocument();
    const remedies = screen
      .getAllByTestId('gate-remedy')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(remedies).toContain('does not support the model’s inputs or outputs');
    expect(remedies).toContain('a validated serving container on SageMaker or your own compute');
  });

  it('reports both self-hosted candidates as excluded, never ranked', () => {
    render(
      <ResultsPanel
        result={apiOnlyResult}
        loading={false}
        error={null}
        neverRun={false}
      />
    );
    const rankedTable = screen.getByRole('table', {
      name: 'Ranked qualified candidates',
    });
    expect(
      within(rankedTable).queryByRole('button', { name: /Show detail for/ })
    ).toBeNull();
    expect(screen.getByText('Excluded candidates')).toBeInTheDocument();
    expect(screen.getAllByText(/Cost is UNKNOWN/).length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});
