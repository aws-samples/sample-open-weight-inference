import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ModelInspectionResult } from '../../api/types';
import { burstyResult } from '../../test/fixtures';
import {
  failEnvelope,
  okEnvelope,
  renderWithProviders,
  type ActionHandler,
} from '../../test/harness';
import { RequirementsEditorHarness } from '../../test/harness';

/**
 * Inspecting a model, from the user's side.
 *
 * The requirement being tested: a first-time user supplies a model source, and the
 * technical properties are filled in with a visible, truthful origin. "Detected"
 * must mean an inspection actually returned the value — not a preset, not the
 * advisor's recollection of the model.
 */

function field(
  origin: 'DETECTED' | 'NOT_DETECTED',
  value: string | null,
  detail: string
) {
  return {
    origin,
    value,
    detail,
    sourceUrl: origin === 'DETECTED' ? 'https://huggingface.co/api/models/x' : null,
  };
}

const MISTRAL: ModelInspectionResult = {
  source: 'huggingface',
  repo: 'mistralai/Mistral-7B-Instruct-v0.3',
  revision: 'c170c708c41dac9275d15a8fff4eca08d52bab71',
  retrievedAt: '2026-09-15T00:00:00+00:00',
  ok: true,
  error: null,
  access: 'PUBLIC',
  accessDetail: 'Downloadable without accepting additional terms.',
  weightFiles: 3,
  notes: [],
  fields: {
    architecture: field('DETECTED', 'MistralForCausalLM', 'Read from config.json.'),
    totalParamsB: field('DETECTED', '7.248', '7,248,023,552 tensor parameters.'),
    contextTokens: field('DETECTED', '32768', 'The maximum this model supports.'),
    weightsGb: field('DETECTED', '13.50', '14,495,514,624 bytes across 3 files.'),
    precision: field('DETECTED', 'BF16', 'torch_dtype bfloat16.'),
    licenseId: field('DETECTED', 'apache-2.0', 'Declared by the model card.'),
  },
};

/** Gated: the listing is readable, config.json is not. */
const GATED: ModelInspectionResult = {
  ...MISTRAL,
  repo: 'meta-llama/Llama-3.1-8B-Instruct',
  revision: '0e9e39f249a16976918f6564b8830bc894c89659',
  access: 'GATED',
  accessDetail:
    'The provider requires its terms to be accepted for the account that will fetch these weights, and reviews each request manually.',
  fields: {
    ...MISTRAL.fields,
    totalParamsB: field('DETECTED', '8.030', '8,030,261,248 tensor parameters.'),
    weightsGb: field('DETECTED', '14.96', '16,060,556,376 bytes across 4 files.'),
    licenseId: field('DETECTED', 'llama3.1', 'Declared by the model card.'),
    contextTokens: field(
      'NOT_DETECTED',
      null,
      'config.json is not readable without accepted terms and credentials.'
    ),
    precision: field(
      'NOT_DETECTED',
      null,
      'config.json is not readable without accepted terms and credentials.'
    ),
  },
};

const MISSING: ModelInspectionResult = {
  ...MISTRAL,
  repo: 'acme/nope',
  revision: null,
  ok: false,
  error:
    'Hugging Face returned no metadata for acme/nope. Either there is no repository with that name -- check the spelling, including capitals -- or it is private and needs credentials.',
  access: 'AUTHENTICATION_REQUIRED',
  accessDetail:
    'Hugging Face returns the same response for a repository that does not exist and one that is private.',
  fields: {
    architecture: field('NOT_DETECTED', null, 'not inspected'),
    totalParamsB: field('NOT_DETECTED', null, 'not inspected'),
    contextTokens: field('NOT_DETECTED', null, 'not inspected'),
    weightsGb: field('NOT_DETECTED', null, 'not inspected'),
    precision: field('NOT_DETECTED', null, 'not inspected'),
    licenseId: field('NOT_DETECTED', null, 'not inspected'),
  },
};

