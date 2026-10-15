import {
  BENCHMARK_VERSION, type BenchmarkCost, type BenchmarkRun, type BenchmarkSample,
} from '../api/benchmarks';
import type { DeploymentView, TestInvocationResponse } from '../api/types';
import type { EvaluationExample } from './evaluationDraft';

export async function digestJson(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, val]) => [key, canonical(val)]),
    );
    return item;
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface TrialBenchmarkOptions {
  deployment: DeploymentView;
  examples: EvaluationExample[];
  caseSensitive: boolean;
  repetitions: number;
  concurrency: number;
  maxOutputTokens: number;
  maximumSeconds: number;
  cost: BenchmarkCost;
  invoke: (text: string, maxTokens: number) => Promise<TestInvocationResponse>;
  grade: (rows: EvaluationExample[], caseSensitive: boolean) => Promise<boolean[]>;
  stopped: () => boolean;
  progress: (report: BenchmarkRun) => void;
}

/** Uses the existing project-scoped trial facade and its atomic request allowance. */
export async function runTrialBenchmark(options: TrialBenchmarkOptions): Promise<BenchmarkRun> {
  const { deployment, examples, repetitions, concurrency, maxOutputTokens, maximumSeconds } = options;
  if (examples.length < 1 || examples.length > 20 || examples.some((row) =>
    !row.input.trim() || !row.expected.trim() || row.input.length > 8000 || row.expected.length > 8000)) {
    throw new Error('Use 1–20 text examples, each with a task and expected answer of at most 8,000 characters.');
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256 ||
      !Number.isInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 600 ||
      examples.length * repetitions > 40) {
    throw new Error('Use at most 40 requests, 1–4 concurrent requests, 1–256 output tokens, and a 1–600 second deadline.');
  }
  if (!deployment.modelRef || !deployment.modelRevision || !deployment.region ||
      !deployment.instanceType || !deployment.recipeId || deployment.resourcesExpired ||
      !['EXPERIMENTAL', 'READY'].includes(deployment.state)) {
    throw new Error('Select a ready trial with its exact model, revision and serving configuration.');
  }
  // Speech output needs listening/quality review, not an exact text-answer grader.
  if (deployment.recipeId.includes('magpie') || deployment.recipeId.includes('speech')) {
    throw new Error('Speech trials require audio-quality review. This runner checks exact text answers.');
  }
  const tasks = examples.map((row, index) => ({
    id: `task-${index + 1}`, input: row.input, expected: row.expected,
  }));
  const datasetDigest = await digestJson([...tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rubricDigest = await digestJson({ acceptance: 'exact-answer/1', caseSensitive: options.caseSensitive });
  const scheduled = Array.from({ length: repetitions }, (_, repeat) =>
    tasks.map((task) => ({ task, repetition: repeat + 1 }))).flat();
  const samples: BenchmarkSample[] = scheduled.map(({ task, repetition }) => ({
    taskId: task.id, repetition, status: 'not_run', accepted: false,
    elapsedMs: null, ttftMs: null, usage: null,
  }));
  const report: BenchmarkRun = {
    schemaVersion: BENCHMARK_VERSION, runId: `bench-${crypto.randomUUID()}`, createdAt: new Date().toISOString(),
    configuration: {
      label: `${deployment.modelRef} / ${deployment.instanceType}`.slice(0, 200), model: deployment.modelRef,
      revision: deployment.modelRevision, runtime: deployment.recipeId,
      harness: 'eddie-trial-browser/1', region: deployment.region, hardware: deployment.instanceType,
      provider: 'sagemaker',
    },
    workload: { name: 'Project exact-answer tests', datasetDigest, rubricDigest, taskIds: tasks.map((task) => task.id) },
    protocol: {
      repetitions, concurrency, maxOutputTokens, temperature: 0, warmupRequests: 0,
      measurement: 'client_end_to_end', loadModel: 'closed_loop', acceptance: 'exact-answer/1',
    },
    durationSeconds: .001, state: 'stopped', samples, cost: options.cost,
  };
  const started = performance.now();
  let finished: number | undefined;
  const answers = new Map<number, EvaluationExample>();
  const snapshot = (): BenchmarkRun => ({
    ...report, durationSeconds: Math.max(.001, ((finished ?? performance.now()) - started) / 1000),
    samples: samples.map((sample) => ({ ...sample })),
  });
  let next = 0;
  async function worker() {
    while (!options.stopped() && (performance.now() - started) / 1000 < maximumSeconds && next < scheduled.length) {
      const index = next++;
      const { task, repetition } = scheduled[index];
      const before = performance.now();
      try {
        const result = await options.invoke(task.input, maxOutputTokens);
        const elapsedMs = Math.max(.001, performance.now() - before);
        if (typeof result.output !== 'string' ||
            result.receipt.model !== deployment.modelRef || result.receipt.revision !== deployment.modelRevision ||
            result.receipt.jobId !== deployment.jobId) {
          throw new Error('The response did not match the selected text trial.');
        }
        // Grade with the same backend scorer as the CLI, including Unicode
        // casefold and whitespace rules. Do not persist raw responses in reports.
        answers.set(index, { input: task.input, expected: task.expected, actual: result.output });
        samples[index] = {
          taskId: task.id, repetition, status: 'ok', accepted: null,
          elapsedMs, ttftMs: null, usage: result.receipt.usage ?? null,
          ...(result.receipt.outputSha256 ? { outputDigest: result.receipt.outputSha256 } : {}),
        };
      } catch {
        samples[index] = {
          taskId: task.id, repetition, status: 'error', accepted: false,
          elapsedMs: Math.max(.001, performance.now() - before), ttftMs: null,
          usage: null, errorCode: 'request_failed',
        };
      }
      options.progress(snapshot());
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  finished = performance.now();
  if (answers.size) {
    try {
      const indices = [...answers.keys()].sort((a, b) => a - b);
      const grades = await options.grade(indices.map((index) => answers.get(index)!), options.caseSensitive);
      if (grades.length !== indices.length || grades.some((grade) => typeof grade !== 'boolean')) {
        throw new Error('The scorer did not return one decision per answer.');
      }
      indices.forEach((index, position) => { samples[index].accepted = grades[position]; });
    } catch {
      // Keep measured requests when grading fails. Null is unknown, never a pass.
    }
    answers.clear();
  }
  report.state = samples.every((sample) => sample.status !== 'not_run') ? 'completed' : 'stopped';
  return snapshot();
}
