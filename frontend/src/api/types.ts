/**
 * Typed contract for the EDDIE control plane.
 *
 * The control plane is an **AgentCore Runtime** invoked directly from the
 * browser with a Cognito access token. There is no API Gateway and no
 * `apiBaseUrl`: every call is a POST of `{action, payload}` to the runtime's
 * `/invocations` endpoint, and every success is wrapped in an
 * `{action, result, elapsedMs}` envelope.
 *
 * Numeric quantities arrive as decimal strings so no precision is lost in
 * transit; the UI treats them as strings and never coerces an absent value
 * to zero.
 */

/** Runtime configuration fetched from `/config.json` at startup. */
export interface RuntimeConfig {
  /** ARN of the AgentCore Runtime that hosts the EDDIE coordinator. */
  agentRuntimeArn: string;
  region: string;
  releaseId: string | null;
  /** Cognito user pool that issues the access token. */
  userPoolId: string;
  userPoolClientId: string;
}

/* ---------------------------------------------------------------- envelope */

/** Every action EDDIE's coordinator accepts. */
export type AgentAction =
  | 'case.get'
  | 'case.save'
  | 'case.list'
  | 'case.remove'
  | 'chat'
  | 'chat.history'
  | 'chat.cancel'
  | 'health'
  | 'inspect_model'
  | 'sizing.estimate'
  | 'checkpoint.list'
  | 'checkpoint.inspect'
  | 'connectors'
  | 'evaluation.score'
  | 'deployment.list'
  | 'deployment.get'
  | 'plan.list'
  | 'plan.create'
  | 'plan.get'
  | 'plan.approve'
  | 'deployment.invoke'
  | 'deployment.delete'
  | 'rates'
  | 'catalog'
  | 'evaluate'
  | 'knowledge'
  | 'demo.status'
  | 'demo.wake'
  | 'demo.sleep';

/** Error codes the coordinator reports in a handled failure. */
export type AgentErrorCode =
  | 'invalid_request'
  | 'unknown_action'
  | 'invalid_json'
  | 'internal_error';

/**
 * Success envelope. The coordinator returns HTTP 200 for handled failures too,
 * because AgentCore replaces any non-2xx container response with a generic
 * body and HTTP 424, discarding the detail. So `ok` — not the HTTP status — is
 * what distinguishes success from an operation failure.
 */
export interface AgentSuccessEnvelope<T> {
  action: string;
  ok: true;
  result: T;
  elapsedMs: number;
}

/** Handled-failure envelope, also delivered with HTTP 200. */
export interface AgentFailureEnvelope {
  action: string;
  ok: false;
  /** `detail` is written to be user-facing and names the offending field. */
  error: AgentErrorCode | string;
  detail: string;
}

export type AgentEnvelope<T> =
  | AgentSuccessEnvelope<T>
  | AgentFailureEnvelope;

/* --------------------------------------------------------- streaming events */

export type StreamEventName = 'start' | 'progress' | 'answer_delta' | 'heartbeat' | 'complete' | 'result' | 'error' | 'end';

/**
 * A server-sent event from a streaming invocation. `progress` events carry
 * whatever the coordinator chose to report; the UI shows the message verbatim
 * and never fabricates a percentage the backend did not send.
 */
