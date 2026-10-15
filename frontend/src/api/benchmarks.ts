export const BENCHMARK_VERSION = 'eddie-benchmark/1' as const;
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  accounting: 'input_includes_cache' | 'cache_is_additional' | 'unknown';
}
export interface BenchmarkSample {
  taskId: string; repetition: number;
  status: 'ok' | 'error' | 'not_run';
  accepted: boolean | null;
  elapsedMs: number | null;
  ttftMs?: number | null;
  usage?: TokenUsage | null;
  outputDigest?: string;
  errorCode?: string;
}
export interface BenchmarkConfiguration {
  label: string; model: string; revision: string; runtime: string; harness: string;
  region: string; hardware: string;
  provider: 'bedrock' | 'sagemaker' | 'self_hosted' | 'external';
}
export interface BenchmarkCost {
  basis: 'unknown' | 'tokens' | 'capacity'; scope: 'benchmark_window';
  currency?: 'USD'; hourlyUsd?: string;
  perMillion?: Record<string, string | null>;
  source?: string; rateId?: string; retrievedAt?: string;
}
export interface BenchmarkRun {
  schemaVersion: typeof BENCHMARK_VERSION; runId: string; createdAt: string;
  configuration: BenchmarkConfiguration;
  workload: { name: string; datasetDigest: string; rubricDigest: string; taskIds: string[] };
  protocol: {
    repetitions: number; concurrency: number; maxOutputTokens: number; temperature: number;
    warmupRequests: number; measurement: 'client_end_to_end'; loadModel: 'closed_loop'; acceptance: string;
  };
  state: 'completed' | 'stopped'; durationSeconds: number;
  samples: BenchmarkSample[]; cost: BenchmarkCost;
}
export interface BenchmarkSettings {
  minimumAcceptancePercent: string; maximumP95Ms: string;
  maximumErrorPercent: string; minimumTasks: string;
}
export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  minimumAcceptancePercent: '95', maximumP95Ms: '', maximumErrorPercent: '0', minimumTasks: '1',
};
export interface BenchmarkRow {
  runId: string; configuration: BenchmarkConfiguration; createdAt: string; runDigest: string;
  planned: number; attempted: number; errors: number; notRun: number; ungraded: number;
  accepted: number; useful: number; acceptancePercent: number; errorPercent: number | null;
  p50Ms: number | null; p95Ms: number | null; p95TtftMs: number | null;
  ttftSamples: number; latencySamples: number; durationSeconds: number;
  usefulRequestsPerMinute: number; costUsd: string | null; costPerUsefulUsd: string | null;
  costEvidence: BenchmarkCost; tokens: Record<string, number> | null;
  eligible: boolean; reasons: string[]; frontier: boolean; comparisonDifferences: string[];
  taskOutcomes: { taskId: string; accepted: number; attempts: number; allRepeatsAccepted: boolean }[];
}
export interface BenchmarkComparison {
  schemaVersion: typeof BENCHMARK_VERSION; comparisonId: string; createdAt: string;
  provenance: 'SUPPLIED_MEASUREMENTS'; deploymentQualified: false;
  workload: BenchmarkRun['workload'];
  settings: { minimumAcceptancePercent: number; maximumP95Ms: number | null; maximumErrorPercent: number; minimumTasks: number };
  rows: BenchmarkRow[]; lowestCostEligibleRunIds: string[]; notes: string[];
}
export function comparisonSettings(settings: BenchmarkSettings) {
  const required = ['minimumAcceptancePercent', 'maximumErrorPercent', 'minimumTasks'] as const;
  if (required.some((key) => settings[key].trim() === '' || !Number.isFinite(Number(settings[key])))) {
    throw new Error('Enter acceptance, error and task-count targets.');
  }
  if (settings.maximumP95Ms.trim() && !Number.isFinite(Number(settings.maximumP95Ms))) {
    throw new Error('Enter a numeric response-time target or leave it empty.');
  }
  return {
    minimumAcceptancePercent: Number(settings.minimumAcceptancePercent),
    maximumP95Ms: settings.maximumP95Ms.trim() ? Number(settings.maximumP95Ms) : null,
    maximumErrorPercent: Number(settings.maximumErrorPercent), minimumTasks: Number(settings.minimumTasks),
  };
}
