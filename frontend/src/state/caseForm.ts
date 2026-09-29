import type { EvaluateRequest, LatencyEvidenceInput } from '../api/types';

import { QUALIFICATION_FIELDS, qualificationPayload } from './qualification';

/**
 * One latency-evidence record, bound to the candidate it was observed against.
 *
 * Evidence is only ever reused for an identical candidate key, so the
 * candidate id is part of the record rather than a single global field.
 */
export interface LatencyEvidenceEntry {
  candidateId: string;
  p50Ms: string;
  p99Ms: string;
  coldStartMs: string;
  sampleCount: string;
  violationRateUpperBound: string;
}

/**
 * Form state for the case workspace. Numeric fields are held as strings so
 * the user's exact input reaches the backend without a float round-trip, and
 * so a blank field stays blank rather than becoming zero.
 */
export interface CaseFormState {
  /** Training values are readable only for legacy projects that need a scope correction. */
  workloadType?: 'inference' | 'training' | 'both' | 'unsure';
  modelStage?: 'base' | 'fine-tuned' | 'unsure';
  selectionStage?: 'exploring' | 'committed' | 'unsure';
  servingPattern?: 'interactive' | 'batch' | 'both' | 'unsure';
  goLiveDate?: string;
  platformPreference?: 'new' | 'sagemaker' | 'eks-ec2' | 'unsure';
  growthNotes?: string;
  availabilityNeeds?: string;
  complianceNeeds?: string;
  weightCustody?: 'aws-managed' | 'own-account' | 'unsure';
  currentSpendUsd?: string;
  benchmarkedAlternatives?: string;
  requestsPerMinute?: string;
  cpuRuntime?: 'compatible' | 'gpu-required' | 'unsure';
  completionDeadlineSeconds?: string;
  cpuAdditionalCostUsd?: string;
  batchAdditionalCostUsd?: string;
  cpuCostNotes?: string;
  caseId: string;
  // Model
  modelName: string;
  architecture: string;
  modality: string;
  totalParamsB: string;
  contextTokens: string;
  precision: string;
  weightsGb: string;
  weightsExportable: boolean;
  licenseId: string;
  hfRepo: string;
  hfCommit?: string;
  artifactDigest?: string;
  /** Optional planning details. Missing remains unknown in older saved cases. */
  modelIntent?: 'choose' | 'specific';
  sourceKind?: 'huggingface' | 'company' | 'api' | 'bedrock' | 'checkpoint';
  inferenceProfileId?: string;
  permittedProcessingRegions?: string;
  sourceLocation?: string;
  successCriteria?: string;
  trafficPattern?: 'always' | 'occasional' | 'scheduled' | 'unknown';
  requests?: string;
  inputTokensPerRequest?: string;
  outputTokensPerRequest?: string;
  // Workload
  horizonHours: string;
  billableCopyHours: string;
  dedicatedInstanceHours: string;
  scheduled: boolean;
  concurrency: string;
  description: string;
  /**
   * When false, no SLO is sent at all. A case with no latency objective is a
   * legitimate case: candidates then qualify on the remaining gates and rank
   * purely by comparable cost.
   */
  provideSlo: boolean;
  sloMetric: string;
  sloThresholdMs: string;
  sloPercentile: string;
  sloIncludeCold: boolean;
  sloErrorBudgetFraction: string;
  // Constraints
  permittedRegions: string;
  budgetUsd: string;
  requireHeldCapacity: boolean;
  maxOpsBurden: string;
  // Stipulation
  assumeChecksCleared: boolean;
  // Supplied latency evidence, per candidate
  provideLatencyEvidence: boolean;
  latencyEvidence: LatencyEvidenceEntry[];
}

/**
 * Must match `Modality` in backend/solver/models.py exactly.
 *
 * This previously offered IMAGE, AUDIO and MULTIMODAL, none of which the backend
 * accepts: choosing one made every evaluation fail with a validation error. The
 * labels are for humans; the values are the contract.
 */
export const MODALITY_OPTIONS = [
  { value: 'TEXT', label: 'Text' },
  { value: 'VISION_LANGUAGE', label: 'Vision-language (text + image in)' },
  { value: 'ASR', label: 'Speech to text (ASR)' },
  { value: 'TTS', label: 'Text to speech (TTS)' },
  { value: 'SPEECH_TO_SPEECH', label: 'Speech to speech' },
  { value: 'EMBEDDING', label: 'Embedding' },
] as const;
export const PRECISION_OPTIONS = ['BF16', 'FP16', 'FP8', 'INT8', 'INT4'];
/**
 * Metrics the solver evaluates. An unrecognised metric is reported back as an
 * unsupported input rather than quietly rewritten to p99 latency.
 */
