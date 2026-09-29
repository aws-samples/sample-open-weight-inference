import type { ReactNode } from 'react';
import { DEFAULT_FORM, type CaseFormState } from '../state/caseForm';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AgentCoreClient } from '../api/agentcore';
import type { AgentAction, RuntimeConfig } from '../api/types';
import { AuthProvider } from '../auth/AuthContext';
import {
  AuthError,
  type AuthClient,
  type AuthSession,
  type SignInOutcome,
} from '../auth/types';
import { NotificationsProvider } from '../state/NotificationsContext';
import { AppProvider } from '../state/AppContext';
import { CaseProvider } from '../state/CaseContext';
import { ChatProvider } from '../state/ChatContext';
import { ConversationsProvider } from '../state/ConversationsContext';
import { ResultKpiRow } from '../components/KpiCards';
import { RequirementsForm } from '../components/RequirementsForm';
import { ResultsPanel } from '../components/ResultsPanel';
import { useCase } from '../state/CaseContext';
import { DetailPanelProvider } from '../state/DetailPanelContext';
import { configFixture } from './fixtures';

/** A session that is valid for an hour, like a real Cognito access token. */
export function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    username: 'test-user',
    email: 'test-user@example.test',
    sub: 'sub-test-user-0001',
    accessToken: 'access-token-1',
    idToken: 'id-token-1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

export interface FakeAuthOptions {
  /** Session to restore on mount; `null` renders the sign-in screen. */
  initial?: AuthSession | null;
  signInOutcome?: SignInOutcome | (() => Promise<SignInOutcome>);
  mfaOutcome?: SignInOutcome;
  newPasswordOutcome?: SignInOutcome;
  refreshResult?: AuthSession | (() => Promise<AuthSession>);
  signInError?: AuthError;
}

/** An `AuthClient` that never touches Cognito, with call counters. */
export class FakeAuthClient implements AuthClient {
  readonly calls = {
    restore: 0,
    signIn: 0,
    respondToMfa: 0,
    completeNewPassword: 0,
    refresh: 0,
    signOut: 0,
  };
  private readonly options: FakeAuthOptions;

  constructor(options: FakeAuthOptions = {}) {
    this.options = options;
  }

  async restore(): Promise<AuthSession | null> {
    this.calls.restore += 1;
    return this.options.initial ?? null;
  }

  async signIn(): Promise<SignInOutcome> {
    this.calls.signIn += 1;
    if (this.options.signInError) throw this.options.signInError;
    const outcome = this.options.signInOutcome;
    if (typeof outcome === 'function') return outcome();
    return outcome ?? { status: 'SIGNED_IN', session: makeSession() };
  }

  async respondToMfa(): Promise<SignInOutcome> {
    this.calls.respondToMfa += 1;
    return (
      this.options.mfaOutcome ?? { status: 'SIGNED_IN', session: makeSession() }
    );
  }

  async completeNewPassword(): Promise<SignInOutcome> {
    this.calls.completeNewPassword += 1;
    return (
      this.options.newPasswordOutcome ?? {
        status: 'SIGNED_IN',
        session: makeSession(),
      }
    );
  }

  async refresh(): Promise<AuthSession> {
    this.calls.refresh += 1;
    const result = this.options.refreshResult;
    if (typeof result === 'function') return result();
    if (result) return result;
    return makeSession({ accessToken: `refreshed-${this.calls.refresh}` });
  }

  async signOut(): Promise<void> {
    this.calls.signOut += 1;
  }
}

export interface RecordedInvocation {
  action: string;
  payload: unknown;
  stream: boolean;
  headers: Record<string, string>;
  url: string;
}

export type ActionHandler = (
  action: string,
  payload: unknown,
  stream: boolean
) => Response | Promise<Response>;

