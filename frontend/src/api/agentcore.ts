import type { DeploymentPlanReview, DeploymentPlan, DeploymentView, TestDeploymentRequest, TestInvocationResponse } from './types';
import type { ProjectDocument, SavedProject } from '../state/persistence';
import type {
  AgentAction,
  CatalogResponse,
  ChatRequest,
  ChatHistory,
  ChatResponse,
  DemoStatusResponse,
  EvaluateRequest,
  EvaluateResponse,
  HealthResponse,
  KnowledgePayload,
  DeploymentGetResponse,
  DeploymentListResponse,
  KnowledgeResponse,
  ModelInspectionResult,
  RatesPayload,
  RatesResponse,
  RuntimeConfig,
  StreamEvent,
} from './types';

/** An error carrying the runtime's structured `{error, detail}` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  /**
   * True when the coordinator handled the request and reported a failure in
   * its envelope (`ok: false`). Such a `detail` is written to be shown to the
   * user verbatim and names the offending field.
   */
  readonly handled: boolean;

  constructor(status: number, code: string, detail: string, handled = false) {
    super(detail || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.handled = handled;
  }
}

/** Raised when the caller has no usable access token, or the runtime rejects it. */
export class NotAuthenticatedError extends ApiError {
  constructor(detail = 'You are signed out. Sign in again to continue.') {
    super(401, 'not_authenticated', detail);
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * HTTP 424 from AgentCore. The service replaces the container's own non-2xx
 * response with a generic body and discards the detail, so there is nothing
 * specific to show and nothing to parse.
 */
export class CoordinatorFailureError extends ApiError {
  constructor() {
    super(
      424,
      'coordinator_failure',
      'The EDDIE coordinator reported an error. AgentCore does not pass the underlying detail through, so no specific cause is available here — check the runtime CloudWatch logs.',
      false
    );
    this.name = 'CoordinatorFailureError';
  }
}

/**
 * HTTP 400 from AgentCore itself, before the container ran — for example a
 * `runtimeSessionId` shorter than the 33-character minimum.
 */
export class InvalidInvocationError extends ApiError {
  constructor(detail: string) {
    super(400, 'invalid_invocation', detail, false);
    this.name = 'InvalidInvocationError';
  }
}

/** Supplies a fresh Cognito access token for each invocation. */
export type AccessTokenProvider = () => Promise<string | null>;

/**
 * AgentCore Runtime invocation URL. The ARN contains `/` and `:`, so it must
 * be percent-encoded into the single path segment the service expects.
 */
export function invocationUrl(config: RuntimeConfig): string {
  // Local development still uses real Cognito authentication. This branch is
  // removed by the production build; runtime config cannot redirect credentials.
  if (import.meta.env.DEV && import.meta.env.VITE_EDDIE_LOCAL_RUNTIME === '1') {
    return '/_eddie/invocations';
  }
  const encodedArn = encodeURIComponent(config.agentRuntimeArn);
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com` +
    `/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`
  );
}

const SESSION_STORAGE_KEY = 'eddie.agentcore-session-id';
const SESSION_SCOPE_KEY = 'eddie.agentcore-session-scope';

/** AgentCore rejects a shorter `runtimeSessionId` with a hard HTTP 400. */
export const MIN_SESSION_ID_LENGTH = 33;

/**
 * Build a session id that satisfies AgentCore's 33-character minimum. It is
 * stable within one application release. AgentCore keeps an existing transport
 * session on its original runtime version, even after DEFAULT is updated.
 * Conversation identity and saved messages live in DynamoDB, independently of
 * this transport identifier.
 */
export function createSessionId(): string {
  const random = () => {
    try {
      if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID().replace(/-/g, '');
      }
    } catch {
      /* fall through to Math.random */
    }
    return Math.random().toString(36).slice(2).padEnd(16, '0');
  };
  // `eddie-` + 32 hex characters = 38 characters, comfortably over the limit.
  let id = `eddie-${random()}`;
  while (id.length < MIN_SESSION_ID_LENGTH) id += random();
  return id;
}

export function getOrCreateSessionId(config: RuntimeConfig): string {
  const scope = JSON.stringify([
    config.agentRuntimeArn, config.region, config.releaseId,
    config.userPoolId, config.userPoolClientId,
  ]);
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (
      window.sessionStorage.getItem(SESSION_SCOPE_KEY) === scope &&
      existing && existing.length >= MIN_SESSION_ID_LENGTH
    ) return existing;
    const created = createSessionId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    window.sessionStorage.setItem(SESSION_SCOPE_KEY, scope);
    return created;
  } catch {
    // sessionStorage unavailable — a per-instance id still satisfies the API.
    return createSessionId();
  }
}

export function resetSessionId(): void {
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_SCOPE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export type ResponseOutcome<T> =
  | { kind: 'ok'; result: T; elapsedMs: number | null }
  | { kind: 'error'; error: ApiError };

/**
 * Interpret an invocation response.
 *
 * The branching rule is deliberate: **`ok`, not the HTTP status, decides
 * whether the operation succeeded.** AgentCore rewrites any non-2xx container
 * response into a generic HTTP 424 body and throws the detail away, so the
 * coordinator answers HTTP 200 even for validation failures and carries the
 * outcome in the envelope. A genuine non-2xx therefore means a transport or
 * authorization problem, never a validation problem.
 */
export function interpretResponse<T>(
  status: number,
  text: string
): ResponseOutcome<T> {
  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  // Transport and authorization failures, before the envelope matters.
  if (status === 401 || status === 403) {
    return {
      kind: 'error',
      error: new NotAuthenticatedError(
        'The runtime rejected your credentials. Refreshing the session, then signing in again, will resolve this.'
      ),
    };
  }
  if (status === 424) {
    // The underlying detail is discarded by AgentCore; do not invent one.
    return { kind: 'error', error: new CoordinatorFailureError() };
  }
  if (status === 400) {
    const body = (parsed ?? {}) as Partial<{ message: string; detail: string }>;
    return {
      kind: 'error',
      error: new InvalidInvocationError(
        body.detail ??
          body.message ??
          'AgentCore rejected the invocation envelope. This usually means a malformed request or a runtime session id shorter than 33 characters.'
      ),
    };
  }
  if (status < 200 || status >= 300) {
    const body = (parsed ?? {}) as Partial<{ message: string }>;
    return {
      kind: 'error',
      error: new ApiError(
        status,
        'transport_error',
        body.message ?? `The runtime returned HTTP ${status}.`
      ),
    };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return {
      kind: 'error',
      error: new ApiError(
        status,
        'invalid_response',
        'The runtime returned a response that was not valid JSON.'
      ),
    };
  }

  const envelope = parsed as Partial<{
    action: string;
    ok: boolean;
    error: string;
    detail: string;
    result: T;
    elapsedMs: number;
  }>;

  // A handled failure. `detail` is user-facing and names the offending field,
  // so it is surfaced verbatim rather than replaced by a generic message.
  if (envelope.ok === false) {
    // An older, still-running AgentCore session may not know newly shipped
    // actions. Do not show its developer-facing dispatch table or retry a turn.
    if (typeof envelope.detail === 'string' && envelope.detail.startsWith('action must be one of ')) {
      return {
        kind: 'error',
        error: new ApiError(
          status,
          'runtime_version_mismatch',
          'This browser is connected to an older EDDIE session. Keep a copy of unsaved changes, then reload the page to reconnect.',
          true
        ),
      };
    }
    return {
      kind: 'error',
      error: new ApiError(
        status,
        envelope.error ?? 'internal_error',
        envelope.detail ?? 'The coordinator reported a failure without a detail.',
        true
      ),
    };
  }

  if (envelope.ok !== true || !('result' in envelope) || envelope.result === undefined) {
    return {
      kind: 'error',
      error: new ApiError(
        status,
        'invalid_envelope',
        'The runtime response did not confirm success with a result.'
      ),
    };
  }

  return {
    kind: 'ok',
    result: envelope.result as T,
    elapsedMs:
      typeof envelope.elapsedMs === 'number' ? envelope.elapsedMs : null,
  };
}

export interface AgentCoreClientOptions {
  config: RuntimeConfig;
  getAccessToken: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  sessionId?: string;
}

/**
 * Transport for the EDDIE coordinator on AgentCore Runtime.
 *
 * Every call POSTs `{action, payload}` and unwraps the
 * `{action, result, elapsedMs}` envelope, so callers see the same result
 * shapes the solver produces.
 */
export class AgentCoreClient {
  readonly config: RuntimeConfig;
  readonly sessionId: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  /** Elapsed server time reported by the most recent invocation. */
  lastElapsedMs: number | null = null;

  constructor(options: AgentCoreClientOptions) {
    this.config = options.config;
    this.getAccessToken = options.getAccessToken;
    // `fetch` must stay bound to the global object. Storing the bare reference and
    // calling it as `this.fetchImpl(...)` sets `this` to the client instance, which
    // the browser rejects with "Failed to execute 'fetch' on 'Window': Illegal
    // invocation". Injected test doubles are plain functions and need no binding.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sessionId = options.sessionId ?? getOrCreateSessionId(this.config);
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    if (!token) throw new NotAuthenticatedError();
    return {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': this.sessionId,
    };
  }

  /** Invoke an action and return its unwrapped result. */
  async invoke<T>(
    action: AgentAction,
    payload: unknown = {},
    signal?: AbortSignal
  ): Promise<T> {
    const url = invocationUrl(this.config);
    const headers = await this.headers();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, payload }),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ApiError(
        0,
        'network_error',
        `Could not reach the EDDIE runtime in ${this.config.region}. ${
          cause instanceof Error ? cause.message : 'Unknown network failure.'
        }`
      );
    }

    const text = await response.text();
    const outcome = interpretResponse<T>(response.status, text);
    if (outcome.kind === 'error') throw outcome.error;
    this.lastElapsedMs = outcome.elapsedMs;
    return outcome.result;
  }

  /**
   * Invoke an action with `stream: true` and yield each server-sent event.
   *
   * A broken stream is never automatically resubmitted: work may already have
   * run. Restore the saved turn to recover its outcome.
   */
  async invokeStream<T>(
    action: AgentAction,
    payload: unknown,
    onEvent: (event: StreamEvent<T>) => void,
    signal?: AbortSignal
  ): Promise<T> {
    const url = invocationUrl(this.config);
    const headers = await this.headers();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream' },
        body: JSON.stringify({ action, payload, stream: true }),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ApiError(
        0,
        'network_error',
        `Could not reach the EDDIE runtime in ${this.config.region}. ${
          cause instanceof Error ? cause.message : 'Unknown network failure.'
        }`
      );
    }

    // Non-2xx on a streaming call is a transport/authorization problem and is
    // classified by exactly the same rules as a unary call.
    if (!response.ok) {
      const text = await response.text();
      const outcome = interpretResponse<T>(response.status, text);
      throw outcome.kind === 'error'
        ? outcome.error
        : new ApiError(
            response.status,
            'transport_error',
            `The runtime returned HTTP ${response.status}.`
          );
    }

    // The coordinator may answer a streaming request with an ordinary JSON
    // envelope — notably a handled `ok: false` failure, which never streams.
    // Detecting that here keeps the validation detail intact instead of
    // reporting it as an incomplete stream.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text();
      const outcome = interpretResponse<T>(response.status, text);
      if (outcome.kind === 'error') throw outcome.error;
      this.lastElapsedMs = outcome.elapsedMs;
      return outcome.result;
    }

    if (!response.body) {
      throw new ApiError(
        response.status,
        'stream_unsupported',
        'This browser returned no readable stream for the invocation.'
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let result: T | null = null;
    let sawResult = false;

    /**
     * Handle one parsed frame. An `error` frame is a handled coordinator
     * failure, so its `detail` is surfaced verbatim exactly like an
     * `ok: false` envelope.
     */
    const handleFrame = (frame: string) => {
      if (frame.length > 4 * 1024 * 1024) {
        throw new ApiError(200, 'invalid_stream', 'The answer stream contained an oversized frame.');
      }
      const event = parseSseFrame<T>(frame);
      if (!event) return;
      if (event.event === 'result' || event.event === 'complete') {
        const outcome = interpretResponse<T>(200, JSON.stringify(event));
        if (outcome.kind === 'error') throw outcome.error;
        sawResult = true;
        result = outcome.result;
        this.lastElapsedMs = outcome.elapsedMs;
      }
      if (event.event === 'error') {
        throw new ApiError(
          200,
          event.error ?? 'internal_error',
          event.detail ?? event.message ?? 'The coordinator reported an error.',
          true
        );
      }
      onEvent(event);
    };

    const consume = () => {
      // Accept LF and CRLF, including delimiters split across network chunks.
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        handleFrame(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > 4 * 1024 * 1024) {
        throw new ApiError(200, 'invalid_stream', 'The answer stream contained an oversized frame.');
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          consume();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        consume();
      }
      // A truncated final frame is not a successful completion.
      if (buffer.trim()) throw new ApiError(200, 'incomplete_stream',
        'The connection ended during an answer. Partial text is preserved. Check the saved answer before sending again.');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (!sawResult || result === null) {
      throw new ApiError(
        200,
        'incomplete_stream',
        'The connection ended before completion. Partial text is preserved. Check the saved answer before sending again.'
      );
    }
    return result;
  }

  /* ------------------------------------------------------------- actions */

  getSavedProject(caseId: string, signal?: AbortSignal) {
    return this.invoke<{ project: SavedProject | null; removed?: boolean }>('case.get', { caseId }, signal);
  }

  saveProject(caseId: string, document: ProjectDocument, expectedRevision: string | null) {
    return this.invoke<{ project: SavedProject }>('case.save', { caseId, document, expectedRevision });
  }

  removeProject(caseId: string, expectedRevision: string | null) {
    return this.invoke<{ caseId: string; removed: boolean }>('case.remove', { caseId, expectedRevision });
  }

  listSavedProjects(signal?: AbortSignal, afterCaseId?: string) {
    return this.invoke<{
      projects: Omit<SavedProject, 'document'>[];
      removedCaseIds?: string[];
      hasMore: boolean;
      nextCaseId?: string | null;
    }>('case.list', afterCaseId ? { afterCaseId } : {}, signal);
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.invoke<HealthResponse>('health', {}, signal);
  }

  rates(payload: RatesPayload = {}, signal?: AbortSignal): Promise<RatesResponse> {
    return this.invoke<RatesResponse>('rates', payload, signal);
  }

  catalogModels(signal?: AbortSignal, region?: string): Promise<CatalogResponse> {
    return this.invoke<CatalogResponse>('catalog', region ? { region } : {}, signal);
  }

  /**
   * Deployments in the caller's project, with what is still chargeable.
   *
   * Authorization is server-side: the coordinator resolves the project from the
   * verified token, so there is no project parameter to tamper with here.
   */
  listDeployments(signal?: AbortSignal): Promise<DeploymentListResponse> {
    return this.invoke<DeploymentListResponse>('deployment.list', {}, signal);
  }

  prepareTestDeployment(request: TestDeploymentRequest): Promise<DeploymentPlanReview> {
    return this.invoke<DeploymentPlanReview>('plan.create', request);
  }

  getDeploymentPlan(planId: string): Promise<DeploymentPlanReview> {
    return this.invoke<DeploymentPlanReview>('plan.get', { planId });
  }

  listDeploymentPlans(): Promise<{ plans: DeploymentPlan[] }> {
    return this.invoke('plan.list');
  }

  approveTestDeployment(plan: DeploymentPlan): Promise<{ deployment: DeploymentView; created: boolean }> {
    return this.invoke('plan.approve', {
      planId: plan.planId, planHash: plan.planHash,
      acknowledgeCost: true, modelTermsReviewed: true,
    });
  }

  invokeTestDeployment(jobId: string, text: string, maxTokens = 128): Promise<TestInvocationResponse> {
    return this.invoke('deployment.invoke', { jobId, text, maxTokens });
  }

  synthesizeTestSpeech(jobId: string, text: string, speaker: string): Promise<TestInvocationResponse> {
    return this.invoke('deployment.invoke', { jobId, text, speaker });
  }

  removeTestDeployment(jobId: string): Promise<{ deployment: DeploymentView }> {
    return this.invoke('deployment.delete', { jobId });
  }

  getDeployment(
    jobId: string,
    signal?: AbortSignal
  ): Promise<DeploymentGetResponse> {
    return this.invoke<DeploymentGetResponse>('deployment.get', { jobId }, signal);
  }

  /**
   * Read a model's published properties from its source.
   *
   * Runs server-side: the browser cannot reach Hugging Face under this app's
   * origin, and the result has to be attributable to EDDIE rather than to
   * whatever a page script chose to report.
   */
  inspectModel(
    source: string,
    revision?: string,
    signal?: AbortSignal
  ): Promise<ModelInspectionResult> {
    return this.invoke<ModelInspectionResult>(
      'inspect_model',
      revision ? { source, revision } : { source },
      signal
    );
  }

  listCheckpoints(signal?: AbortSignal) {
    return this.invoke<import('./types').CheckpointLibrary>('checkpoint.list', {}, signal);
  }

  inspectCheckpoint(source: string, signal?: AbortSignal): Promise<ModelInspectionResult> {
    return this.invoke<ModelInspectionResult>('checkpoint.inspect', { source }, signal);
  }

  evaluate(
    body: EvaluateRequest,
    signal?: AbortSignal
  ): Promise<EvaluateResponse> {
    return this.invoke<EvaluateResponse>('evaluate', body, signal);
  }

  /**
   * Streaming evaluate. Price collection takes several seconds, so the user
   * sees the runtime's own progress messages rather than a blank spinner.
   */
  evaluateStream(
    body: EvaluateRequest,
    onEvent: (event: StreamEvent<EvaluateResponse>) => void,
    signal?: AbortSignal
  ): Promise<EvaluateResponse> {
    return this.invokeStream<EvaluateResponse>(
      'evaluate',
      body,
      onEvent,
      signal
    );
  }

  /**
   * Conversational intake and explanation.
   *
   * The reply is prose; the `decision` in the same response is the structured
   * solver output the UI renders its numbers from.
   */
  chat(body: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.invoke<ChatResponse>('chat', body, signal);
  }

  async chatHistory(caseId: string, signal?: AbortSignal, beforeSequence?: number): Promise<ChatHistory> {
    const history = await this.invoke<ChatHistory>('chat.history',
      { caseId, ...(beforeSequence !== undefined ? { beforeSequence } : {}) }, signal);
    if (!history || !Array.isArray(history.turns) ||
        !(history.activeTurnId === null || typeof history.activeTurnId === 'string') ||
        !(history.expiresAt === null || Number.isFinite(history.expiresAt)) ||
        !(history.nextBeforeSequence == null ||
          (Number.isInteger(history.nextBeforeSequence) && history.nextBeforeSequence > 0)) ||
        history.turns.some((turn) => !turn || typeof turn.turnId !== 'string' ||
          (turn.sequence !== undefined && !Number.isInteger(turn.sequence)) ||
          typeof turn.prompt !== 'string' || !Number.isFinite(turn.startedAt) ||
          !(turn.reply === null || typeof turn.reply === 'string') ||
          !['RUNNING', 'COMPLETE', 'CANCELLED', 'FAILED', 'INTERRUPTED'].includes(turn.status))) {
      throw new ApiError(200, 'invalid_history',
        'The saved conversation could not be read. Your current conversation has been kept.');
    }
    return history;
  }

  cancelChat(caseId: string, turnId: string, signal?: AbortSignal): Promise<{ requested: boolean; detail: string }> {
    return this.invoke('chat.cancel', { caseId, turnId }, signal);
  }

  /**
   * Streaming chat. A turn runs live price collection and can take 10–30
   * seconds, so the runtime's own progress messages are surfaced instead of a
   * spinner that says nothing.
   */
  chatStream(
    body: ChatRequest,
    onEvent: (event: StreamEvent<ChatResponse>) => void,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    return this.invokeStream<ChatResponse>('chat', body, onEvent, signal);
  }

  knowledge(
    payload: KnowledgePayload,
    signal?: AbortSignal
  ): Promise<KnowledgeResponse> {
    return this.invoke<KnowledgeResponse>('knowledge', payload, signal);
  }

  demoStatus(signal?: AbortSignal): Promise<DemoStatusResponse> {
    return this.invoke<DemoStatusResponse>('demo.status', {}, signal);
  }

  demoWake(signal?: AbortSignal): Promise<DemoStatusResponse> {
    return this.invoke<DemoStatusResponse>('demo.wake', {}, signal);
  }

  demoSleep(signal?: AbortSignal): Promise<DemoStatusResponse> {
    return this.invoke<DemoStatusResponse>('demo.sleep', {}, signal);
  }
}

/** Parse one SSE frame into a typed event, ignoring comments and blanks. */
export function parseSseFrame<T>(frame: string): StreamEvent<T> | null {
  const dataLines: string[] = [];
  let eventName = '';
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return { event: 'end' };
  try {
    const parsed = JSON.parse(payload) as StreamEvent<T>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.event && eventName) parsed.event = eventName as StreamEvent<T>['event'];
    if (!parsed.event) return null;
    return parsed;
  } catch {
    throw new ApiError(200, 'invalid_stream', 'An answer frame could not be read. The turn was not restarted.');
  }
}