/**
 * The percentile a metric's name carries, or null when it carries none.
 *
 * Must match METRIC_IMPLIED_PERCENTILE in backend/solver/solve.py. A first-token or
 * first-audio objective has no inherent percentile, so none is invented for it.
 */
export function metricImpliedPercentile(metric: string): string | null {
  switch (metric) {
    case 'p50_latency_ms':
      return '50';
    case 'p95_latency_ms':
      return '95';
    case 'p99_latency_ms':
      return '99';
    default:
      return null;
  }
}

export const SLO_METRIC_OPTIONS = [
  'p99_latency_ms',
  'p95_latency_ms',
  'p50_latency_ms',
  'ttft_ms',
  'ttfa_ms',
  'conversation_response_ms',
];
/**
 * Ops-burden ceiling values.
 *
 * These are looked up by name against the backend `OpsBurden` enum
 * (`OpsBurden[value]`), so a value that is not an exact enum member name is
 * rejected as `invalid_request`. The labels are the human rubric wording.
 */
export const OPS_BURDEN_OPTIONS = [
  { value: 'SERVICE_API', label: 'Service or API operation' },
  {
    value: 'MANAGED_CONTAINER_ENDPOINT',
    label: 'Managed container endpoint operation',
  },
  { value: 'SELF_MANAGED_HOSTS', label: 'Self-managed hosts' },
  {
    value: 'CLUSTER_DISTRIBUTED_RUNTIME',
    label: 'Cluster or distributed-runtime operation',
  },
] as const;

/**
 * Candidate ids the solver enumerates, offered as evidence targets.
 *
 * These must match `enumerate_candidates` in backend/catalog/candidates.py exactly.
 * Supplied latency evidence is keyed by candidate id, so a mismatched id is silently
 * ignored and the candidate stays unresolved with no visible explanation.
 */
export const KNOWN_CANDIDATE_IDS = [
  'cmi-scale-to-zero',
  'cmi-prewarmed',
  'sagemaker-ml.g5.2xlarge',
  'sagemaker-ml.g5.12xlarge',
  'sagemaker-ml.g6.2xlarge',
];

export function emptyLatencyEntry(candidateId = ''): LatencyEvidenceEntry {
  return {
    candidateId,
    p50Ms: '',
    p99Ms: '',
    coldStartMs: '',
    sampleCount: '',
    violationRateUpperBound: '',
  };
}

/**
 * A starting point for the model block.
 *
 * Every figure here is a *declared* starting value the user can correct, not a
 * measurement. Where a value does not exist for an entry — a vendor API has no
 * parameter count or weights size — the field is left blank rather than
 * guessed, because a wrong `weightsGb` silently changes which instances look
 * feasible.
 */
export interface ModelPreset {
  id: string;
  label: string;
  /** `vendor-api` marks an API-only path with no exportable artifact. */
  apiOnly: boolean;
  note: string | null;
  patch: Pick<
    CaseFormState,
    | 'modelName'
    | 'architecture'
    | 'modality'
    | 'totalParamsB'
    | 'contextTokens'
    | 'precision'
    | 'weightsGb'
    | 'weightsExportable'
    | 'licenseId'
    | 'hfRepo'
  >;
}

function openWeights(
  id: string,
  label: string,
  architecture: string,
  modality: string,
  totalParamsB: string,
  contextTokens: string,
  weightsGb: string,
  licenseId: string,
  hfRepo: string
): ModelPreset {
  return {
    id,
    label,
    apiOnly: false,
    note: null,
    patch: {
      modelName: label,
      architecture,
      modality,
      totalParamsB,
      contextTokens,
      precision: 'BF16',
      weightsGb,
      weightsExportable: true,
      licenseId,
      hfRepo,
    },
  };
}

/**
 * An API-only provider. No artifact is exportable, so every self-hosting
 * target is correctly infeasible and the self-hosting fields are left blank.
 */
function vendorApi(
  id: string,
  label: string,
  modality: string,
  note: string
): ModelPreset {
  return {
    id,
    label,
    apiOnly: true,
    note,
    patch: {
      modelName: label,
      architecture: VENDOR_API_ARCHITECTURE,
      modality,
      totalParamsB: '',
      contextTokens: '',
      precision: 'BF16',
      weightsGb: '',
      weightsExportable: false,
      licenseId: '',
      hfRepo: '',
    },
  };
}

/** Architecture sentinel for a model reachable only through a vendor API. */
export const VENDOR_API_ARCHITECTURE = 'vendor-api';

