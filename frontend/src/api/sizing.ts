import type { EvaluateRequest } from './types';

export type FactBasis = 'REGISTRY' | 'PUBLISHED' | 'CALCULATED' | 'ASSUMED' | 'MODELED' | 'DECLARED' | 'SUPPLIED' | 'NOT_AVAILABLE';
export interface SizingMetric {
  id: string;
  label: string;
  value: string | null;
  unit: string;
  basis: FactBasis;
  explanation: string;
  formula?: string | null;
  sourceUrl?: string | null;
}
export interface SizingSettings {
  contextTokens: string; batchSize: string; kvDtype: string;
  overheadPercent: string; utilizationPercent: string; minimumReplicas: string;
  peakFactor: string; hardwareId: string; trafficMode: string;
  totalTokens: string; outputSharePercent: string; prefillSpeedup: string;
  hourlyRateUsd: string; rateDescription: string; workloadKind: string;
  servingMode: string; computePreference: string; cpuRuntime: string;
  jobConcurrency: string; deadlineSeconds: string; cpuInstance: string;
  cpuPeakGiB: string; cpuJobSeconds: string; cpuBillableSeconds: string; cpuRunReference: string;
}
export interface CpuService { id: string; name: string; fit: string; detail: string; sourceUrl: string }
export interface PodcastExample {
  id: string; title: string; basis: 'RECORDED_EXAMPLE'; recordedAt: string;
  description: string; model: string; modelSource: string; instance: string;
  region: string; vcpus: number; memoryGiB: number; device: string; dtype: string;
  threads: number; interopThreads: number; audioSeconds: number; generationSeconds: number;
  startupSeconds: number; assetLoadSeconds: number; endToEndSeconds: number;
  realTimeFactor: number; peakProcessMiB: number;
  versions: Record<string, string>; artifactHashes: Record<string, string>; limitations: string[];
}
export interface SizingReport {
  schemaVersion: 1; scope: 'PLANNING_ONLY'; performanceMeasured: false;
  reportHash: string; retrievedAt: string; region: string; request: EvaluateRequest;
  settings: SizingSettings; compute: 'cpu' | 'gpu' | 'api';
  model: { name?: string | null; repo?: string | null; revision?: string | null };
  groups: { id: string; title: string; metrics: SizingMetric[] }[];
  memorySegments: { id: string; label: string; gib: string | null }[];
  hardware: { instance: string; accelerator: string; gpus: number; memory_gib: number; interconnect: string } | null;
  hardwareChoices: { instance: string; accelerator: string; gpus: number; memory_gib: number }[];
  cpuChoices: { instance: string; vcpus: number; memoryGiB: number; architecture: string }[];
  memoryFit: boolean | null; limitations: string[]; selectionReason: string;
  pricing?: { amount: string; region: string; sku?: string; effectiveDate?: string; source?: string } | null;
  guidance: {
    priority: string; title: string; reason: string;
    checks: { label: string; value: string; detail: string }[];
    cpuServices: CpuService[]; sizeGuidance: string[]; graviton: string;
    example: PodcastExample; qualifiesDeployment: false;
  };
  benchmark: { title: string; metrics: string[]; levers: string[]; record: string[]; sourceUrl: string; note: string };
}
