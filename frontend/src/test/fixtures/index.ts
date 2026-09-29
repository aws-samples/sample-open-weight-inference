import bursty from './evaluate-bursty.json';
import steady from './evaluate-steady.json';
import { DEFAULT_FORM, caseToFormPatch, toEvaluateRequest } from '../../state/caseForm';
import type {
  CatalogResponse,
  ChatResponse,
  EvaluatePayloadEcho,
  DemoStatusResponse,
  EvaluateResponse,
  HealthResponse,
  KnowledgeResponse,
  RatesResponse,
  RuntimeConfig,
} from '../../api/types';

/**
 * Neutral synthetic fixtures. These are development/test data only: no
 * customer case, no claim of model availability or performance.
 */
export const burstyResult = bursty as unknown as EvaluateResponse;
export const steadyResult = steady as unknown as EvaluateResponse;

export const configFixture: RuntimeConfig = {
  agentRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/eddie_test_coordinator-TEST',
  region: 'us-east-1',
  releaseId: 'test',
  userPoolId: 'us-east-1_TESTPOOL',
  userPoolClientId: 'testclientid00000000000000',
};

export const healthFixture: HealthResponse = {
  status: 'OK',
  solverVersion: '1.1.0+policy1',
  region: 'us-east-1',
  timestamp: '2026-09-12T09:15:00Z',
  priceList: { status: 'LIVE', sampleRate: '1.0' },
  limits: { syncRequestMinutes: 15, streamingMinutes: 60, asyncJobHours: 8 },
  knowledge: { state: 'NOT_INSTALLED', detail: 'COA is not installed here.' },
  demoLifecycle: { state: 'SLEEPING', detail: null },
};

export const ratesFixture: RatesResponse = {
  region: 'us-east-1',
  retrievedAt: '2026-09-12T09:15:00Z',
  freshness: { sagemaker: 'LIVE', cmi_minute: 'LIVE', cmi_month: 'PINNED' },
  cmiFamily: 'SyntheticText',
  cmuVersion: 'cmu-v2',
  rates: {
    sagemakerInstanceHour: {
      amount: '1.22',
      unit: 'Hrs',
      currency: 'USD',
      region: 'us-east-1',
      sku: 'SYNTH-SM-G52XL-0002',
      effectiveDate: '2026-08-01',
      source: 'AWS Price List API',
    },
    cmiPerCmuMinute: {
      amount: '0.0571666667',
      unit: 'CMU-minute',
      currency: 'USD',
      region: 'us-east-1',
      sku: 'SYNTH-CMI-MIN-0001',
      effectiveDate: '2026-08-01',
      source: 'AWS Price List API',
    },
    cmiPerCmuMonth: null,
  },
};

export const catalogFixture: CatalogResponse = {
  region: 'us-east-1',
  count: 2,
  models: [
    {
      modelId: 'synthetic.text-lite-v1',
      modelName: 'Synthetic Text Lite',
      provider: 'Synthetic Labs',
      inputModalities: ['TEXT'],
      outputModalities: ['TEXT'],
      streamingSupported: true,
      inferenceTypes: ['ON_DEMAND'],
    },
    {
      modelId: 'synthetic.vision-v1',
      modelName: 'Synthetic Vision',
      provider: 'Neutral Vision Co',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      streamingSupported: false,
      inferenceTypes: ['PROVISIONED'],
    },
  ],
  note: 'Development fixture data. Not a statement of model availability.',
};

export const knowledgeReadyFixture: KnowledgeResponse = {
  state: 'READY',
  context:
    'Synthetic policy excerpt: inference workloads may run in approved regions only.',
  citations: [{ source: 'synthetic-policy-v1', section: '4.2' }],
  affectsPlacement: false,
  trust: 'GOVERNED',
  detail: null,
};

export const knowledgeNotInstalledFixture: KnowledgeResponse = {
  state: 'NOT_INSTALLED',
  context: null,
  citations: null,
  affectsPlacement: false,
  trust: null,
  detail: 'The COA knowledge base is not deployed in this environment.',
};

export const demoSleepingFixture: DemoStatusResponse = {
  state: 'SLEEPING',
  neptuneStatus: 'stopped',
  services: { neptune: 'stopped', ingestion: 'stopped' },
  expiresAt: '2026-09-30T00:00:00Z',
  expired: false,
  lastWakeSeconds: 412,
  resumeTimeNote: 'The last observed wake took 412 seconds end to end.',
  costNote: 'While asleep, storage is still billable.',
};