export const MODEL_PRESETS: ModelPreset[] = [
  openWeights(
    'llama-3.1-8b',
    'Llama 3.1 8B Instruct',
    'LlamaForCausalLM',
    'TEXT',
    '8',
    '128000',
    '16',
    'llama-3.1-community',
    'meta-llama/Llama-3.1-8B-Instruct'
  ),
  openWeights(
    'llama-3.1-70b',
    'Llama 3.1 70B Instruct',
    'LlamaForCausalLM',
    'TEXT',
    '70',
    '128000',
    '140',
    'llama-3.1-community',
    'meta-llama/Llama-3.1-70B-Instruct'
  ),
  openWeights(
    'mistral-7b-v03',
    'Mistral 7B Instruct v0.3',
    'MistralForCausalLM',
    'TEXT',
    '7',
    '32768',
    '14',
    'apache-2.0',
    'mistralai/Mistral-7B-Instruct-v0.3'
  ),
  openWeights(
    'mixtral-8x7b',
    'Mixtral 8x7B Instruct',
    'MixtralForCausalLM',
    'TEXT',
    '47',
    '32768',
    '94',
    'apache-2.0',
    'mistralai/Mixtral-8x7B-Instruct-v0.1'
  ),
  openWeights(
    'qwen25-7b',
    'Qwen2.5 7B Instruct',
    'Qwen2ForCausalLM',
    'TEXT',
    '7',
    '32768',
    '15',
    'apache-2.0',
    'Qwen/Qwen2.5-7B-Instruct'
  ),
  openWeights(
    'qwen25-vl-7b',
    'Qwen2.5-VL 7B Instruct',
    'Qwen2_5_VLForConditionalGeneration',
    'VISION_LANGUAGE',
    '8',
    '32768',
    '16',
    'apache-2.0',
    'Qwen/Qwen2.5-VL-7B-Instruct'
  ),
  openWeights(
    'gpt-oss-20b',
    'gpt-oss-20b',
    'GptOssForCausalLM',
    'TEXT',
    '21',
    '131072',
    '42',
    'apache-2.0',
    'openai/gpt-oss-20b'
  ),
  openWeights(
    'deepseek-r1-distill-llama-8b',
    'DeepSeek-R1-Distill-Llama-8B',
    'LlamaForCausalLM',
    'TEXT',
    '8',
    '128000',
    '16',
    'mit',
    'deepseek-ai/DeepSeek-R1-Distill-Llama-8B'
  ),
  vendorApi(
    'elevenlabs',
    'ElevenLabs (vendor API)',
    'TTS',
    'Reachable only through the ElevenLabs API. No weights are distributed, so self-hosting is not possible.'
  ),
  vendorApi(
    'cartesia-sonic-3',
    'Cartesia Sonic 3 (vendor API)',
    'TTS',
    'Reachable only through the Cartesia API. No weights are distributed, so self-hosting is not possible.'
  ),
  vendorApi(
    'nova-2-sonic',
    'Amazon Nova 2 Sonic (native, speech-to-speech)',
    'SPEECH_TO_SPEECH',
    'A native Bedrock speech-to-speech model. It is invoked through the Bedrock API; the weights are not distributed.'
  ),
  vendorApi(
    'amazon-transcribe',
    'Amazon Transcribe (native, streaming ASR)',
    'ASR',
    'A native AWS streaming ASR service, invoked through its own API. There is no artifact to host.'
  ),
];

/** True when the form describes a model reachable only through a vendor API. */
export function isApiOnly(form: CaseFormState): boolean {
  return (
    !form.weightsExportable ||
    form.architecture.trim() === VENDOR_API_ARCHITECTURE
  );
}

export const DEFAULT_FORM: CaseFormState = {
  caseId: 'case-001',
  modelName: 'Llama 3.1 8B',
  architecture: 'LlamaForCausalLM',
  modality: 'TEXT',
  totalParamsB: '8',
  contextTokens: '128000',
  precision: 'BF16',
  weightsGb: '16',
  weightsExportable: true,
  licenseId: 'llama-3.1-community',
  hfRepo: 'meta-llama/Llama-3.1-8B-Instruct',

  horizonHours: '72',
  billableCopyHours: '6',
  dedicatedInstanceHours: '',
  scheduled: false,
  concurrency: '',
  description: '',

  provideSlo: false,
  sloMetric: 'p99_latency_ms',
  sloThresholdMs: '800',
  sloPercentile: '99',
  sloIncludeCold: true,
  sloErrorBudgetFraction: '0.01',

  permittedRegions: 'us-east-1',
  budgetUsd: '',
  requireHeldCapacity: false,
  maxOpsBurden: '',

  assumeChecksCleared: false,

  provideLatencyEvidence: false,
  latencyEvidence: [],
};

