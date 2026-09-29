import { describe, expect, it } from 'vitest';
import { ConfigError, loadRuntimeConfig } from '../config';
import unconfiguredExample from '../../../public/config.example.json';

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

const VALID = {
  agentRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example_runtime',
  region: 'us-east-1',
  releaseId: '20260912T101500',
  userPoolId: 'us-east-1_Example',
  userPoolClientId: 'exampleclientid',
};

describe('loadRuntimeConfig', () => {
  it('reads the AgentCore runtime and Cognito pool from /config.json', async () => {
    const config = await loadRuntimeConfig(jsonFetch(VALID));
    expect(config).toEqual(VALID);
  });

  it('treats a lingering apiBaseUrl as a configuration bug', async () => {
    const error = await loadRuntimeConfig(
      jsonFetch({ ...VALID, apiBaseUrl: 'https://old.example.test' })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).detail).toContain('apiBaseUrl');
    expect((error as ConfigError).detail).toContain('retired API Gateway');
  });

  it('names every missing required field rather than guessing a default', async () => {
    const error = await loadRuntimeConfig(
      jsonFetch({ region: 'us-east-1' })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    const detail = (error as ConfigError).detail;
    expect(detail).toContain('agentRuntimeArn');
    expect(detail).toContain('userPoolId');
    expect(detail).toContain('userPoolClientId');
  });

  it('fails when /config.json is absent instead of falling back to localhost', async () => {
    const error = await loadRuntimeConfig(jsonFetch({}, 404)).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).detail).toContain('404');
  });

  it('fails closed for the public example instead of choosing a developer account', async () => {
    const error = await loadRuntimeConfig(jsonFetch(unconfiguredExample)).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).detail).toContain('agentRuntimeArn');
    expect((error as ConfigError).detail).toContain('userPoolId');
    expect((error as ConfigError).detail).toContain('userPoolClientId');
  });

  it('fails on unparsable JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
    await expect(loadRuntimeConfig(fetchImpl)).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  it('treats releaseId as optional', async () => {
    const { releaseId: _omitted, ...withoutRelease } = VALID;
    const config = await loadRuntimeConfig(jsonFetch(withoutRelease));
    expect(config.releaseId).toBeNull();
    expect(config.agentRuntimeArn).toBe(VALID.agentRuntimeArn);
  });
});
