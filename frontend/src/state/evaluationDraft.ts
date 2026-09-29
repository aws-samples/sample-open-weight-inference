export interface EvaluationExample { input: string; expected: string; actual: string | null; error?: string }
export interface ScoredExample extends EvaluationExample { example: number; passed: boolean; reason: string }
export interface ScoreReport {
  evaluationId: string;
  scorerVersion: string;
  provenance: 'SUPPLIED_OUTPUTS';
  modelInvoked: false;
  latencyMeasured: false;
  total: number;
  passed: number;
  failed: number;
  matchPercent: string;
  targetPercent: string;
  sampleTargetMet: boolean;
  confidence95Percent: [number, number];
  results: ScoredExample[];
  note: string;
}
export interface EvaluationDraft {
  rows: EvaluationExample[];
  target: string;
  caseSensitive: boolean;
  report: ScoreReport | null;
  reportKey: string | null;
}
export const EMPTY_EVALUATION: EvaluationDraft = {
  rows: [{ input: '', expected: '', actual: '' }],
  target: '95', caseSensitive: true, report: null, reportKey: null,
};