/** A new project contains no selected model or invented traffic. The old
 * DEFAULT_FORM is retained only as an explicit legacy example for fixtures. */
export const EMPTY_PROJECT: CaseFormState = {
  ...DEFAULT_FORM,
  modelName: '', architecture: '', totalParamsB: '', contextTokens: '',
  precision: '', weightsGb: '', licenseId: '', hfRepo: '', hfCommit: '',
  horizonHours: '720', billableCopyHours: '', sloThresholdMs: '',
  modelIntent: 'choose', sourceKind: 'huggingface', sourceLocation: '',
  trafficPattern: 'unknown', successCriteria: '', requests: '',
  inputTokensPerRequest: '', outputTokensPerRequest: '',
};

export interface WorkloadPreset {
  id: string;
  label: string;
  description: string;
  /** What the preset is meant to demonstrate, shown next to the buttons. */
  demonstrates: string;
  patch: Partial<CaseFormState>;
}

/**
 * Usage shortcuts change usage only. They never remove a response-time target,
 * invent measurements, or assume licence, quota and capacity have been verified.
 */
export const WORKLOAD_PRESETS: WorkloadPreset[] = [
  {
    id: 'bursty-3-day',
    label: '3-day bursty event',
    description: 'Compare 3 days, with an estimated 6 billable hours for a model copy that can pause when idle.',
    demonstrates: 'Actual billing depends on the timing of requests and idle billing windows.',
    patch: {
      horizonHours: '72',
      trafficPattern: 'occasional',
      billableCopyHours: '6',
      dedicatedInstanceHours: '',
      scheduled: false,
    },
  },
  {
    id: 'always-on-30-day',
    label: 'Always-on 30 days',
    description: 'Compare 30 days with the model available continuously, including quiet hours.',
    demonstrates: 'Each option is priced over the same 720-hour period.',
    patch: {
      horizonHours: '720',
      trafficPattern: 'always',
      billableCopyHours: '720',
      dedicatedInstanceHours: '',
      scheduled: false,
    },
  },
];

function optionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalInteger(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export interface ValidationIssue {
  /** `field` is a form key, or `latencyEvidence` for an entry-level problem. */
  field: keyof CaseFormState;
  message: string;
  /** Index into `latencyEvidence` when the issue belongs to one entry. */
  entryIndex?: number;
  /** Which column of the entry is at fault. */
  entryField?: keyof LatencyEvidenceEntry;
}

const NUMERIC_OPTIONAL: Array<[keyof CaseFormState, string]> = [
  ['totalParamsB', 'Total parameters'],
  ['contextTokens', 'Context tokens'],
  ['weightsGb', 'Weights size'],
  ['billableCopyHours', 'Billable copy hours'],
  ['dedicatedInstanceHours', 'Dedicated instance hours'],
  ['concurrency', 'Concurrency'],
  ['budgetUsd', 'Budget'],
  ['requests', 'Requests during the comparison period'],
  ['inputTokensPerRequest', 'Input tokens per request'],
  ['outputTokensPerRequest', 'Output tokens per request'],
  ['completionDeadlineSeconds', 'Job completion deadline'],
  ['cpuAdditionalCostUsd', 'EC2 CPU supporting-service allowance'],
  ['batchAdditionalCostUsd', 'Batch CPU supporting-service allowance'],
];

const ENTRY_NUMERIC: Array<[keyof LatencyEvidenceEntry, string]> = [
  ['p50Ms', 'p50 latency'],
  ['p99Ms', 'p99 latency'],
  ['coldStartMs', 'Cold start'],
  ['sampleCount', 'Sample count'],
  ['violationRateUpperBound', 'Violation rate upper bound'],
];

function nonNegativeNumber(raw: string): boolean {
  return Number.isFinite(Number(raw)) && Number(raw) >= 0;
}

/** Client-side validation. The backend remains authoritative. */
export function validateForm(form: CaseFormState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (form.workloadType === 'training' || form.workloadType === 'both') {
    issues.push({
      field: 'workloadType',
      message: 'Choose Use this project for inference in Your needs, then enter inference traffic. Training is outside EDDIE’s scope.',
    });
  }
  if (form.caseId.trim() === '') {
    issues.push({ field: 'caseId', message: 'Case ID is required.' });
  }
  if (form.modelName.trim() === '') {
    issues.push({ field: 'modelName', message: 'Choose a model to compare its hosting options.' });
  }
  if (form.architecture.trim() === '') {
    issues.push({
      field: 'architecture',
      message: 'Read the model details before comparing hosting options.',
    });
  }
  if (form.permittedRegions.trim() === '') {
    issues.push({
      field: 'permittedRegions',
      message: 'Choose where the model may run.',
    });
  }

  const horizonRaw = form.horizonHours.trim();
  if (horizonRaw === '') {
    issues.push({ field: 'horizonHours', message: 'Horizon hours is required.' });
  } else if (!nonNegativeNumber(horizonRaw)) {
    issues.push({
      field: 'horizonHours',
      message: 'Horizon hours must be a non-negative number.',
    });
  }

  // SLO fields are only required when an SLO is actually being sent.
  if (form.provideSlo) {
    for (const [field, label] of [
      ['sloThresholdMs', 'SLO threshold'],
      ['sloPercentile', 'SLO percentile'],
    ] as Array<[keyof CaseFormState, string]>) {
      const raw = String(form[field] ?? '').trim();
      if (raw === '') {
        issues.push({ field, message: `${label} is required when an SLO is set.` });
      } else if (!nonNegativeNumber(raw)) {
        issues.push({ field, message: `${label} must be a non-negative number.` });
      }
    }
    const budgetRaw = form.sloErrorBudgetFraction.trim();
    if (budgetRaw !== '' && !nonNegativeNumber(budgetRaw)) {
      issues.push({
        field: 'sloErrorBudgetFraction',
        message: 'Error budget fraction must be a non-negative number.',
      });
    }
  }

  for (const [field, label] of NUMERIC_OPTIONAL) {
    const raw = String(form[field] ?? '').trim();
    if (raw !== '' && !nonNegativeNumber(raw)) {
      issues.push({ field, message: `${label} must be a non-negative number.` });
    }
  }

  const horizon = Number(form.horizonHours);
  const dedicated = Number(form.dedicatedInstanceHours);
  if (form.dedicatedInstanceHours.trim() !== '' && Number.isFinite(dedicated) && dedicated > horizon) {
    issues.push({ field: 'dedicatedInstanceHours', message: 'Allocated hours per worker cannot exceed the comparison period.' });
  }
  if (form.concurrency.trim() !== '' && (!Number.isInteger(Number(form.concurrency)) || Number(form.concurrency) < 1 || Number(form.concurrency) > 1000000)) {
    issues.push({ field: 'concurrency', message: 'Concurrency must be a whole number between one and one million.' });
  }
  const deadline = form.completionDeadlineSeconds?.trim();
  if (deadline && (Number(deadline) <= 0 || Number(deadline) > 31536000)) {
    issues.push({ field: 'completionDeadlineSeconds', message: 'Completion deadline must be greater than zero and at most one year.' });
  }
  const billable = Number(form.billableCopyHours);
  if (
    form.billableCopyHours.trim() !== '' &&
    Number.isFinite(horizon) &&
    Number.isFinite(billable) &&
    billable > horizon
  ) {
    issues.push({
      field: 'billableCopyHours',
      message: 'Billable copy hours cannot exceed the horizon.',
    });
  }

  if (form.provideLatencyEvidence) {
    if (form.latencyEvidence.length === 0) {
      issues.push({
        field: 'latencyEvidence',
        message:
          'Add at least one evidence record, or turn off supplied latency evidence.',
      });
    }
    const seen = new Set<string>();
    form.latencyEvidence.forEach((entry, index) => {
      const candidateId = entry.candidateId.trim();
      if (candidateId === '') {
        issues.push({
          field: 'latencyEvidence',
          entryIndex: index,
          entryField: 'candidateId',
          message:
            'A candidate id is required — evidence is only reused for an identical candidate key.',
        });
      } else if (seen.has(candidateId)) {
        issues.push({
          field: 'latencyEvidence',
          entryIndex: index,
          entryField: 'candidateId',
          message: `Duplicate evidence for ${candidateId}. Each candidate can have one record.`,
        });
      } else {
        seen.add(candidateId);
      }

      for (const [entryField, label] of ENTRY_NUMERIC) {
        const raw = entry[entryField].trim();
        if (raw !== '' && !nonNegativeNumber(raw)) {
          issues.push({
            field: 'latencyEvidence',
            entryIndex: index,
            entryField,
            message: `${label} must be a non-negative number.`,
          });
        }
      }
    });
  }

  return issues;
}

/** Duty cycle implied by the current form, or `null` when not computable. */
export function formDutyPercent(form: CaseFormState): number | null {
  const horizon = Number(form.horizonHours);
  const billable = Number(form.billableCopyHours);
  if (!Number.isFinite(horizon) || horizon <= 0) return null;
  if (form.billableCopyHours.trim() === '' || !Number.isFinite(billable)) {
    return null;
  }
  return (billable / horizon) * 100;
}

/** True when the form declares any stipulated or supplied evidence. */
export function hasEvidenceCaveat(form: CaseFormState): boolean {
  return form.assumeChecksCleared || form.provideLatencyEvidence;
}

/** Map form state onto the wire request the backend accepts. */
export function toEvaluateRequest(form: CaseFormState): EvaluateRequest {
  const latencyEvidence: Record<string, LatencyEvidenceInput> = {};
  if (form.provideLatencyEvidence) {
    for (const entry of form.latencyEvidence) {
      const candidateId = entry.candidateId.trim();
      if (candidateId === '') continue;
      latencyEvidence[candidateId] = {
        p50Ms: optionalString(entry.p50Ms),
        p99Ms: optionalString(entry.p99Ms),
        coldStartMs: optionalString(entry.coldStartMs),
        sampleCount: optionalInteger(entry.sampleCount),
        violationRateUpperBound: optionalString(entry.violationRateUpperBound),
      };
    }
  }

  return {
    caseId: form.caseId.trim(),
    qualityGoal: optionalString(form.successCriteria ?? ''),
    qualification: qualificationPayload(form),
    model: {
      name: form.modelName.trim(),
      architecture: form.architecture.trim(),
      modality: form.modality,
      totalParamsB: optionalString(form.totalParamsB),
      contextTokens: optionalInteger(form.contextTokens),
      precision: form.precision,
      weightsGb: optionalString(form.weightsGb),
      weightsExportable: form.weightsExportable,
      licenseId: optionalString(form.licenseId),
      hfRepo: optionalString(form.hfRepo),
      hfCommit: optionalString(form.hfCommit ?? ''),
      ...(form.artifactDigest ? { artifactDigest: form.artifactDigest } : {}),
      sourceKind: form.sourceKind ?? null,
      inferenceProfileId: optionalString(form.inferenceProfileId ?? ''),
    },
    workload: {
      horizonHours: form.horizonHours.trim(),
      billableCopyHours: optionalString(form.billableCopyHours),
      dedicatedInstanceHours: optionalString(form.dedicatedInstanceHours),
      scheduled: form.scheduled,
      concurrency: optionalInteger(form.concurrency),
      description: optionalString(form.description),
      requests: optionalString(form.requests ?? ''),
      inputTokensPerRequest: optionalString(form.inputTokensPerRequest ?? ''),
      outputTokensPerRequest: optionalString(form.outputTokensPerRequest ?? ''),
    },
    // An empty array means "no latency objective", which is different from an
    // objective EDDIE cannot evaluate.
    slos: form.provideSlo
      ? [
          {
            metric: form.sloMetric,
            thresholdMs: form.sloThresholdMs.trim(),
            /*
             * Sent only for a metric that does not already name its percentile.
             *
             * For p50/p95/p99 the metric *is* the percentile, and the backend now
             * rejects a `percentile` that contradicts it. Sending the form's field
             * unconditionally meant switching the metric to p50 while the field
             * still read 99 produced a validation failure. Omitting it lets the
             * backend derive the percentile from the metric, which is the single
             * source of truth.
             */
            ...(metricImpliedPercentile(form.sloMetric) === null &&
            form.sloPercentile.trim() !== ''
              ? { percentile: form.sloPercentile.trim() }
              : {}),
            includeCold: form.sloIncludeCold,
            errorBudgetFraction: optionalString(form.sloErrorBudgetFraction),
          },
        ]
      : [],
    constraints: {
      permittedRegions: form.permittedRegions
        .split(',')
        .map((region) => region.trim())
        .filter((region) => region !== ''),
      permittedProcessingRegions: (form.permittedProcessingRegions ?? '')
        .split(',').map((region) => region.trim()).filter(Boolean),
      budgetUsd: optionalString(form.budgetUsd),
      requireHeldCapacity: form.requireHeldCapacity,
      maxOpsBurden: optionalString(form.maxOpsBurden),
    },
    assumeChecksCleared: form.assumeChecksCleared,
    latencyEvidence:
      Object.keys(latencyEvidence).length > 0 ? latencyEvidence : null,
  };
}

/* ------------------------------------------------- chat / form case syncing */

/**
 * Fields the advisor may write, mirroring the backend's
 * `ADVISOR_WRITABLE_FIELDS`. The backend deliberately uses the form's own
 * names, so this is a whitelist rather than a translation table: a key the
 * advisor invents is dropped instead of reaching the form.
 */
export const ADVISOR_WRITABLE_FIELDS = [
  ...QUALIFICATION_FIELDS,
  'trafficPattern',
  'scheduled',
  'dedicatedInstanceHours',
  'provideSlo',
  'sloIncludeCold',
  'sloPercentile',
  'sloErrorBudgetFraction',
  'successCriteria',
  'requests',
  'inputTokensPerRequest',
  'outputTokensPerRequest',
  'modelName',
  'architecture',
  'modality',
  'weightsExportable',
  'totalParamsB',
  'contextTokens',
  'weightsGb',
  'licenseId',
  'hfRepo',
  'horizonHours',
  'billableCopyHours',
  'description',
  'concurrency',
  // The metric is part of the requirement: a time-to-first-audio objective is
  // not generic p99 latency, and rewriting one to the other changes what the
  // user asked for.
  'sloMetric',
  'sloThresholdMs',
  // Constraints stated in prose must reach the solver. While these were absent
  // a stated region or budget only appeared in the advisor's commentary while
  // the solver ranked against different constraints.
  'permittedRegions',
  'budgetUsd',
  'requireHeldCapacity',
  'maxOpsBurden',
] as const satisfies readonly (keyof CaseFormState)[];

export type AdvisorWritableField = (typeof ADVISOR_WRITABLE_FIELDS)[number];

/** Human labels for the "Requirements updated" summary. */
export const CASE_FIELD_LABELS: Record<AdvisorWritableField, string> = {
  workloadType: 'Work to perform',
  modelStage: 'Base or fine-tuned model',
  selectionStage: 'Model selection',
  servingPattern: 'How answers are delivered',
  goLiveDate: 'Go-live date',
  platformPreference: 'Existing platform',
  growthNotes: 'Expected growth',
  availabilityNeeds: 'Availability needs',
  complianceNeeds: 'Data and compliance needs',
  weightCustody: 'Control of model weights',
  currentSpendUsd: 'Current monthly spend (USD)',
  benchmarkedAlternatives: 'Alternatives already tested',
  requestsPerMinute: 'Requests per minute when busy',
  cpuRuntime: 'CPU runtime compatibility',
  completionDeadlineSeconds: 'Job completion deadline (seconds)',
  cpuAdditionalCostUsd: 'EC2 CPU supporting-service allowance (USD)',
  batchAdditionalCostUsd: 'Batch CPU supporting-service allowance (USD)',
  cpuCostNotes: 'Allowance sources and included services',
  trafficPattern: 'Usage pattern',
  scheduled: 'Known schedule',
  dedicatedInstanceHours: 'Dedicated instance hours',
  provideSlo: 'Response-time target enabled',
  sloIncludeCold: 'First request after idle included',
  sloPercentile: 'Requests that must meet the speed target (%)',
  sloErrorBudgetFraction: 'Allowed late-request fraction',
  successCriteria: 'Answer-quality goal',
  requests: 'Requests in the comparison period',
  inputTokensPerRequest: 'Input tokens per request',
  outputTokensPerRequest: 'Output tokens per request',
  modelName: 'Model name',
  architecture: 'Architecture',
  modality: 'Modality',
  weightsExportable: 'Weights exportable',
  totalParamsB: 'Total parameters (B)',
  contextTokens: 'Context tokens',
  weightsGb: 'Weights size (GiB)',
  licenseId: 'Licence identifier',
  hfRepo: 'Hugging Face repository',
  horizonHours: 'Horizon (hours)',
  billableCopyHours: 'Billable copy hours',
  description: 'Description',
  concurrency: 'Concurrency',
  sloMetric: 'SLO metric',
  sloThresholdMs: 'Latency threshold (ms)',
  permittedRegions: 'Permitted regions',
  budgetUsd: 'Budget (USD)',
  requireHeldCapacity: 'Require held capacity',
  maxOpsBurden: 'Maximum ops burden',
};

const BOOLEAN_FIELDS = new Set<AdvisorWritableField>([
  'provideSlo', 'sloIncludeCold', 'scheduled',
  'weightsExportable',
  'requireHeldCapacity',
]);

/** Fields the form holds as a comma-separated string but the wire may send as a list. */
const LIST_FIELDS = new Set<AdvisorWritableField>(['permittedRegions']);

/** One field the advisor changed, ready to display. */
export interface CaseChange {
  field: AdvisorWritableField;
  label: string;
  value: string;
}

/**
 * Normalise a value from the advisor into the form's representation.
 *
 * The form holds numbers as strings so the user's exact input survives, but
 * the advisor may send a JSON number. `null`/blank is dropped rather than
 * written as an empty string, so a patch never silently clears a field the
 * advisor did not mention.
 */
function normaliseValue(
  field: AdvisorWritableField,
  raw: unknown
): string | boolean | null {
  if (raw === null || raw === undefined) return null;
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  }
  if (typeof raw === 'boolean') return null;
  if (LIST_FIELDS.has(field) && Array.isArray(raw)) {
    // The solver takes a list; the form edits a comma-separated string.
    const joined = raw
      .map((item) => String(item).trim())
      .filter((item) => item !== '')
      .join(', ');
    return joined === '' ? null : joined;
  }
  const text = String(raw).trim();
  return text === '' ? null : text;
}

