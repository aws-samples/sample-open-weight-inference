import { webcrypto, createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { digestJson, runTrialBenchmark, type TrialBenchmarkOptions } from '../trialBenchmark';
import type { DeploymentView, TestInvocationResponse } from '../../api/types';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));

const deployment = {
  jobId: 'trial-test', planId: 'plan-test', state: 'READY', modelRef: 'example/model',
  modelRevision: 'a'.repeat(64), instanceType: 'ml.g5.2xlarge', recipeId: 'qwen-trial-v1',
  region: 'us-east-1', resourcesExpired: false,
} as DeploymentView;
function response(output = 'A'): TestInvocationResponse {
  return { output, receipt: { model: deployment.modelRef, revision: deployment.modelRevision,
    jobId: deployment.jobId, outputSha256: 'b'.repeat(64) } } as TestInvocationResponse;
}
function options(overrides: Partial<TrialBenchmarkOptions> = {}): TrialBenchmarkOptions {
  return {
    deployment, examples: [{ input: 'Return A.', expected: 'A', actual: null }],
    caseSensitive: true, repetitions: 2, concurrency: 1, maxOutputTokens: 32, maximumSeconds: 10,
    cost: { basis: 'unknown', scope: 'benchmark_window' },
    invoke: vi.fn(async () => response()), grade: vi.fn(async (rows) => rows.map(() => true)),
    stopped: () => false, progress: vi.fn(), ...overrides,
  };
}

describe('bounded browser benchmark', () => {
  it('uses canonical hashing compatible with the Python runner', async () => {
    const expected = createHash('sha256').update('{"a":"Straße","b":[{"a":1,"z":2}]}').digest('hex');
    expect(await digestJson({ b: [{ z: 2, a: 1 }], a: 'Straße' })).toBe(expected);
  });

  it('invokes the existing facade, grades on the backend, and exports no raw responses', async () => {
    const settings = options({ examples: [{ input: 'Return the word.', expected: 'STRASSE', actual: null }],
      caseSensitive: false, invoke: vi.fn(async () => response(' Straße ')) });
    const report = await runTrialBenchmark(settings);
    expect(settings.invoke).toHaveBeenCalledTimes(2);
    expect(settings.grade).toHaveBeenCalledWith([
      { input: 'Return the word.', expected: 'STRASSE', actual: ' Straße ' },
      { input: 'Return the word.', expected: 'STRASSE', actual: ' Straße ' },
    ], false);
    expect(report.samples.every((sample) => sample.accepted)).toBe(true);
    expect(report.state).toBe('completed');
    expect(report.samples.every((sample) => sample.ttftMs === null && sample.usage === null)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/Return the word|Straße|STRASSE/);
  });

  it('keeps partial observations and unstarted tasks when stopped', async () => {
    let stop = false;
    const report = await runTrialBenchmark(options({
      repetitions: 4, stopped: () => stop,
      invoke: vi.fn(async () => { stop = true; return response(); }),
    }));
    expect(report.samples).toHaveLength(4);
    expect(report.samples.filter((sample) => sample.status === 'not_run')).toHaveLength(3);
    expect(report.state).toBe('stopped');
  });

  it('caps in-flight requests and retains errors without provider details', async () => {
    let inFlight = 0, peak = 0;
    const report = await runTrialBenchmark(options({
      repetitions: 5, concurrency: 2,
      invoke: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        throw new Error('private provider error');
      },
    }));
    expect(peak).toBe(2);
    expect(report.samples.every((sample) => sample.status === 'error' && !sample.accepted)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private provider');
  });

  it('does not lose completed observations if the grading service fails', async () => {
    const report = await runTrialBenchmark(options({ grade: async () => { throw new Error('offline'); } }));
    expect(report.samples.every((sample) => sample.status === 'ok' && sample.accepted === null)).toBe(true);
    expect(report.state).toBe('completed');
  });

  it('rejects mismatched deployment receipts', async () => {
    const bad = response();
    bad.receipt.jobId = 'different-project';
    const settings = options({ invoke: async () => bad });
    const report = await runTrialBenchmark(settings);
    expect(report.samples.every((sample) => sample.status === 'error')).toBe(true);
    expect(settings.grade).not.toHaveBeenCalled();
  });

  it.each([
    { concurrency: 5 }, { repetitions: 6 }, { maxOutputTokens: 257 },
    { maximumSeconds: 601 }, { examples: [] },
    { deployment: { ...deployment, resourcesExpired: true } },
    { deployment: { ...deployment, recipeId: 'magpie-speech-v1' } },
  ])('rejects unsupported settings before invoking: %j', async (patch) => {
    const settings = options(patch);
    await expect(runTrialBenchmark(settings)).rejects.toThrow();
    expect(settings.invoke).not.toHaveBeenCalled();
  });
});