export interface StreamEvent<T = unknown> {
  event: StreamEventName;
  message?: string;
  /** Present on the `result` frame, which also carries `ok: true`. */
  ok?: boolean;
  result?: T;
  /** Present on the `error` frame. */
  error?: string;
  detail?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ health */

export type HealthStatus = 'OK' | 'DEGRADED';

/** Execution ceilings reported by the runtime. */
export interface RuntimeLimits {
  syncRequestMinutes: number;
  streamingMinutes: number;
  asyncJobHours: number;
}

export interface HealthResponse {
  status: HealthStatus;
  solverVersion: string;
  region: string;
  timestamp: string;
  priceList: {
    status: string;
    sampleRate: string | number | null;
  };
  limits: RuntimeLimits | null;
  knowledge: {
    state?: KnowledgeState;
    detail?: string | null;
    [key: string]: unknown;
  } | null;
  awsDocumentation?: { state: 'CONFIGURED' | 'DISABLED'; provider: string; detail: string };
  demoLifecycle: {
    state?: DemoState;
    detail?: string | null;
    [key: string]: unknown;
  } | null;
}

/* ------------------------------------------------------------------- rates */

/** Price-list freshness for a single rate family. */
export type Freshness = 'LIVE' | 'PINNED' | 'UNKNOWN';

export interface Rate {
  amount: string;
  unit: string;
  currency: string;
  region: string;
  sku: string | null;
  effectiveDate: string | null;
  source: string | null;
}

export interface RatesResponse {
  region: string;
  retrievedAt: string;
  freshness: Record<string, Freshness>;
  cmiFamily: string | null;
  cmuVersion: string | null;
  rates: {
    sagemakerInstanceHour: Rate | null;
    cmiPerCmuMinute: Rate | null;
    cmiPerCmuMonth: Rate | null;
  };
}

export interface RatesPayload {
  instanceType?: string;
  architecture?: string;
}

/* ----------------------------------------------------------------- catalog */

export interface CatalogModel {
  modelId: string;
  modelName: string;
  provider: string;
  inputModalities: string[];
  outputModalities: string[];
  streamingSupported: boolean;
  inferenceTypes: string[];
}

export interface CatalogResponse {
  region: string;
  count: number;
  models: CatalogModel[];
  note: string | null;
  inferenceProfiles?: InferenceProfile[];
  profileIssue?: string | null;
}

export interface InferenceProfile {
  id: string;
  name: string;
  modelIds: string[];
  processingRegions: string[];
  global: boolean;
  status: string;
}

/* --------------------------------------------------------------- knowledge */

export type KnowledgeState = 'NOT_INSTALLED' | 'READY' | 'SLEEPING' | 'ERROR';

export interface KnowledgeCitation {
  /** Shape is provider-defined; render whatever fields exist. */
  [key: string]: unknown;
}

/**
 * COA governed context. `affectsPlacement` is always `false` — governed
 * context never moves a price or a gate — and the UI must say so prominently.
 */
export interface KnowledgeResponse {
  state: KnowledgeState;
  context: string | null;
  citations: KnowledgeCitation[] | null;
  affectsPlacement: false;
  trust: string | null;
  detail: string | null;
}

export interface KnowledgePayload {
  query: string;
}

/* ---------------------------------------------------------- demo lifecycle */

export type DemoState =
  | 'NOT_CONFIGURED'
  | 'SLEEPING'
  | 'WAKING'
  | 'READY'
  | 'SLEEPING_IN_PROGRESS'
  | 'ERROR';

export interface DemoServiceStatus {
  [service: string]: string;
}

export interface DemoStatusResponse {
  state: DemoState;
  neptuneStatus: string | null;
  services: DemoServiceStatus | null;
  expiresAt: string | null;
  expired: boolean | null;
  /** Measured duration of the last wake, in seconds. Not a promise. */
  lastWakeSeconds: number | null;
  resumeTimeNote: string | null;
  costNote: string | null;
}

/* ---------------------------------------------------------------- evaluate */

export type Evidence = 'MEASURED' | 'PROJECTED' | 'UNKNOWN';
export type GateStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type Target = 'BEDROCK_NATIVE' | 'BEDROCK_CMI' | 'SAGEMAKER_REALTIME' | 'EC2_CPU' | 'AWS_BATCH_CPU';
export type Outcome =
  | 'QUALIFIED_PLACEMENT'
  | 'NO_QUALIFIED_PLACEMENT'
  | 'NO_CANDIDATES';
export type BreakevenVerdict =
  | 'BURST_FAVOURS_CMI'
  | 'STEADY_FAVOURS_DEDICATED'
  | null;
export type LatencyEvidenceProvenance = 'SUPPLIED' | 'NONE';

export interface CostItem {
  label: string;
  phase: string;
  quantity: string | null;
  quantityUnit: string | null;
  rate: Rate | null;
  /** `null` means the amount could not be priced — render as UNKNOWN. */
  amount: string | null;
  evidence: Evidence;
  note: string | null;
}

export interface CandidateCost {
  /** `null` when the total could not be computed. Never render as 0. */
  total: string | null;
  totalExact: string | null;
  isComplete: boolean;
  unpriced: string[];
  /** A subtotal for known lines only. Never use it to rank an incomplete cost. */
  knownSubtotal?: string | null;
  items: CostItem[];
}

export interface Gate {
  name: string;
  status: GateStatus;
  reason: string | null;
  evidenceRef: string | null;
}

export interface Candidate {
  candidateId: string;
  target: Target;
  region: string;
  modelRef: string;
  instanceType: string | null;
  instanceCount: string;
  cmusPerCopy: string | null;
  scaleToZero: boolean;
  prewarmed: boolean;
  opsBurden: string;
  blastRadius: string;
  recipeId: string | null;
  notes: string | null;
  inferenceProfileId?: string | null;
  processingRegions?: string[];
  isFeasible: boolean;
  cost: CandidateCost | null;
  gates: Gate[];
  failureCount: number;
  unknownCount: number;
}

export interface Breakeven {
  breakevenDutyPercent: string | null;
  cmiActiveHourly: string | null;
  dedicatedHourly: string | null;
  actualDutyPercent: string | null;
  verdict: BreakevenVerdict;
  explanation: string | null;
  cmiComparedCandidate: string | null;
  dedicatedComparedCandidate: string | null;
}

export interface EvaluateCounts {
  ranked: number;
  unresolved: number;
  excluded: number;
}

/**
 * How latency was established, if at all.
 *
 * `NOT_REQUESTED` (no objective declared) and `MEASURED` (a benchmark ran) must
 * never be presented alike: the first earned nothing, the second earned
 * everything.
 */
export type LatencyStatus =
  | 'MEASURED'
  | 'SUPPLIED'
  | 'NOT_MEASURED'
  | 'NOT_REQUESTED';

export interface Qualification {
  /** Only true when an applicable benchmark run reference exists. */
  performanceMeasured: boolean;
  latencyStatus: LatencyStatus;
  sloRequested: boolean;
  benchmarkRunIds: string[];
  /** True when candidates ranked without measured latency evidence. */
  conditional: boolean;
  note: string | null;
}

/** An input the solver cannot act on, reported rather than dropped. */
export interface UnsupportedInput {
  field: string;
  value: string;
  reason: string;
}

export interface EvaluateResponse {
  outcome: Outcome;
  requestHash: string;
  snapshotHash: string;
  solverVersion: string;
  horizonHours: string;
  assumptions: string[];
  winner: Candidate | null;
  ranked: Candidate[];
  unresolved: Candidate[];
  excluded: Candidate[];
  counts: EvaluateCounts;
  breakeven: Breakeven | null;
  priceFreshness: Record<string, Freshness>;
  retrievedAt: string | null;
  cmiFamily: string | null;
  checksStipulated: boolean;
  latencyEvidenceProvenance: LatencyEvidenceProvenance;
  request: unknown;
  qualification: Qualification | null;
  /**
   * The literal payload the solver received.
   *
   * This — not a form snapshot — is the authoritative input identity. An advisor
   * patch or a strictness change can alter the evaluated request after any
   * snapshot was taken, so staleness is judged against what actually ran.
   */
  evaluatedRequest: EvaluatePayloadEcho | null;
  /** 32 hex chars over the solver-relevant fields only. Record identity. */
  evaluatedRequestHash: string | null;
  nativePricing?: NativePriceQuote[];
}

export interface NativePriceQuote {
  candidateId: string;
  modelId: string;
  region: string;
  inferenceProfileId: string | null;
  processingRegions: string[];
  inputRate: Rate | null;
  outputRate: Rate | null;
  missingUsage: string[];
  scope: string;
  retrievedAt: string;
  routingSource: string;
  pricingSource: string;
}

/**
 * The evaluate payload as echoed back by the runtime.
 *
 * Deliberately loose: chat and the form build this payload differently — chat
 * omits keys the user never set, the form sends them as `null` — so the shape is
 * normalised before comparison rather than assumed to match.
 */
export interface EvaluatePayloadEcho {
  caseId?: unknown;
  model?: unknown;
  workload?: unknown;
  slos?: unknown;
  constraints?: unknown;
  assumeChecksCleared?: unknown;
  latencyEvidence?: unknown;
  [key: string]: unknown;
}

/* --------------------------------------------------------- evaluate request */

export interface ModelSpecInput {
  name: string;
  architecture: string;
  modality: string;
  totalParamsB: string | null;
  contextTokens: number | null;
  precision: string;
  weightsGb: string | null;
  weightsExportable: boolean;
  licenseId: string | null;
  hfRepo: string | null;
  hfCommit?: string | null;
  artifactDigest?: string | null;
  sourceKind?: string | null;
  inferenceProfileId?: string | null;
}

export interface WorkloadSpecInput {
  horizonHours: string;
  billableCopyHours: string | null;
  dedicatedInstanceHours: string | null;
  scheduled: boolean;
  concurrency: number | null;
  description: string | null;
  requests?: string | null;
  inputTokensPerRequest?: string | null;
  outputTokensPerRequest?: string | null;
}

export interface SloInput {
  metric: string;
  thresholdMs: string;
  /**
   * Omitted for a metric whose name already names its percentile (p50/p95/p99),
   * where the backend derives it and rejects a contradicting value. Present only
   * for a first-token or first-audio objective, which has no inherent percentile.
   */
  percentile?: string;
  /** Whether the first request after idle counts. Sent explicitly, including false. */
  includeCold: boolean;
  errorBudgetFraction: string | null;
}

export interface ConstraintsInput {
  permittedRegions: string[];
  permittedProcessingRegions?: string[];
  budgetUsd: string | null;
  requireHeldCapacity: boolean;
  maxOpsBurden: string | null;
}

export interface LatencyEvidenceInput {
  p50Ms: string | null;
  p99Ms: string | null;
  coldStartMs: string | null;
  sampleCount: number | null;
  violationRateUpperBound: string | null;
}

export interface EvaluateRequest {
  qualification?: Record<string, string> | null;
  qualityGoal?: string | null;
  caseId: string;
  model: ModelSpecInput;
  workload: WorkloadSpecInput;
  slos: SloInput[];
  constraints: ConstraintsInput;
  assumeChecksCleared: boolean;
  latencyEvidence: Record<string, LatencyEvidenceInput> | null;
}

/* -------------------------------------------------------------------- chat */

/** Bedrock Converse content block. Only text is used by EDDIE. */
export interface ChatContentBlock {
  text: string;
}

/** One turn of history, in the Bedrock Converse shape. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ChatContentBlock[];
}

/** A tool the advisor called during a turn. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  status: 'success' | 'error' | string;
}

/**
 * The accumulated case the advisor maintains.
 *
 * Keys are the backend's `ADVISOR_WRITABLE_FIELDS`, which deliberately match
 * the form's own field names so a patch maps onto `CaseFormState` without a
 * translation table.
 */
export interface ChatCase {
  modelName?: string | null;
  architecture?: string | null;
  modality?: string | null;
  weightsExportable?: boolean | null;
  totalParamsB?: string | number | null;
  contextTokens?: string | number | null;
  weightsGb?: string | number | null;
  licenseId?: string | null;
  hfRepo?: string | null;
  horizonHours?: string | number | null;
  billableCopyHours?: string | number | null;
  description?: string | null;
  sloThresholdMs?: string | number | null;
  caseId?: string | null;
  [key: string]: unknown;
}

export interface ChatRequest {
  message: string;
  turnId: string;
  case: ChatCase;
  assumeChecksCleared: boolean;
}

export interface ChatTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

export interface AwsDocumentationReceipt {
  provider: string;
  affectsPlacement: false;
  checks: {
    topic: string;
    label: string;
    state: 'RETRIEVED' | 'PARTIAL' | 'UNAVAILABLE' | 'DISABLED' | 'NO_RESULTS';
    retrievedAt: string | null;
    sources: { id: string; title: string; url: string }[];
  }[];
}

export interface ChatResponse {
  awsDocumentation?: AwsDocumentationReceipt;
  sizingReport?: import('./sizing').SizingReport | null;
  turnId?: string;
  status?: 'COMPLETE' | 'CANCELLED' | 'FAILED';
  sessionExpiresAt?: number;
  replayed?: boolean;
  /** Markdown prose. `null` when the runtime had no messages to answer. */
  reply: string | null;
  case: ChatCase;
  /** Only the fields this turn changed. */
  casePatch: ChatCase;
  /**
   * The full `/evaluate` response, or `null` when the advisor did not
   * evaluate. Every number shown to the user comes from here, never from
   * parsing `reply`.
   */
  decision: EvaluateResponse | null;
  toolCalls: ToolCall[];
  rounds: number | null;
  /** True when the tool-call limit was hit, so the answer may be incomplete. */
  truncated: boolean;
  advisorModelId: string | null;
  usage: ChatTokenUsage | null;
  suggestedPrompts: string[] | null;
  provenance: string | null;
  /** The exact payload the solver received, so a user can confirm arrival. */
  evaluatedRequest: EvaluatePayloadEcho | null;
  /** Identity of that payload; also present on `decision`. */
  evaluatedRequestHash?: string | null;
  /** Inputs the solver could not act on. Shown before any recommendation. */
  unsupportedInputs: UnsupportedInput[] | null;
  /** True when the user's "do not assume those checks pass" was honoured. */
  strictRequestedByAdvisor: boolean;
  detail?: string | null;
}

export interface ChatHistory {
  turns: {
    awsDocumentation?: AwsDocumentationReceipt | null;
    turnId: string;
    sequence?: number;
    prompt: string;
    reply: string | null;
    startedAt: number;
    status: 'RUNNING' | 'COMPLETE' | 'CANCELLED' | 'FAILED' | 'INTERRUPTED';
    casePatch: ChatCase;
    advisorModelId: string | null;
  }[];
  activeTurnId: string | null;
  expiresAt: number | null;
  nextBeforeSequence?: number | null;
}


/* --------------------------------------------------------------- inspection */

/**
 * One inspected model property. Mirrors `Detected.to_json` in the backend.
 *
 * `value` is null exactly when `origin` is not DETECTED. Do not substitute a
 * default: an undetected weights size must stay undetected, because a guessed one
 * changes which instances look feasible.
 */
export interface InspectedField {
  origin: 'DETECTED' | 'NOT_DETECTED' | 'NOT_APPLICABLE';
  value: string | null;
  detail: string | null;
  sourceUrl: string | null;
}

/** Access state of a model source. GATED is an action for the user, not an error. */
export type AccessState =
  | 'PUBLIC'
  | 'GATED'
  | 'PRIVATE'
  | 'AUTHENTICATION_REQUIRED'
  | 'UNKNOWN';

/** Mirrors `ModelInspection.to_json` in the backend. */
export interface ModelInspectionResult {
  inference?: Record<string, unknown> | null;
  source: string;
  repo: string;
  /** The resolved commit, not a branch: values are only valid for this revision. */
  revision: string | null;
  retrievedAt: string;
  ok: boolean;
  error: string | null;
  access: AccessState;
  accessDetail: string | null;
  weightFiles: number;
  notes: string[];
  fields: {
    architecture: InspectedField;
    modality?: InspectedField;
    totalParamsB: InspectedField;
    contextTokens: InspectedField;
    weightsGb: InspectedField;
    precision: InspectedField;
    licenseId: InspectedField;
  };
  checkpoint?: {
    source: string;
    name: string;
    revision: string;
    manifestVersionId: string;
    artifactFormat: 'full-checkpoint' | 'merged-checkpoint';
    customization: 'fine-tuned';
    baseModel: { source: string; revision: string };
    lineage: { trainingRun: string; trainingDataSha256: string };
    lineageStatus: 'SUPPLIED';
    fullContentVerified: boolean;
  };
}

export interface CheckpointLibrary {
  checkpoints: { source: string; label: string; library: string }[];
  truncated: boolean;
  note: string;
}

/* -------------------------------------------------------------- deployments */

/** One resource EDDIE created, as the ledger records it. */
export interface LedgerEntryView {
  entryId: string;
  jobId: string;
  projectId: string;
  kind: string;
  state:
    | 'INTENDED'
    | 'CREATED'
    | 'DELETING'
    | 'DELETED'
    | 'DELETE_UNCONFIRMED'
    | 'RETAINED';
  region: string;
  accountId: string;
  physicalId: string | null;
  plannedName: string | null;
  arn: string | null;
  residualCostNote: string | null;
  hourlyUsd: string | null;
  /** True when AWS may still be charging for it. */
  billable: boolean;
  expiresAt: string | null;
}

export interface DeploymentStepView {
  name: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  detail: string;
}

export interface DeploymentView {
  modelRef?: string;
  modelRevision?: string;
  region?: string;
  hourlyUsd?: string;
  kind?: string;
  performanceQualified?: boolean;
  invocationReceipt?: InvocationReceipt | null;
  jobId: string;
  planId: string;
  projectId: string;
  target: string;
  state:
    | 'PENDING'
    | 'RUNNING'
    | 'EXPERIMENTAL'
    | 'READY'
    | 'FAILED'
    | 'DELETING'
    | 'DELETED'
    | 'CLEANUP_INCOMPLETE';
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  resourceExpiresAt: string;
  resourcesExpired: boolean;
  steps: DeploymentStepView[];
  resources: LedgerEntryView[];
  billableResourceCount: number;
  failureReason: string | null;
  publishedRoute: string | null;
}

/** What this installation can actually execute, per target. */
export interface DeploymentCapability {
  targets: {
    target: string;
    label: string;
    available: boolean;
    reason: string;
  }[];
  canCreatePlans: boolean;
  checkpointRecipe?: {
    id: string; version: string; available: boolean;
    maximumModelGiB: number; architectures: string[]; targets: string[]; note: string;
  };
  recipes?: { id: string; version: string; models: string[]; region: string; instanceType: string; maximumLifetimeMinutes: number }[];
  note: string;
}

export interface ResidualReport {
  ownedBillableCount: number;
  byKind: Record<string, number>;
  estimatedHourlyUsd: number;
  entries: LedgerEntryView[];
  note: string;
}

export interface DeploymentListResponse {
  deployments: DeploymentView[];
  residual: ResidualReport | null;
  capability: DeploymentCapability;
  storeConfigured: boolean;
}

export interface DeploymentGetResponse {
  deployment: DeploymentView;
  resources: LedgerEntryView[];
}


/** A real, immutable, server-prepared trial, with checks rather than hidden assumptions. */
export interface DeploymentPlan {
  startedJobId?: string | null;
  planId: string;
  planHash: string;
  modelRef: string;
  target: string;
  kind: string;
  accountId: string;
  region: string;
  expiresAt: string;
  expired: boolean;
  approvable: boolean;
  evaluatedRequestHash?: string | null;
  envelope: {
    instanceType: string;
    maxInstanceCount: number;
    maxSpendUsd: string;
    maxLifetimeMinutes: number;
    executionDeadlineMinutes: number;
  };
  estimatedHourlyUsd: string;
  estimatedSetupUsd: string;
  checks: { checkId: string; status: string; expectedControl: string; observedResult: string }[];
  blockers: { checkId: string; status: string; expectedControl: string; observedResult: string }[];
  notes: string[];
}

export interface DeploymentPlanReview {
  plan: DeploymentPlan;
  model: { source: string; revision: string; license: string; licenseUrl: string; bytes: number };
  cost: {
    hostingEstimateUsd: string;
    hourlyUsd: string;
    admissionEstimateUsd: string;
    additionalAllowanceUsd: string;
    cleanupBufferMinutes: number;
    priceEvidence: { amount: string; unit: string; sku: string; source: string; retrievedAt: string };
  };
}

export interface TestDeploymentRequest {
  source: string;
  target?: string;
  revision?: string;
  region: string;
  lifetimeMinutes: number;
  maxSpendUsd: string;
  caseFingerprint?: string;
}

export interface InvocationReceipt {
  runId: string;
  at: string;
  model: string;
  revision: string;
  jobId: string;
  elapsedMs: string;
  metric: 'single_request_end_to_end_ms';
  sampleCount: number;
  percentileQualified: boolean;
  qualityQualified: boolean;
  promptStored: boolean;
  outputStored: boolean;
}

export interface TestInvocationResponse {
  output: string;
  receipt: InvocationReceipt;
}