/**
 * Build the form patch for an advisor case (or case patch).
 *
 * Setting a latency threshold also turns the SLO on: the backend only sends
 * `slos` when a threshold exists, so a threshold with `provideSlo: false`
 * would be silently ignored on the next form-driven evaluation.
 */
export function caseToFormPatch(
  advisorCase: Record<string, unknown>
): Partial<CaseFormState> {
  const patch: Partial<CaseFormState> = {};
  for (const field of ADVISOR_WRITABLE_FIELDS) {
    if (!(field in advisorCase)) continue;
    const value = normaliseValue(field, advisorCase[field]);
    if (value === null) continue;
    if (BOOLEAN_FIELDS.has(field)) {
      (patch as Record<string, unknown>)[field] = value as boolean;
    } else {
      (patch as Record<string, unknown>)[field] = value as string;
    }
  }
  if (typeof patch.sloThresholdMs === 'string' && patch.sloThresholdMs !== '') {
    if (patch.provideSlo !== false) patch.provideSlo = true;
  }

  /*
   * Model-transition cleanup.
   *
   * Switching to an API-only model must not leave the previous artifact's
   * values behind. The retest found a Llama Hugging Face repository and an 8B
   * parameter count still in the case after moving to an ElevenLabs TTS
   * integration, while the form said those fields did not apply — so values the
   * user could no longer see were still being sent.
   */
  const becomesApiOnly =
    patch.weightsExportable === false ||
    patch.architecture === VENDOR_API_ARCHITECTURE;
  if (becomesApiOnly) {
    patch.weightsExportable = false;
    patch.totalParamsB = '';
    patch.contextTokens = '';
    patch.weightsGb = '';
    patch.licenseId = '';
    patch.hfRepo = '';
    patch.provideLatencyEvidence = false;
    patch.latencyEvidence = [];
  }

  return patch;
}