export const demoWakingFixture: DemoStatusResponse = {
  ...demoSleepingFixture,
  state: 'WAKING',
  neptuneStatus: 'starting',
  services: { neptune: 'starting', ingestion: 'stopped' },
};

export const demoNotConfiguredFixture: DemoStatusResponse = {
  state: 'NOT_CONFIGURED',
  neptuneStatus: null,
  services: null,
  expiresAt: null,
  expired: null,
  lastWakeSeconds: null,
  resumeTimeNote: null,
  costNote: null,
};

/**
 * A NO_QUALIFIED_PLACEMENT result: nothing ranked, one candidate unresolved on
 * a licence gate and a latency gate, one excluded on a cold start. Used to
 * exercise the empty state that has to name the blocking gates.
 */
export const noQualifiedResult: EvaluateResponse = {
  ...burstyResult,
  outcome: 'NO_QUALIFIED_PLACEMENT',
  winner: null,
  ranked: [],
  unresolved: [
    {
      ...burstyResult.ranked[0],
      candidateId: 'cmi-scale-to-zero',
      isFeasible: false,
      failureCount: 0,
      unknownCount: 2,
      gates: [
        {
          name: 'p99_latency_ms',
          status: 'UNKNOWN',
          reason: 'No latency evidence exists for this candidate key.',
          evidenceRef: null,
        },
        {
          name: 'licence',
          status: 'UNKNOWN',
          reason: 'Licence terms were not verified for this artifact.',
          evidenceRef: null,
        },
      ],
    },
    {
      ...burstyResult.ranked[1],
      candidateId: 'sagemaker-ml.g5.2xlarge',
      isFeasible: false,
      failureCount: 0,
      unknownCount: 1,
      gates: [
        {
          name: 'quota',
          status: 'UNKNOWN',
          reason: 'Service quota headroom was not observed for this account.',
          evidenceRef: null,
        },
      ],
    },
  ],
  excluded: [
    {
      ...burstyResult.excluded[0],
      candidateId: 'cmi-cold-excluded',
      gates: [
        {
          name: 'p99_latency_ms',
          status: 'FAIL',
          reason:
            'Cold restoration of 45000 ms exceeds the 800 ms threshold with cold requests included.',
          evidenceRef: 'supplied:cmi-cold-excluded',
        },
      ],
    },
  ],
  counts: { ranked: 0, unresolved: 2, excluded: 1 },
};

/**
 * The correct outcome for an API-only model: no self-hosted candidate can
 * serve it, so both targets fail the `weights_exportable` gate. This is a
 * capability gap, not an error.
 */
export const apiOnlyResult: EvaluateResponse = {
  ...burstyResult,
  outcome: 'NO_QUALIFIED_PLACEMENT',
  winner: null,
  ranked: [],
  unresolved: [],
  breakeven: null,
  excluded: [
    {
      ...burstyResult.ranked[0],
      candidateId: 'cmi-scale-to-zero',
      isFeasible: false,
      failureCount: 2,
      unknownCount: 0,
      cost: null,
      gates: [
        {
          name: 'weights_exportable',
          status: 'FAIL',
          reason: 'Model is API-only; weights are not exportable for self-hosting',
          evidenceRef: null,
        },
        {
          name: 'modality',
          status: 'FAIL',
          reason: 'Custom Model Import does not accept TTS models',
          evidenceRef: null,
        },
      ],
    },
    {
      ...burstyResult.ranked[1],
      candidateId: 'sagemaker-ml.g5.2xlarge',
      isFeasible: false,
      failureCount: 1,
      unknownCount: 0,
      cost: null,
      gates: [
        {
          name: 'weights_exportable',
          status: 'FAIL',
          reason: 'Model is API-only; weights are not exportable for self-hosting',
          evidenceRef: null,
        },
      ],
    },
  ],
  counts: { ranked: 0, unresolved: 0, excluded: 2 },
};

/* ------------------------------------------------------------- chat fixtures */

const CHAT_PROVENANCE =
  'Costs, gates and rankings come from the deterministic solver and live AWS prices. The advisor explains that result; it does not compute it.';

const CHAT_SUGGESTED = [
  "I'm launching a 3-day game and expect about 6 hours of real traffic. Where should I host Llama 3.1 8B?",
  'Same model but an always-on service for a month — does the answer change?',
  'First response after idle must be under 800 ms. Which options survive?',
];

