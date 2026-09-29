import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ChatResponse,
  StreamEvent,
} from '../api/types';
import { useApp } from './AppContext';
import { useCase } from './CaseContext';
import { projectFingerprint } from './persistence';
import { DEFAULT_SIZING } from './sizingDraft';
import {
  caseToFormPatch,
  describeCasePatch,
  formToAdvisorCase,
  type CaseChange,
} from './caseForm';

/** One submitted turn outcome. Recovery reads the saved turn; it never resubmits. */
export interface ChatAttempt {
  id: string;
  at: number;
  response: ChatResponse | null;
  error: Error | null;
}

/**
 * One logical exchange.
 *
 * The transcript shows one prompt and one current outcome. The server owns
 * conversation history; a disconnected browser may recover the saved outcome.
 */
export interface ChatTurn {
  id: string;
  sequence?: number;
  savedToConversation?: boolean;
  prompt: string;
  attempts: ChatAttempt[];
  /** The current outcome: the last attempt's response, if any. */
  response: ChatResponse | null;
  /** Set only when the *latest* attempt failed. */
  error: Error | null;
  changes: CaseChange[];
  /** True while an attempt for this turn is in flight. */
  pending: boolean;
  /** Stable across saves and rehydration; opening a project is not an edit. */
  at?: number;
  retainedEdits?: string[];
  streamedReply?: string;
  completionStatus?: 'COMPLETE' | 'CANCELLED' | 'FAILED' | 'INTERRUPTED';
  firstAnswerAt?: number;
  completedAt?: number;
}

export interface ChatProgressEntry {
  at: number;
  message: string;
}

