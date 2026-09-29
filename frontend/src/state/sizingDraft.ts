import type { SizingReport, SizingSettings } from '../api/sizing';
import type { EvaluateRequest } from '../api/types';
import { projectFingerprint } from './persistence';

export const DEFAULT_SIZING: SizingSettings = {
  contextTokens: '4096', batchSize: '1', kvDtype: 'BF16',
  overheadPercent: '15', utilizationPercent: '70', minimumReplicas: '1',
  peakFactor: '1', hardwareId: 'auto', trafficMode: 'requests',
  totalTokens: '', outputSharePercent: '', prefillSpeedup: '',
  hourlyRateUsd: '', rateDescription: '', workloadKind: 'general',
  servingMode: 'unsure', computePreference: 'auto', cpuRuntime: 'unknown',
  jobConcurrency: '', deadlineSeconds: '', cpuInstance: 'c7i.8xlarge',
  cpuPeakGiB: '', cpuJobSeconds: '', cpuBillableSeconds: '', cpuRunReference: '',
};
export interface SizingDraft { settings: SizingSettings; report: SizingReport | null }
export const EMPTY_SIZING: SizingDraft = { settings: DEFAULT_SIZING, report: null };

/** Ignore unrelated project prose; preserve every input used by the calculator. */
export function sizingKey(request: EvaluateRequest, settings: SizingSettings): string {
  const object = request as unknown as Record<string, unknown>;
  const part = (name: string, keys: string[]) => {
    const record = (object[name] ?? {}) as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => {
      const value = record[key];
      return [key, value === undefined || value === '' ? null : value];
    }));
  };
  return projectFingerprint({
    model: part('model', ['name', 'architecture', 'modality', 'weightsGb', 'weightsExportable',
      'hfRepo', 'hfCommit', 'sourceKind', 'artifactDigest']),
    workload: part('workload', ['horizonHours', 'requests', 'inputTokensPerRequest', 'outputTokensPerRequest', 'concurrency']),
    constraints: part('constraints', ['permittedRegions']),
    qualification: part('qualification', ['servingPattern']),
    settings,
  });
}
