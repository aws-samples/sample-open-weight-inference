export interface PublishedBenchmarkRow {
  id: string; model: string; modelId: string; openWeights: boolean | null;
  harness: string; harnessVersion: string; reasoningEffort: string; date: string;
  sourceReviewFlag: boolean | null; tasks: number; resolved: number | null;
  outcomesConsistent: boolean; costsConsistent: boolean;
  resolvedPercent: number | null; publishedResolvedPercent: number | null;
  resolutionInterval95: [number, number] | null;
  costPerTaskUsd: string | null; costPerResolvedUsd: string | null; totalCostUsd: string | null;
  taskSetDigest: string | null; eligible: boolean; reasons: string[]; frontier: boolean;
}
export interface PublicBenchmarks {
  state: 'READY' | 'UNAVAILABLE'; source: string; benchmark: string; detail?: string;
  methodology?: string; retrievedAt?: string; sourceSha256?: string; cacheSeconds?: number;
  provenance?: 'PUBLISHED_RESULTS'; deploymentQualified?: false;
  cohorts?: { id: string; label: string; records: number; comparable: number; latestDate: string }[];
  selectedCohort?: string; malformedRecords?: number;
  rows?: PublishedBenchmarkRow[]; notes?: string[];
  paired?: {
    baseline: string; contender: string; tasks: number; contenderOnly: number;
    baselineOnly: number; bothResolved: number; neitherResolved: number; differencePercentagePoints: number;
  } | null;
}