/** Build a `{action, ok, result, elapsedMs}` success body. */
export function okEnvelope(action: string, result: unknown, status = 200): Response {
  // Existing component fixtures predate account persistence. An explicit empty
  // fixture means an empty account, not an invalid wire shape. Tests of saving
  // and restoration supply full responses or handled failures instead.
  if (result && typeof result === 'object' && Object.keys(result).length === 0) {
    if (action === 'case.get') result = { project: null };
    if (action === 'case.list') result = { projects: [], hasMore: false };
    if (action === 'chat.history') result = { turns: [], activeTurnId: null, expiresAt: null };
    if (action === 'chat.cancel') result = { requested: true, detail: 'Stop requested.' };
  }
  return new Response(
    JSON.stringify({ action, ok: true, result, elapsedMs: 1958.6 }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Build a handled-failure body. Note: HTTP 200, `ok: false`. */
export function failEnvelope(
  action: string,
  error: string,
  detail: string
): Response {
  return new Response(JSON.stringify({ action, ok: false, error, detail }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build the generic body AgentCore substitutes for a container failure. */
export function agentCore424(): Response {
  return new Response(
    JSON.stringify({
      message:
        'Received error (400) from runtime. Please check your CloudWatch logs for more information.',
    }),
    { status: 424, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Serve an action as an SSE stream, mirroring the runtime's streaming contract.
 * Chat and evaluate both stream, so tests exercise the real code path.
 */
export function sseFrames(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Stream a single successful result frame. */
export function streamOnce(result: unknown): Response {
  return sseFrames([
    JSON.stringify({ event: 'start' }),
    JSON.stringify({ event: 'result', ok: true, result }),
    JSON.stringify({ event: 'end' }),
  ]);
}

/** A fetch stand-in that records invocations and dispatches by action. */
export function recordingTransport(handler: ActionHandler): {
  fetchImpl: typeof fetch;
  invocations: RecordedInvocation[];
} {
  const invocations: RecordedInvocation[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    invocations.push({
      action: body.action,
      payload: body.payload,
      stream: body.stream === true,
      headers,
      url,
    });
    return handler(body.action, body.payload, body.stream === true);
  }) as typeof fetch;
  return { fetchImpl, invocations };
}

/** Default handler: fixture responses for the read-only actions. */
export function defaultHandler(
  responses: Partial<Record<AgentAction, unknown>>
): ActionHandler {
  return (action) => {
    if (action in responses) {
      return okEnvelope(action, responses[action as AgentAction]);
    }
    return failEnvelope(
      action,
      'unknown_action',
      `No fixture is registered for action "${action}".`
    );
  };
}

export interface RenderAppOptions {
  route?: string;
  auth?: FakeAuthClient;
  config?: RuntimeConfig;
  handler?: ActionHandler;
  /** Wrap in CaseProvider (needed for the workspace and comparison views). */
  withCase?: boolean;
  caseId?: string;
  /** Most legacy contracts use an explicit Llama example. Novice tests pass EMPTY_PROJECT. */
  initialForm?: CaseFormState;
  /** Wrap in CaseProvider + ChatProvider (needed for the chat view). */
  withChat?: boolean;
}

/**
 * Render children inside the full provider stack with a fake auth client and a
 * fixture transport. No network access occurs.
 */
export function renderWithProviders(
  ui: ReactNode,
  options: RenderAppOptions = {}
) {
  const config = options.config ?? configFixture;
  const auth = options.auth ?? new FakeAuthClient({ initial: makeSession() });
  const { fetchImpl, invocations } = recordingTransport(
    options.handler ?? defaultHandler({})
  );
  const client = new AgentCoreClient({
    config,
    getAccessToken: async () => 'access-token-1',
    fetchImpl,
    sessionId: 'eddie-testsessionidtestsessionidtest01',
  });

  const tree = (
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <NotificationsProvider>
        <AuthProvider client={auth}>
          <AppProvider config={config} client={client}>
            {/*
              ConversationsProvider wraps everything because AppShell reads saved
              conversations for its sidebar. It is above the case/chat providers so a
              test that renders only the shell still works.
            */}
            <ConversationsProvider>
              <DetailPanelProvider>
                {options.withChat ? (
                  <CaseProvider caseId={options.caseId} initialForm={options.initialForm ?? DEFAULT_FORM}>
                    <ChatProvider>{ui}</ChatProvider>
                  </CaseProvider>
                ) : options.withCase ? (
                  <CaseProvider caseId={options.caseId} initialForm={options.initialForm ?? DEFAULT_FORM}>{ui}</CaseProvider>
                ) : (
                  ui
                )}
              </DetailPanelProvider>
            </ConversationsProvider>
          </AppProvider>
        </AuthProvider>
      </NotificationsProvider>
    </MemoryRouter>
  );

  return { ...render(tree), client, auth, invocations, config };
}

/**
 * Assert a Cloudscape button is disabled.
 *
 * A Cloudscape button with `disabledReason` stays focusable and uses
 * `aria-disabled` plus a described-by reason, rather than the native
 * `disabled` attribute — that is deliberate so the reason is reachable by
 * keyboard and screen reader. `toBeDisabled()` would therefore fail on a
 * correctly-implemented disabled-with-reason control.
 */
export function expectDisabled(element: HTMLElement) {
  const nativelyDisabled =
    element.hasAttribute('disabled') ||
    element.getAttribute('aria-disabled') === 'true';
  if (!nativelyDisabled) {
    throw new Error(
      `Expected the control to be disabled, but it was enabled. Markup: ${element.outerHTML.slice(
        0,
        200
      )}`
    );
  }
}

/** Assert a Cloudscape button is enabled. */
export function expectEnabled(element: HTMLElement) {
  if (
    element.hasAttribute('disabled') ||
    element.getAttribute('aria-disabled') === 'true'
  ) {
    throw new Error('Expected the control to be enabled, but it was disabled.');
  }
}

/**
 * The requirements editor, wired to the case the way the workspace wires it.
 *
 * After the UXR-01 redesign there is no `/case` route: the editor opens as a contextual
 * panel from the workspace. Tests that are about the *form's* behaviour — model
 * inspection, field origins, validation — should exercise the form against real case
 * state rather than navigate a panel open, so they render this.
 *
 * It is not a product surface and is deliberately in the test harness. Rendering a page
 * the application no longer routes would mean tests passing for a UI nobody can reach.
 */
/** Reports the current path, so a test can assert navigation without a real browser. */
export function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

export function RequirementsEditorHarness() {
  const {
    form,
    patch,
    evaluate,
    reset,
    applyPreset,
    submitting,
    activePresetId,
    changeModel,
    inspection,
    fieldOrigins,
    inspectModel,
    inspecting,
    inspectError,
    result,
    error,
    neverRun,
    progress,
    elapsedMs,
    outdatedFields,
    cancel,
  } = useCase();
  return (
    <>
      {result ? (
        <ResultKpiRow result={result} outdatedFields={outdatedFields} />
      ) : null}
      <RequirementsForm
        form={form}
        onChange={patch}
        onSubmit={() => void evaluate()}
        onReset={reset}
        onApplyPreset={applyPreset}
        submitting={submitting}
        activePresetId={activePresetId}
        changeModel={changeModel}
        inspection={inspection}
        fieldOrigins={fieldOrigins}
        onInspect={(source) => void inspectModel(source)}
        inspecting={inspecting}
        inspectError={inspectError}
      />
      {/*
        The same result components the workspace opens in its contextual panel. They
        are composed here so the existing form-plus-results assertions keep their
        meaning; the composition is a test fixture, not a route.
      */}
      <ResultsPanel
        result={result}
        loading={submitting}
        error={error}
        onRetry={() => void evaluate()}
        onCancel={cancel}
        neverRun={neverRun}
        progress={progress}
        elapsedMs={elapsedMs}
        outdatedFields={outdatedFields}
        onReevaluate={() => void evaluate()}
      />
    </>
  );
}