/** Describe an advisor case patch for the "Requirements updated" summary. */
export function describeCasePatch(
  advisorCase: Record<string, unknown>
): CaseChange[] {
  const changes: CaseChange[] = [];
  for (const field of ADVISOR_WRITABLE_FIELDS) {
    if (!(field in advisorCase)) continue;
    const value = normaliseValue(field, advisorCase[field]);
    if (value === null) continue;
    changes.push({
      field,
      label: CASE_FIELD_LABELS[field],
      value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value,
    });
  }
  return changes;
}

/** Project the current form back onto the advisor's case shape. */
export function formToAdvisorCase(
  form: CaseFormState
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const field of ADVISOR_WRITABLE_FIELDS) {
    const value = form[field];
    if (typeof value === 'boolean') {
      result[field] = value;
      continue;
    }
    const text = String(value ?? '').trim();
    if (text !== '') result[field] = text;
  }
  if (form.hfCommit) result.hfCommit = form.hfCommit;
  if (form.artifactDigest) result.artifactDigest = form.artifactDigest;
  // These route choices require an explicit manual choice. The advisor receives
  // them for evaluation but cannot silently expand the processing geography.
  if (form.sourceKind) result.sourceKind = form.sourceKind;
  if (form.inferenceProfileId) result.inferenceProfileId = form.inferenceProfileId;
  if (form.permittedProcessingRegions) result.permittedProcessingRegions = form.permittedProcessingRegions;
  result.precision = form.precision;
  // A threshold the user has switched off must not be presented as live.
  if (!form.provideSlo) delete result.sloThresholdMs;
  return result;
}

/*
 * The snapshot-based staleness mechanism that used to live here has been
 * removed. A snapshot of the form at submit time cannot decide whether a
 * decision is current: the advisor can patch the case afterwards, and a
 * strictness change can flip `assumeChecksCleared`, so the snapshot describes
 * what the user typed rather than what the solver received. Staleness now
 * compares the live form's projected payload against the decision's own
 * `evaluatedRequest` — see `state/evaluatedRequest.ts`.
 */
