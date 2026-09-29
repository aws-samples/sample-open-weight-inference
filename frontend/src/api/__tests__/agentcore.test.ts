import { describe, expect, it, vi } from 'vitest';
import {
  AgentCoreClient,
  ApiError,
  CoordinatorFailureError,
  InvalidInvocationError,
  MIN_SESSION_ID_LENGTH,
  NotAuthenticatedError,
  createSessionId,
  getOrCreateSessionId,
  resetSessionId,
  interpretResponse,
  invocationUrl,
  parseSseFrame,
} from '../agentcore';
import { burstyResult, configFixture, healthFixture } from '../../test/fixtures';
import {
  agentCore424,
  failEnvelope,
  okEnvelope,
  recordingTransport,
} from '../../test/harness';

function makeClient(handler: Parameters<typeof recordingTransport>[0]) {
  const { fetchImpl, invocations } = recordingTransport(handler);
  const client = new AgentCoreClient({
    config: configFixture,
    getAccessToken: async () => 'access-token-1',
    fetchImpl,
    sessionId: 'eddie-testsessionidtestsessionidtest01',
  });
  return { client, invocations };
}

describe('invocationUrl', () => {
  it('percent-encodes the runtime ARN into a single path segment', () => {
    const url = invocationUrl(configFixture);
    expect(url).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/' +
        encodeURIComponent(configFixture.agentRuntimeArn) +
        '/invocations?qualifier=DEFAULT'
    );
    // The raw ARN separators must not survive into the path.
    expect(url).not.toContain('arn:aws:');
    expect(url).toContain('%3A');
  });

  it('targets the region from the runtime config', () => {
    expect(
      invocationUrl({ ...configFixture, region: 'eu-west-2' })
    ).toContain('bedrock-agentcore.eu-west-2.amazonaws.com');
  });
});

describe('createSessionId', () => {
  it('always meets AgentCore’s 33-character minimum', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(createSessionId().length).toBeGreaterThanOrEqual(
        MIN_SESSION_ID_LENGTH
      );
    }
  });

  it('is unique per call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createSessionId()));
    expect(ids.size).toBe(20);
  });
});

