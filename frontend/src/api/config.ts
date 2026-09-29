import type { RuntimeConfig } from './types';

/** Raised when `/config.json` is missing or does not identify the runtime. */
export class ConfigError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'ConfigError';
    this.detail = detail;
  }
}

function readString(
  body: Record<string, unknown>,
  key: string
): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Load runtime configuration from `/config.json`.
 *
 * Unlike the previous API Gateway build there is no usable local default: the
 * AgentCore runtime ARN and the Cognito pool are deployment facts, so a
 * missing or incomplete config is a hard, explicit failure rather than a
 * silent fallback to a URL that cannot work.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch
): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchImpl('/config.json', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (cause) {
    throw new ConfigError(
      `Could not fetch /config.json. ${
        cause instanceof Error ? cause.message : 'Unknown network failure.'
      }`
    );
  }

  if (!response.ok) {
    throw new ConfigError(
      `/config.json returned HTTP ${response.status}. The deployment did not publish a runtime configuration.`
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ConfigError('/config.json was not valid JSON.');
  }

  if (readString(body, 'apiBaseUrl')) {
    // Surfaced rather than ignored: a stale config would silently point the
    // browser at an API Gateway that no longer exists.
    throw new ConfigError(
      '/config.json contains `apiBaseUrl`, which belongs to the retired API Gateway control plane. Redeploy a configuration with `agentRuntimeArn`, `userPoolId` and `userPoolClientId`.'
    );
  }

  const agentRuntimeArn = readString(body, 'agentRuntimeArn');
  const region = readString(body, 'region');
  const userPoolId = readString(body, 'userPoolId');
  const userPoolClientId = readString(body, 'userPoolClientId');

  const missing = [
    ['agentRuntimeArn', agentRuntimeArn],
    ['region', region],
    ['userPoolId', userPoolId],
    ['userPoolClientId', userPoolClientId],
  ]
    .filter(([, value]) => value === null)
    .map(([key]) => key as string);

  if (missing.length > 0) {
    throw new ConfigError(
      `/config.json is missing required field${
        missing.length === 1 ? '' : 's'
      }: ${missing.join(', ')}.`
    );
  }

  return {
    agentRuntimeArn: agentRuntimeArn as string,
    region: region as string,
    releaseId: readString(body, 'releaseId'),
    userPoolId: userPoolId as string,
    userPoolClientId: userPoolClientId as string,
  };
}