export interface ChatContextValue {
  turns: ChatTurn[];
  sending: boolean;
  stopping: boolean;
  progress: ChatProgressEntry[];
  suggestedPrompts: string[];
  provenance: string | null;
  advisorModelId: string | null;
  restoring: boolean;
  historyProblem: string | null;
  hasEarlierMessages: boolean;
  loadEarlier: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  send: (prompt: string) => Promise<void>;
  /** Recover an existing turn from storage without another model invocation. */
  retry: (turnId: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * Deliberately empty.
 *
 * This was a second hardcoded list, independent of the backend's. Emptying the
 * backend's `SUGGESTED_PROMPTS` therefore changed nothing the user saw: the frontend
 * kept substituting its own copy of the same four examples, so a conversation about an
 * always-on 0.5B text service was still offered follow-ups about a much larger model, a
 * three-day burst and a speech vendor -- none of which had been mentioned.
 *
 * Two lists with the same content in two layers is how a fix looks applied and is not.
 * The empty state now uses the three fixed starters in WorkspacePage, and follow-ups
 * appear only when the advisor proposes something specific to this conversation.
 */
export const FALLBACK_SUGGESTED_PROMPTS: string[] = [];

export function ChatProvider({ children }: { children: ReactNode }) {
  const { client } = useApp();
  const {
    form,
    patch: patchForm,
    recordDecision,
    persistedTurns,
    setPersistedTurns,
    restoredKey,
    hydrationVersion,
    recordInspection,
    inspection,
    sizingDraft,
    patchSizingDraft,
    projectSave,
  } = useCase();

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ChatProgressEntry[]>([]);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [provenance, setProvenance] = useState<string | null>(null);
  const [advisorModelId, setAdvisorModelId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [historyProblem, setHistoryProblem] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnRef = useRef<string | null>(null);
  const stopRequestedRef = useRef<string | null>(null);
  const historyGeneration = useRef(0);
  const liveForm = useRef(form);
  liveForm.current = form;
  const liveSizing = useRef(sizingDraft?.settings);
  liveSizing.current = sizingDraft?.settings;
  useEffect(() => () => {
    const turnId = activeTurnRef.current;
    abortRef.current?.abort();
    if (turnId) {
      // A project switch or sign-out must not abandon model work. This request
      // may fail after logout; the stream disconnect and server deadline still
      // enforce cooperative cancellation.
      void client.cancelChat(liveForm.current.caseId, turnId, AbortSignal.timeout(8000)).catch(() => undefined);
    }
  }, [client]);
  // The storage key already rehydrated. Keyed rather than a one-shot flag: the
  // Cognito session arrives after mount, so the first restore pass happens with
  // no scope at all and must not consume the only chance to hydrate.
  const hydratedKey = useRef<string | null>(null);
  const [turnsKey, setTurnsKey] = useState<string | null>(null);

  useEffect(() => {
    const hydrationKey = `${restoredKey}:${hydrationVersion}`;
    if (restoredKey === null || hydratedKey.current === hydrationKey) return;
    hydratedKey.current = hydrationKey;
    setHistoryCursor(undefined);
    setTurnsKey(hydrationKey);
    abortRef.current?.abort();
    activeTurnRef.current = null;
    stopRequestedRef.current = null;
    setSending(false);
    setStopping(false);
    if (persistedTurns.length === 0) { setTurns([]); return; }
    setTurns(
      persistedTurns.map((stored) => ({
        id: stored.id,
        prompt: stored.prompt,
        pending: false,
        at: stored.at,
        error: null,
        completionStatus: stored.completionStatus,
        savedToConversation: stored.savedToConversation,
        changes: stored.changes ?? stored.changedFields.map((label) => ({
          field: 'architecture',
          label,
          value: '',
        })),
        response: {
          reply: stored.reply,
          status: stored.completionStatus === 'INTERRUPTED' ? 'FAILED' : stored.completionStatus,
          case: {},
          casePatch: {},
          decision: stored.decision,
          toolCalls: stored.toolCallSummary.map((call) => ({
            name: call.name,
            input: {},
            status: call.status,
          })),
          rounds: null,
          truncated: stored.truncated,
          advisorModelId: stored.advisorModelId,
          usage: null,
          suggestedPrompts: null,
          provenance: null,
          evaluatedRequest: null,
          unsupportedInputs: null,
          strictRequestedByAdvisor: false,
        },
        attempts: [],
      }))
    );
    const last = persistedTurns[persistedTurns.length - 1];
    if (last?.advisorModelId) setAdvisorModelId(last.advisorModelId);
  }, [restoredKey, hydrationVersion, persistedTurns]);

  // Mirror the transcript into the persisted case.
  useEffect(() => {
    if (turnsKey !== `${restoredKey}:${hydrationVersion}`) return;
    const settled = turns.filter((turn) => !turn.pending && (turn.response !== null || turn.streamedReply));
    setPersistedTurns(
      settled.map((turn) => ({
        id: turn.id,
        prompt: turn.prompt,
        reply: turn.response?.reply ?? turn.streamedReply ?? null,
        completionStatus: turn.completionStatus,
        savedToConversation: turn.savedToConversation === true,
        changedFields: turn.changes.map((change) => change.label),
        changes: turn.changes,
        decision: turn.response?.decision ?? null,
        toolCallSummary: (turn.response?.toolCalls ?? []).map((call) => ({
          name: call.name,
          status: call.status,
        })),
        truncated: turn.response?.truncated === true,
        advisorModelId: turn.response?.advisorModelId ?? null,
        at: turn.at ?? 0,
      }))
    );
    // `setPersistedTurns` is stable; turns is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, turnsKey, restoredKey, hydrationVersion, setPersistedTurns]);

  const loadHistory = useCallback(async (beforeSequence?: number) => {
    if (!restoredKey || !projectSave.ready || projectSave.loading) return;
    const generation = ++historyGeneration.current;
    setRestoring(true);
    try {
      const history = await client.chatHistory(form.caseId, undefined, beforeSequence);
      if (generation !== historyGeneration.current) return;
      setHistoryProblem(null);
      setHistoryCursor((current) => beforeSequence !== undefined || current === undefined
        ? history.nextBeforeSequence ?? null : current);
      setTurns((current) => {
        const existing = new Map(current.map((turn) => [turn.id, turn]));
        const restoredTurns = history.turns.map((saved): ChatTurn => {
          const local = existing.get(saved.turnId);
          if (local?.pending) return local;
          const completionStatus = saved.status === 'RUNNING' ? local?.completionStatus : saved.status;
          return {
            id: saved.turnId, sequence: saved.sequence, prompt: saved.prompt, at: saved.startedAt * 1000,
            attempts: local?.attempts ?? [], changes: local?.changes ?? [],
            pending: false, completionStatus, streamedReply: saved.reply ?? local?.streamedReply,
            error: saved.status === 'INTERRUPTED'
              ? new Error('This answer was interrupted. Send a new message when you are ready to continue.')
              : null,
            savedToConversation: saved.reply !== null,
            response: saved.reply === null ? null : {
              ...(local?.response ?? {
                case: {}, casePatch: {}, decision: null, toolCalls: [],
                rounds: null, usage: null, suggestedPrompts: null, provenance: null,
                evaluatedRequest: null, unsupportedInputs: null, strictRequestedByAdvisor: false,
              }),
              reply: saved.reply,
              awsDocumentation: saved.awsDocumentation ?? undefined,
              status: completionStatus === 'INTERRUPTED' ? 'FAILED' : completionStatus,
              truncated: saved.status !== 'COMPLETE', advisorModelId: saved.advisorModelId,
            },
          };
        });
        const serverIds = new Set(history.turns.map((turn) => turn.turnId));
        return [...restoredTurns, ...current.filter((turn) => !serverIds.has(turn.id))]
          .sort((a, b) => a.sequence !== undefined && b.sequence !== undefined
            ? a.sequence - b.sequence : (a.at ?? 0) - (b.at ?? 0));
      });
      if (!abortRef.current) {
        activeTurnRef.current = history.activeTurnId;
        setSending(history.activeTurnId !== null);
        if (history.activeTurnId === null) {
          stopRequestedRef.current = null;
          setStopping(false);
        }
      }
    } catch (error) {
      if (generation !== historyGeneration.current) return;
      setHistoryProblem(error instanceof Error ? error.message : 'Saved conversation could not be restored.');
    } finally {
      if (generation === historyGeneration.current) setRestoring(false);
    }
  }, [client, form.caseId, restoredKey, projectSave.ready, projectSave.loading]);

  const refreshHistory = useCallback(() => loadHistory(), [loadHistory]);
  const loadEarlier = useCallback(async () => {
    if (historyCursor != null) await loadHistory(historyCursor);
  }, [historyCursor, loadHistory]);

  useEffect(() => {
    if (restoredKey) void refreshHistory();
    return () => { historyGeneration.current += 1; };
  }, [restoredKey, refreshHistory]);

  useEffect(() => {
    if (!sending || abortRef.current) return;
    let active = true;
    let timer: number;
    const poll = async () => {
      await refreshHistory();
      if (active) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [sending, stopping, refreshHistory]);

  const cancel = useCallback(() => {
    const turnId = activeTurnRef.current;
    const controller = abortRef.current;
    if (!turnId || stopRequestedRef.current === turnId) return;
    stopRequestedRef.current = turnId;
    setStopping(true);
    setProgress((current) => [...current, { at: Date.now(), message: 'Requesting Stop' }]);
    // Stop rendering immediately, but keep admission closed until the saved
    // server state confirms this turn has finished.
    controller?.abort();
    if (abortRef.current === controller) abortRef.current = null;
    setTurns((current) => current.map((turn) => turn.id === turnId && turn.pending
      ? { ...turn, pending: false, completionStatus: 'CANCELLED' } : turn));
    void client.cancelChat(form.caseId, turnId, AbortSignal.timeout(8000)).then(() => {
      // Disconnect cancellation may finish before this request arrives. "No
      // active turn" is not a recovery failure; read its durable outcome below.
      setHistoryProblem(null);
    }).catch(() => {
      setHistoryProblem('The Stop request could not be confirmed. Check the saved answer; server execution is time-limited.');
    }).finally(() => {
      setProgress((current) => [...current, { at: Date.now(), message: 'Checking the saved outcome' }]);
      void refreshHistory();
    });
  }, [client, form.caseId, refreshHistory]);

  const reset = useCallback(() => {
    cancel();
    setTurns([]);
    setProgress([]);
  }, [cancel]);

  /**
   * Run one attempt for `turnId`.
   *
   * Only this prompt is submitted. Strands restores model/tool history from
   * the server session; recovery never resubmits this request.
   */
  const runAttempt = useCallback(
    async (turnId: string, prompt: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      activeTurnRef.current = turnId;
      const attemptId = crypto.randomUUID();
      setSending(true);
      setProgress([]);
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? { ...turn, pending: true, error: null, streamedReply: '', completionStatus: undefined }
            : turn
        )
      );

      const body = {
        message: prompt,
        turnId,
        // The form is authoritative. An earlier advisor reply must never put an
        // old budget, Region or SLO back over a later manual edit.
        case: {
          ...formToAdvisorCase(form),
          modelInspection: inspection,
          sizingSettings: sizingDraft?.settings,
          sloThresholdMs: form.provideSlo ? form.sloThresholdMs : null,
          caseId: form.caseId,
        },
        assumeChecksCleared: form.assumeChecksCleared,
      };

      const onEvent = (event: StreamEvent<ChatResponse>) => {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        if (event.event === 'answer_delta' && typeof event.delta === 'string') {
          setTurns((current) => current.map((turn) => turn.id === turnId ? {
            ...turn, streamedReply: (turn.streamedReply ?? '') + event.delta,
            firstAnswerAt: turn.firstAnswerAt ?? Date.now(),
          } : turn));
          return;
        }
        const message =
          typeof event.message === 'string' && event.message.trim() !== ''
            ? event.message
            : null;
        if (!message) return;
        setProgress((current) => [...current, { at: Date.now(), message }]);
      };

      const settle = (attempt: ChatAttempt) => {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  pending: false,
                  completionStatus: attempt.response?.status ?? (attempt.error ? 'FAILED' : 'COMPLETE'),
                  savedToConversation: Boolean(attempt.response?.turnId),
                  completedAt: Date.now(),
                  attempts: [...turn.attempts, attempt],
                  // On success the failure presentation is replaced outright.
                  response: attempt.response ?? turn.response,
                  error: attempt.response ? null : attempt.error,
                  changes: attempt.response
                    ? describeCasePatch(
                        (attempt.response.casePatch ?? {}) as Record<
                          string,
                          unknown
                        >
                      )
                    : turn.changes,
                }
              : turn
          )
        );
      };

      try {
        const response = await client.chatStream(body, onEvent, controller.signal);
        if (controller.signal.aborted) return;

        const patch = caseToFormPatch(
          (response.casePatch ?? {}) as Record<string, unknown>
        );
        // A user can keep editing while the advisor works. Only apply fields
        // that still match the request; never replace a newer manual edit.
        const retainedEdits: string[] = [];
        for (const field of Object.keys(patch) as (keyof typeof patch)[]) {
          if (liveForm.current[field] !== form[field]) {
            retainedEdits.push(field);
            delete patch[field];
          }
        }
        const modelUnchanged = liveForm.current.hfRepo === form.hfRepo &&
          liveForm.current.modelName === form.modelName;
        if (modelUnchanged && response.case?.modelInspection &&
            response.toolCalls.some((call) => call.name === 'inspect_model' && call.status === 'success')) {
          recordInspection(response.case.modelInspection as import('../api/types').ModelInspectionResult);
        }
        if (Object.keys(patch).length > 0) patchForm(patch);

        // The displayed change list must describe applied changes, not a
        // discarded proposal. The original tool call remains in the audit view.
        settle({ id: attemptId, at: Date.now(), response: { ...response, casePatch: patch }, error: null });
        if (retainedEdits.length) setTurns((current) => current.map((turn) =>
          turn.id === turnId ? { ...turn, retainedEdits } : turn));

        /*
         * One decision identity across every surface.
         *
         * No snapshot is passed: the decision carries the `evaluatedRequest` the
         * solver received, which already reflects this turn's case patch and any
         * strictness change the advisor applied. That is why a turn that quietly
         * relaxed a check cannot look current against the form the user typed.
         */
        if (response.decision) {
          recordDecision(response.decision, 'chat');
        }
        if (response.sizingReport) {
          // Apply agreed sizing changes only while the user has not edited those
          // settings during this turn. The report always retains its exact inputs.
          const unchanged = projectFingerprint({ ...DEFAULT_SIZING, ...liveSizing.current }) ===
            projectFingerprint({ ...DEFAULT_SIZING, ...sizingDraft?.settings });
          patchSizingDraft({
            report: response.sizingReport,
            ...(unchanged ? { settings: response.sizingReport.settings } : {}),
          });
        }

        if (response.suggestedPrompts?.length) {
          setSuggested(response.suggestedPrompts);
        }
        if (response.provenance) setProvenance(response.provenance);
        if (response.advisorModelId) setAdvisorModelId(response.advisorModelId);
      } catch (caught) {
        if (controller.signal.aborted) return;
        settle({
          id: attemptId,
          at: Date.now(),
          response: null,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          if (stopRequestedRef.current !== turnId) {
            activeTurnRef.current = null;
            setSending(false);
          }
        }
      }
    },
    [client, form, patchForm, recordDecision, recordInspection, inspection, sizingDraft, patchSizingDraft]
  );

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (text === '' || sending || activeTurnRef.current) return;
      const turnId = crypto.randomUUID();
      setTurns((current) => [
        ...current,
        {
          id: turnId,
          prompt: text,
          attempts: [],
          response: null,
          error: null,
          changes: [],
          pending: true,
          at: Date.now(),
        },
      ]);
      await runAttempt(turnId, text);
    },
    [runAttempt, sending]
  );

  const retry = useCallback(
    async (turnId: string) => {
      if (sending) return;
      // A disconnected turn may have finished server-side. Never resubmit its
      // model/tool loop. An explicit new message creates the next native turn.
      if (!turns.some((item) => item.id === turnId)) return;
      await refreshHistory();
    },
    [refreshHistory, sending, turns]
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      turns,
      sending,
      stopping,
      progress,
      suggestedPrompts: suggested ?? FALLBACK_SUGGESTED_PROMPTS,
      provenance,
      advisorModelId,
      restoring, historyProblem, refreshHistory,
      hasEarlierMessages: historyCursor != null, loadEarlier,
      send,
      retry,
      cancel,
      reset,
    }),
    [
      turns,
      sending,
      stopping,
      progress,
      suggested,
      provenance,
      advisorModelId,
      restoring, historyProblem, refreshHistory, historyCursor, loadEarlier,
      send,
      retry,
      cancel,
      reset,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) {
    throw new Error('useChat must be used inside <ChatProvider>.');
  }
  return value;
}