describe('runtime sessions across application updates', () => {
  it('replaces a legacy session without touching project drafts', () => {
    sessionStorage.clear();
    sessionStorage.setItem('eddie.agentcore-session-id', 'eddie-legacy-session-12345678901234567890');
    localStorage.setItem('eddie.case.saved-draft', 'keep this draft');
    const id = getOrCreateSessionId(configFixture);
    expect(id).not.toBe('eddie-legacy-session-12345678901234567890');
    expect(getOrCreateSessionId(configFixture)).toBe(id);
    expect(localStorage.getItem('eddie.case.saved-draft')).toBe('keep this draft');
  });

  it('rotates on a release change and sign-out while retaining a stable session within a release', () => {
    resetSessionId();
    const before = getOrCreateSessionId({ ...configFixture, releaseId: 'before' });
    const after = getOrCreateSessionId({ ...configFixture, releaseId: 'after' });
    expect(after).not.toBe(before);
    expect(getOrCreateSessionId({ ...configFixture, releaseId: 'after' })).toBe(after);
    resetSessionId();
    expect(getOrCreateSessionId({ ...configFixture, releaseId: 'after' })).not.toBe(after);
  });

  it('explains a version mismatch without exposing the dispatch table', () => {
    const result = interpretResponse(200, JSON.stringify({
      ok: false, error: 'invalid_action', detail: "action must be one of ['catalog', 'chat']",
    }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('Expected a handled failure.');
    expect(result.error.code).toBe('runtime_version_mismatch');
    expect(result.error.message).toContain('Keep a copy of unsaved changes');
    expect(result.error.message).not.toContain('catalog');
  });
});

describe('AgentCoreClient request shape', () => {
  it('POSTs {action, payload} with the bearer token and session id header', async () => {
    const { client, invocations } = makeClient((action) =>
      okEnvelope(action, healthFixture)
    );
    await client.health();

    expect(invocations).toHaveLength(1);
    const call = invocations[0];
    expect(call.action).toBe('health');
    expect(call.payload).toEqual({});
    expect(call.headers.Authorization).toBe('Bearer access-token-1');
    expect(call.headers['content-type']).toBe('application/json');
    expect(
      call.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'].length
    ).toBeGreaterThanOrEqual(MIN_SESSION_ID_LENGTH);
  });

  it('maps each UI operation onto its documented action name', async () => {
    const { client, invocations } = makeClient((action) =>
      okEnvelope(action, {})
    );
    await client.health();
    await client.rates({ instanceType: 'ml.g5.2xlarge' });
    await client.catalogModels();
    await client.knowledge({ query: 'q' });
    await client.demoStatus();
    await client.demoWake();
    await client.demoSleep();

    expect(invocations.map((call) => call.action)).toEqual([
      'health',
      'rates',
      'catalog',
      'knowledge',
      'demo.status',
      'demo.wake',
      'demo.sleep',
    ]);
  });

  it('passes the rates payload as a body field, not a query string', async () => {
    const { client, invocations } = makeClient((action) =>
      okEnvelope(action, {})
    );
    await client.rates({
      instanceType: 'ml.g5.2xlarge',
      architecture: 'LlamaForCausalLM',
    });
    expect(invocations[0].payload).toEqual({
      instanceType: 'ml.g5.2xlarge',
      architecture: 'LlamaForCausalLM',
    });
    expect(invocations[0].url).not.toContain('instanceType=');
  });

  it('refuses to invoke without an access token', async () => {
    const { fetchImpl, invocations } = recordingTransport((action) =>
      okEnvelope(action, {})
    );
    const client = new AgentCoreClient({
      config: configFixture,
      getAccessToken: async () => null,
      fetchImpl,
      sessionId: 'eddie-testsessionidtestsessionidtest01',
    });
    await expect(client.health()).rejects.toBeInstanceOf(NotAuthenticatedError);
    // Nothing was sent, so no unauthenticated request reaches the runtime.
    expect(invocations).toHaveLength(0);
  });
});

describe('envelope unwrapping', () => {
  it('returns the result from an ok:true envelope', async () => {
    const { client } = makeClient((action) => okEnvelope(action, burstyResult));
    const result = await client.evaluate({} as never);
    expect(result.outcome).toBe('QUALIFIED_PLACEMENT');
    expect(client.lastElapsedMs).toBe(1958.6);
  });

  it('treats ok:false as a failure even though the status is 200', async () => {
    const { client } = makeClient((action) =>
      failEnvelope(action, 'invalid_request', 'model.architecture is required')
    );
    const error = await client.evaluate({} as never).catch((c: unknown) => c);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(200);
    expect(apiError.code).toBe('invalid_request');
    // The detail is preserved verbatim for display; it names the field.
    expect(apiError.detail).toBe('model.architecture is required');
    expect(apiError.message).toBe('model.architecture is required');
    expect(apiError.handled).toBe(true);
  });

  it('surfaces each handled error code with its own detail', async () => {
    for (const code of [
      'invalid_request',
      'unknown_action',
      'invalid_json',
      'internal_error',
    ]) {
      const { client } = makeClient((action) =>
        failEnvelope(action, code, `detail for ${code}`)
      );
      const error = (await client
        .health()
        .catch((c: unknown) => c)) as ApiError;
      expect(error.code).toBe(code);
      expect(error.detail).toBe(`detail for ${code}`);
      expect(error.handled).toBe(true);
    }
  });

  it('rejects a 200 that carries no result field', async () => {
    const { client } = makeClient(
      () =>
        new Response(JSON.stringify({ action: 'health', ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const error = (await client.health().catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe('invalid_envelope');
  });

  it('requires explicit success rather than trusting a result field alone', () => {
    const outcome = interpretResponse(200, JSON.stringify({ result: { winner: 'unverified' } }));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('invalid_envelope');
  });
});

describe('answer streaming without another invocation', () => {
  function controlledResponse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    return {
      controller,
      response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
      frame(value: unknown) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
      },
    };
  }

  it('delivers visible text before a completion frame or stream closure', async () => {
    const stream = controlledResponse();
    const { client, invocations } = makeClient(() => stream.response);
    const text: string[] = [];
    let completed = false;
    const result = client.chatStream({ message: 'Hello', turnId: 'turn-1', case: {} } as never,
      (event) => { if (typeof event.delta === 'string') text.push(event.delta); }).then((value) => {
      completed = true;
      return value;
    });
    stream.frame({ event: 'answer_delta', delta: 'First words' });
    await vi.waitFor(() => expect(text).toEqual(['First words']));
    expect(completed).toBe(false);
    stream.frame({ event: 'answer_delta', delta: ' arriving now.' });
    await vi.waitFor(() => expect(text.join('')).toBe('First words arriving now.'));
    expect(completed).toBe(false);
    stream.frame({ event: 'complete', ok: true, result: { reply: text.join('') } });
    stream.controller.close();
    expect((await result).reply).toBe('First words arriving now.');
    expect(invocations).toHaveLength(1);
  });

  it('handles every split UTF-8 byte, CRLF frame and multiple frames per chunk', async () => {
    const stream = controlledResponse();
    const { client } = makeClient(() => stream.response);
    const deltas: string[] = [];
    const result = client.chatStream({} as never, (event) => {
      if (typeof event.delta === 'string') deltas.push(event.delta);
    });
    const first = new TextEncoder().encode(
      'event: answer_delta\r\ndata: {"delta":"Café 日本語 👋"}\r\n\r\n'
    );
    for (const byte of first) stream.controller.enqueue(new Uint8Array([byte]));
    stream.controller.enqueue(new TextEncoder().encode(
      ': heartbeat\r\n\r\nevent: answer_delta\r\ndata: {"delta":" ready"}\r\n\r\n' +
      'event: complete\r\ndata: {"ok":true,"result":{"reply":"Café 日本語 👋 ready"}}\r\n\r\n'
    ));
    stream.controller.close();
    expect((await result).reply).toBe('Café 日本語 👋 ready');
    expect(deltas).toEqual(['Café 日本語 👋', ' ready']);
  });

  it('keeps already-delivered text when the stream fails and never retries', async () => {
    const stream = controlledResponse();
    const { client, invocations } = makeClient(() => stream.response);
    const deltas: string[] = [];
    const result = client.chatStream({} as never, (event) => {
      if (typeof event.delta === 'string') deltas.push(event.delta);
    }).catch((error: unknown) => error);
    stream.frame({ event: 'answer_delta', delta: 'Partial answer' });
    await vi.waitFor(() => expect(deltas).toEqual(['Partial answer']));
    stream.controller.error(new TypeError('Connection interrupted'));
    expect(await result).toBeInstanceOf(TypeError);
    expect(deltas).toEqual(['Partial answer']);
    expect(invocations).toHaveLength(1);
  });

  it('does not turn an unsuccessful completion envelope into success', async () => {
    const stream = controlledResponse();
    const { client, invocations } = makeClient(() => stream.response);
    const result = client.chatStream({} as never, () => {}).catch((error: unknown) => error);
    stream.frame({ event: 'complete', ok: false, error: 'denied', detail: 'Access denied', result: {} });
    stream.controller.close();
    expect(await result).toMatchObject({ code: 'denied' });
    expect(invocations).toHaveLength(1);
  });

  it('rejects oversized complete frames as well as unfinished frames', async () => {
    const stream = controlledResponse();
    const { client } = makeClient(() => stream.response);
    const result = client.chatStream({} as never, () => {}).catch((error: unknown) => error);
    stream.frame({ event: 'answer_delta', delta: 'x'.repeat(4 * 1024 * 1024) });
    stream.controller.close();
    expect(await result).toMatchObject({ code: 'invalid_stream' });
  });
});

describe('transport-level failures', () => {
  it('classifies 424 as a coordinator failure without inventing a detail', async () => {
    const { client } = makeClient(() => agentCore424());
    const error = (await client.health().catch((c: unknown) => c)) as ApiError;
    expect(error).toBeInstanceOf(CoordinatorFailureError);
    expect(error.status).toBe(424);
    expect(error.code).toBe('coordinator_failure');
    expect(error.handled).toBe(false);
    // AgentCore's generic message is not echoed as if it were a real cause.
    expect(error.detail).not.toContain('Received error (400) from runtime');
    expect(error.detail).toContain('does not pass the underlying detail');
  });

  it('classifies 401 and 403 as an authentication problem', async () => {
    for (const status of [401, 403]) {
      const { client } = makeClient(
        () => new Response('{}', { status })
      );
      const error = (await client.health().catch((c: unknown) => c)) as ApiError;
      expect(error).toBeInstanceOf(NotAuthenticatedError);
      expect(error.code).toBe('not_authenticated');
    }
  });

  it('classifies a 400 from AgentCore as a malformed invocation', async () => {
    const { client } = makeClient(
      () =>
        new Response(
          JSON.stringify({ message: 'runtimeSessionId must be at least 33 characters' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const error = (await client.health().catch((c: unknown) => c)) as ApiError;
    expect(error).toBeInstanceOf(InvalidInvocationError);
    expect(error.code).toBe('invalid_invocation');
    expect(error.detail).toContain('33 characters');
  });

  it('reports a thrown fetch as a network error', async () => {
    const { client } = makeClient(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await client.health().catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe('network_error');
  });
});

describe('interpretResponse', () => {
  it('branches on ok, not on the HTTP status', () => {
    const success = interpretResponse<{ a: number }>(
      200,
      JSON.stringify({ action: 'x', ok: true, result: { a: 1 }, elapsedMs: 5 })
    );
    expect(success).toEqual({ kind: 'ok', result: { a: 1 }, elapsedMs: 5 });

    const failure = interpretResponse(
      200,
      JSON.stringify({ action: 'x', ok: false, error: 'invalid_json', detail: 'bad' })
    );
    expect(failure.kind).toBe('error');
  });

  it('reports invalid JSON on a 2xx', () => {
    const outcome = interpretResponse(200, 'not json at all');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.code).toBe('invalid_response');
    }
  });
});

describe('parseSseFrame', () => {
  it('parses a progress frame', () => {
    const event = parseSseFrame(
      'data: {"event":"progress","message":"Retrieving regional prices"}'
    );
    expect(event).toEqual({
      event: 'progress',
      message: 'Retrieving regional prices',
    });
  });

  it('parses a result frame carrying ok:true', () => {
    const event = parseSseFrame<{ outcome: string }>(
      'data: {"event":"result","ok":true,"result":{"outcome":"QUALIFIED_PLACEMENT"}}'
    );
    expect(event?.ok).toBe(true);
    expect(event?.result?.outcome).toBe('QUALIFIED_PLACEMENT');
  });

  it('ignores comments and non-data lines', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: progress')).toBeNull();
  });

  it('treats [DONE] as an end frame', () => {
    expect(parseSseFrame('data: [DONE]')).toEqual({ event: 'end' });
  });

  it('rejects malformed JSON so a dropped answer frame cannot look successful', () => {
    expect(() => parseSseFrame('data: {oops')).toThrow(/could not be read/);
  });
});

describe('streaming evaluate', () => {
  function sseResponse(frames: string[]): Response {
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
  }

  it('reports progress events and returns the streamed result', async () => {
    const { client, invocations } = makeClient((_action, _payload, stream) => {
      expect(stream).toBe(true);
      return sseResponse([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({ event: 'progress', message: 'Retrieving regional prices' }),
        JSON.stringify({ event: 'progress', message: 'Running the solver' }),
        JSON.stringify({ event: 'result', ok: true, result: burstyResult }),
        JSON.stringify({ event: 'end' }),
      ]);
    });

    const seen: string[] = [];
    const result = await client.evaluateStream({} as never, (event) => {
      if (event.message) seen.push(event.message);
    });

    expect(invocations[0].stream).toBe(true);
    expect(seen).toEqual(['Retrieving regional prices', 'Running the solver']);
    expect(result.outcome).toBe('QUALIFIED_PLACEMENT');
  });

  it('turns an error frame into a handled ApiError with its detail', async () => {
    const { client } = makeClient(() =>
      sseResponse([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({
          event: 'error',
          error: 'invalid_request',
          detail: 'workload.horizonHours is required',
        }),
      ])
    );
    const error = (await client
      .evaluateStream({} as never, () => {})
      .catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe('invalid_request');
    expect(error.detail).toBe('workload.horizonHours is required');
    expect(error.handled).toBe(true);
  });

  it('fails rather than returning a partial decision when the stream ends early', async () => {
    const { client } = makeClient(() =>
      sseResponse([
        JSON.stringify({ event: 'start' }),
        JSON.stringify({ event: 'progress', message: 'Retrieving prices' }),
        JSON.stringify({ event: 'end' }),
      ])
    );
    const error = (await client
      .evaluateStream({} as never, () => {})
      .catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe('incomplete_stream');
  });

  it('classifies a 424 on the streaming path the same way', async () => {
    const { client } = makeClient(() => agentCore424());
    const error = (await client
      .evaluateStream({} as never, () => {})
      .catch((c: unknown) => c)) as ApiError;
    expect(error).toBeInstanceOf(CoordinatorFailureError);
  });
});