function inspectHandler(result: ModelInspectionResult | 'fail'): ActionHandler {
  return (action) => {
    if (action !== 'inspect_model') return okEnvelope(action, {});
    if (result === 'fail') {
      return failEnvelope(
        'inspect_model',
        'internal_error',
        'The inspector could not reach Hugging Face.'
      );
    }
    return okEnvelope('inspect_model', result);
  };
}

function renderWorkspace(handler: ActionHandler) {
  return renderWithProviders(<RequirementsEditorHarness />, { handler, withCase: true });
}

beforeEach(() => {
  // The case, including its decision, is persisted to localStorage, and jsdom is
  // shared across tests in a file. Without this a decision recorded by one test is
  // restored by the next.
  window.localStorage.clear();
});

function detailInput(name: string): HTMLInputElement {
  const input = screen.getByTestId(`detail-${name}`).querySelector('input');
  if (!input) throw new Error(`no input inside detail-${name}`);
  return input as HTMLInputElement;
}

async function openModelDetails() {
  const header = screen.getByRole('button', { name: /Model details/ });
  if (header.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(header);
  }
  await waitFor(() =>
    expect(screen.getByTestId('detail-architecture')).toBeVisible()
  );
}

async function inspect(source: string) {
  const input = screen.getByTestId('model-source').querySelector('input');
  await userEvent.clear(input as HTMLInputElement);
  await userEvent.type(input as HTMLInputElement, source);
  await userEvent.click(screen.getByTestId('inspect-model'));
}