/** A turn that recorded requirements and ran the solver. */
export const chatWithDecisionFixture: ChatResponse = {
  reply:
    '## Bedrock Custom Model Import wins here\n\nYour duty cycle is **8.33%**, below the 17.02% break-even, so paying per active minute is cheaper than holding an instance for 72 hours.\n\n- Active CMU-minutes dominate the cost\n- A warm endpoint would sit idle for 66 hours\n\nSee the decision below for the itemised figures.',
  case: {
    modelName: 'Llama 3.1 8B',
    architecture: 'LlamaForCausalLM',
    modality: 'TEXT',
    horizonHours: '72',
    billableCopyHours: '6',
    weightsExportable: true,
  },
  casePatch: {
    architecture: 'LlamaForCausalLM',
    horizonHours: '72',
    billableCopyHours: '6',
  },
  decision: burstyResult,
  toolCalls: [
    {
      name: 'propose_case_patch',
      input: { architecture: 'LlamaForCausalLM', horizonHours: '72' },
      status: 'success',
    },
    { name: 'get_rates', input: {}, status: 'success' },
    { name: 'evaluate_placement', input: {}, status: 'success' },
  ],
  rounds: 4,
  truncated: false,
  advisorModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  usage: { inputTokens: 3211, outputTokens: 604 },
  suggestedPrompts: CHAT_SUGGESTED,
  provenance: CHAT_PROVENANCE,
  evaluatedRequest: null,
  evaluatedRequestHash: null,
  unsupportedInputs: null,
  strictRequestedByAdvisor: false,
};

/** An intake-only turn: prose, no evaluation, so no cost UI may appear. */
export const chatIntakeOnlyFixture: ChatResponse = {
  reply:
    'Before I can evaluate, I need to know which model this is. Is it an open-weights model you can host, or a vendor API?',
  case: { description: 'A new service' },
  casePatch: {},
  decision: null,
  toolCalls: [],
  rounds: 1,
  truncated: false,
  advisorModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  usage: { inputTokens: 812, outputTokens: 96 },
  suggestedPrompts: CHAT_SUGGESTED,
  provenance: CHAT_PROVENANCE,
  evaluatedRequest: null,
  evaluatedRequestHash: null,
  unsupportedInputs: null,
  strictRequestedByAdvisor: false,
};

/** The tool-call limit was reached, so the answer may be incomplete. */
export const chatTruncatedFixture: ChatResponse = {
  reply:
    'I reached the tool-call limit for this turn without finishing. The case may be under-specified — tell me the horizon and roughly how many hours of real traffic to expect, and I will evaluate.',
  case: { architecture: 'LlamaForCausalLM' },
  casePatch: { architecture: 'LlamaForCausalLM' },
  decision: null,
  toolCalls: [
    { name: 'propose_case_patch', input: {}, status: 'success' },
    { name: 'evaluate_placement', input: {}, status: 'error' },
  ],
  rounds: 6,
  truncated: true,
  advisorModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  usage: {},
  suggestedPrompts: CHAT_SUGGESTED,
  provenance: CHAT_PROVENANCE,
  evaluatedRequest: null,
  evaluatedRequestHash: null,
  unsupportedInputs: null,
  strictRequestedByAdvisor: false,
};

/** The API-only refusal: correct outcome, no self-hosted candidate. */
/**
 * The evaluate payload the runtime would have received for a case patch.
 *
 * Built with production code so a fixture decision's `evaluatedRequest` always
 * agrees with the patch its turn applied. A hand-written payload would drift and
 * make the decision read as stale the moment it arrived.
 */
function evaluatedRequestForPatch(
  patch: Record<string, unknown>
): EvaluatePayloadEcho {
  return toEvaluateRequest({
    ...DEFAULT_FORM,
    ...caseToFormPatch(patch),
  }) as unknown as EvaluatePayloadEcho;
}

