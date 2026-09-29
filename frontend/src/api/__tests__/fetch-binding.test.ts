import { describe, expect, it } from 'vitest';
import { AgentCoreClient } from '../agentcore';
import type { RuntimeConfig } from '../types';

const config: RuntimeConfig = {
  agentRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/eddie_test-abc',
  region: 'us-east-1',
  releaseId: 'test',
  userPoolId: 'us-east-1_test',
  userPoolClientId: 'client',
};

describe('default transport binding', () => {
  /**
   * Regression: the client stored the bare `fetch` reference and invoked it as
   * `this.fetchImpl(...)`, so `this` became the client instance. Browsers reject
   * that with "Failed to execute 'fetch' on 'Window': Illegal invocation", and
   * every action failed with no network request at all. The jsdom suite missed it
   * because those tests inject a fake transport.
   */
  it('calls the global fetch with the global as receiver', async () => {
    const seen: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      seen.push(this);
      return Promise.resolve(
        new Response(JSON.stringify({ action: 'health', ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    } as unknown as typeof fetch;

    try {
      const client = new AgentCoreClient({
        config,
        getAccessToken: async () => 'token',
      });
      await client.health();
    } finally {
      globalThis.fetch = original;
    }

    expect(seen).toHaveLength(1);
    // Bound to the global object, never to the client instance.
    expect(seen[0]).not.toBeInstanceOf(AgentCoreClient);
    expect(seen[0] === globalThis || seen[0] === undefined).toBe(true);
  });

  it('does not throw when constructed without an injected transport', () => {
    expect(
      () => new AgentCoreClient({ config, getAccessToken: async () => 'token' })
    ).not.toThrow();
  });
});