describe('inspecting a model fills its technical properties', () => {
  it('sends the source to the coordinator, which does the reading', async () => {
    const { invocations } = renderWorkspace(inspectHandler(MISTRAL));
    await inspect('mistralai/Mistral-7B-Instruct-v0.3');

    await waitFor(() =>
      expect(
        invocations.some((call) => call.action === 'inspect_model')
      ).toBe(true)
    );
    const call = invocations.find((item) => item.action === 'inspect_model');
    expect(call?.payload).toEqual({
      source: 'mistralai/Mistral-7B-Instruct-v0.3',
    });
  });

  it('applies the detected values and labels them detected', async () => {
    renderWorkspace(inspectHandler(MISTRAL));
    await inspect('mistralai/Mistral-7B-Instruct-v0.3');
    await openModelDetails();

    await waitFor(() =>
      expect(detailInput('architecture')).toHaveValue('MistralForCausalLM')
    );
    // The real parameter count, not the "7" a preset carried.
    expect(detailInput('totalParamsB')).toHaveValue(7.248);
    expect(detailInput('weightsGb')).toHaveValue(13.5);
    expect(detailInput('contextTokens')).toHaveValue(32768);
    expect(screen.getAllByText('Detected from model').length).toBeGreaterThan(0);
    // Nothing is left claiming to be an example.
    expect(screen.queryByText('Example')).toBeNull();
  });

  it('shows the revision, so the values are pinned to a commit', async () => {
    renderWorkspace(inspectHandler(MISTRAL));
    await inspect('mistralai/Mistral-7B-Instruct-v0.3');
    await waitFor(() =>
      expect(screen.getByTestId('inspect-detected-count')).toHaveTextContent(
        'Read 6 of 6 properties'
      )
    );
    expect(screen.getByText(/c170c708c41d/)).toBeInTheDocument();
  });

  it('does not weaken to a guess when the model files are not readable', async () => {
    renderWorkspace(inspectHandler(GATED));
    await inspect('meta-llama/Llama-3.1-8B-Instruct');
    await openModelDetails();

    // Readable behind the gate.
    await waitFor(() =>
      expect(detailInput('totalParamsB')).toHaveValue(8.03)
    );
    expect(detailInput('weightsGb')).toHaveValue(14.96);
    // Not readable, and left empty rather than filled with a plausible 128000.
    expect(detailInput('contextTokens')).toHaveValue(null);
    expect(screen.getAllByText('Not detected').length).toBeGreaterThan(0);
  });

  it('reports a gate as an action to take, not as a failure', async () => {
    renderWorkspace(inspectHandler(GATED));
    await inspect('meta-llama/Llama-3.1-8B-Instruct');

    await waitFor(() =>
      expect(screen.getByTestId('inspect-access')).toBeInTheDocument()
    );
    const alert = screen.getByTestId('inspect-access');
    expect(alert).toHaveTextContent(/terms to be accepted/);
    expect(alert).toHaveTextContent(/reviews each request manually/);
    // A typed licence name must not read as having satisfied the requirement.
    expect(alert).toHaveTextContent(/not something a typed licence name satisfies/);
  });

  it('explains an unreadable source without claiming a detection', async () => {
    renderWorkspace(inspectHandler(MISSING));
    await inspect('acme/nope');

    await waitFor(() =>
      expect(screen.getByTestId('inspect-not-ok')).toBeInTheDocument()
    );
    const alert = screen.getByTestId('inspect-not-ok');
    // Both causes named: a mistyped name and a private repository are
    // indistinguishable here, and blaming access sends the user the wrong way.
    expect(alert).toHaveTextContent(/no repository with that name/);
    expect(alert).toHaveTextContent(/spelling/);
    expect(alert).toHaveTextContent(/private/);
    expect(screen.queryByText('Detected from model')).toBeNull();
  });

  it('surfaces a transport failure and records nothing', async () => {
    renderWorkspace(inspectHandler('fail'));
    await inspect('mistralai/Mistral-7B-Instruct-v0.3');

    await waitFor(() =>
      expect(screen.getByTestId('inspect-error')).toBeInTheDocument()
    );
    expect(screen.getByTestId('inspect-error')).toHaveTextContent(
      /could not reach Hugging Face/
    );
    expect(screen.getByText(/Nothing was recorded/)).toBeInTheDocument();
  });

  it('lets the user override a detected value, which is then theirs', async () => {
    renderWorkspace(inspectHandler(MISTRAL));
    await inspect('mistralai/Mistral-7B-Instruct-v0.3');
    await openModelDetails();
    await waitFor(() => expect(detailInput('weightsGb')).toHaveValue(13.5));

    await userEvent.clear(detailInput('weightsGb'));
    await userEvent.type(detailInput('weightsGb'), '20');

    await waitFor(() =>
      expect(screen.getAllByText('Provided by you').length).toBeGreaterThan(0)
    );
  });

  it('sends the detected values to the solver', async () => {
    const { invocations } = renderWorkspace((action, _payload, stream) => {
      if (action === 'inspect_model') return okEnvelope(action, MISTRAL);
      if (action === 'evaluate' && stream) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  // The real fixture shape: a bare `{}` is not an EvaluateResponse
                  // and the results panel throws on its missing arrays.
                  `data: ${JSON.stringify({ event: 'result', ok: true, result: burstyResult })}\n\n`
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return okEnvelope(action, {});
    });

    await inspect('mistralai/Mistral-7B-Instruct-v0.3');
    await waitFor(() =>
      expect(screen.getByTestId('inspect-detected-count')).toBeInTheDocument()
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Compare hosting options' })
    );

    await waitFor(() =>
      expect(invocations.some((call) => call.action === 'evaluate')).toBe(true)
    );
    const payload = invocations.find((call) => call.action === 'evaluate')
      ?.payload as { model: Record<string, unknown> };
    expect(payload.model.architecture).toBe('MistralForCausalLM');
    expect(payload.model.weightsGb).toBe('13.50');
    expect(payload.model.totalParamsB).toBe('7.248');
    expect(payload.model.hfRepo).toBe('mistralai/Mistral-7B-Instruct-v0.3');
  });
});


it('Enter in the source field inspects without submitting a placement evaluation', async () => {
  const { invocations } = renderWithProviders(<RequirementsEditorHarness />, {
    withCase: true,
    handler: (action) => okEnvelope(action, action === 'inspect_model' ? MISTRAL : burstyResult),
  });
  const source = screen.getByRole('textbox', { name: 'Model source' });
  await userEvent.clear(source);
  await userEvent.type(source, 'mistralai/Mistral-7B-Instruct-v0.3');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(invocations.filter((call) => call.action === 'inspect_model')).toHaveLength(1));
  expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(0);
});