export const chatApiOnlyFixture: ChatResponse = {
  reply:
    'ElevenLabs does not distribute weights, so you cannot host it in your own account. The honest path is an API integration.',
  case: {
    modelName: 'ElevenLabs (vendor API)',
    architecture: 'vendor-api',
    modality: 'TTS',
    weightsExportable: false,
  },
  casePatch: {
    modelName: 'ElevenLabs (vendor API)',
    architecture: 'vendor-api',
    modality: 'TTS',
    weightsExportable: false,
  },
  decision: {
    ...apiOnlyResult,
    evaluatedRequest: evaluatedRequestForPatch({
      modelName: 'ElevenLabs (vendor API)',
      architecture: 'vendor-api',
      modality: 'TTS',
      weightsExportable: false,
    }),
    evaluatedRequestHash: 'apionly00000000000000000000000000'.slice(0, 32),
  },
  toolCalls: [
    { name: 'propose_case_patch', input: {}, status: 'success' },
    { name: 'evaluate_placement', input: {}, status: 'success' },
  ],
  rounds: 3,
  truncated: false,
  advisorModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  usage: {},
  suggestedPrompts: CHAT_SUGGESTED,
  provenance: CHAT_PROVENANCE,
  evaluatedRequest: null,
  evaluatedRequestHash: null,
  unsupportedInputs: null,
  strictRequestedByAdvisor: false,
};

/** A decision whose latency was never requested: conditional, nothing measured. */
export const notRequestedQualification = {
  performanceMeasured: false,
  latencyStatus: 'NOT_REQUESTED' as const,
  sloRequested: false,
  benchmarkRunIds: [] as string[],
  conditional: true,
  note: 'No latency objective was declared, so no latency gate was evaluated and nothing was measured.',
};

/** A decision backed by a real benchmark run. */
export const measuredQualification = {
  performanceMeasured: true,
  latencyStatus: 'MEASURED' as const,
  sloRequested: true,
  benchmarkRunIds: ['run-4f21'],
  conditional: false,
  note: 'Latency was compared against benchmark evidence for the exact candidate key.',
};

/** A chat turn carrying unsupported inputs and honoured strict mode. */
export const chatStrictWithUnsupportedFixture: ChatResponse = {
  ...chatWithDecisionFixture,
  reply:
    'I have switched off the stipulated checks as you asked. With no verified licence, quota, recipe or capacity evidence, no candidate can qualify.',
  casePatch: {
    permittedRegions: ['us-west-2'],
    budgetUsd: '200',
    concurrency: 4,
  },
  decision: {
    ...burstyResult,
    outcome: 'NO_QUALIFIED_PLACEMENT',
    winner: null,
    ranked: [],
    counts: { ranked: 0, unresolved: 5, excluded: 0 },
    checksStipulated: false,
    qualification: notRequestedQualification,
    evaluatedRequest: evaluatedRequestForPatch({
      permittedRegions: ['us-west-2'],
      budgetUsd: '200',
      concurrency: 4,
    }),
    evaluatedRequestHash: 'strict000000000000000000000000000'.slice(0, 32),
  },
  strictRequestedByAdvisor: true,
  unsupportedInputs: [
    {
      field: 'sloMetric',
      value: 'p99_ttfa_ms',
      reason:
        'p99_ttfa_ms is not a metric the solver evaluates. Supported: conversation_response_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms, ttfa_ms, ttft_ms.',
    },
  ],
  evaluatedRequest: {
    caseId: 'chat-case',
    constraints: {
      permittedRegions: ['us-west-2'],
      budgetUsd: '200',
    },
    workload: { horizonHours: '720', concurrency: 4 },
  },
  evaluatedRequestHash: 'aa11bb22cc33dd44ee55ff6677889900',
};

/**
 * SUPPLIED with the solver's specific reason.
 *
 * MEASURED now requires a *validated* run — applicable to the exact candidate,
 * metric and workload. A run that covers a different metric reports SUPPLIED,
 * and the gate text names precisely what fell short.
 */
export const suppliedNotQualifiedQualification = {
  performanceMeasured: false,
  latencyStatus: 'SUPPLIED' as const,
  sloRequested: true,
  benchmarkRunIds: [] as string[],
  conditional: true,
  note: 'Latency was compared against evidence supplied with the request.',
};

export const SUPPLIED_GATE_REASON =
  'Thresholds met against supplied evidence, but it is not qualified as a measurement: run run-abc covers p99_latency_ms but not ttft_ms';

/** A decision whose ranked candidate carries that gate reason. */
export const suppliedNotQualifiedResult: EvaluateResponse = {
  ...burstyResult,
  qualification: suppliedNotQualifiedQualification,
  ranked: burstyResult.ranked.map((candidate, index) =>
    index === 0
      ? {
          ...candidate,
          gates: [
            ...candidate.gates.filter((gate) => gate.name !== 'latency'),
            {
              name: 'latency',
              status: 'PASS' as const,
              reason: SUPPLIED_GATE_REASON,
              evidenceRef: 'supplied',
            },
          ],
        }
      : candidate
  ),
};
