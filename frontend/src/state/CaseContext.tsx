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
import { ApiError } from '../api/agentcore';
import type {
  EvaluateResponse,
  ModelInspectionResult,
  StreamEvent,
} from '../api/types';
import {
  INSPECTABLE_FIELDS,
  originsAfterModelChange,
  originsFromInspection,
  patchAfterModelChange,
  patchFromInspection,
  type FieldOrigins,
} from './modelInspection';

const DEFAULT_FORM_ORIGINS: FieldOrigins = {};
import { useAuth } from '../auth/AuthContext';
import { useApp } from './AppContext';
import {
  EMPTY_PROJECT,
  WORKLOAD_PRESETS,
  toEvaluateRequest,
  type CaseFormState,
} from './caseForm';
import {
  evaluatedRequestChanges,
  evaluatedRequestMatches,
} from './evaluatedRequest';
import {
  loadCase,
  saveCase,
  storageKey,
  projectFingerprint,
  type PersistedDecision,
  type PersistedTurn,
  type PersistenceProblem,
  type ProjectDocument,
} from './persistence';
import { useProjectSave, type ProjectSaveState } from './useProjectSave';
import { EMPTY_EVALUATION, type EvaluationDraft } from './evaluationDraft';
import { EMPTY_SIZING, type SizingDraft } from './sizingDraft';

/** One progress line reported by the runtime during a streaming evaluation. */
export interface ProgressEntry {
  at: number;
  message: string;
}

/**
 * The current decision, bound to the inputs that produced it.
 *
 * There is exactly one of these for a case. Chat, the case workspace and the
 * comparison view all read it, so they can never disagree about what the
 * current recommendation is.
 */
export type DecisionRecord = PersistedDecision;

export interface CaseContextValue {
  caseId: string;
  form: CaseFormState;
  patch: (patch: Partial<CaseFormState>) => void;
  reset: () => void;
  applyPreset: (presetId: string) => void;
  activePresetId: string | null;

  /** The single current decision, whatever produced it. */
  decisionRecord: DecisionRecord | null;
  /** Convenience alias for the decision payload. */
  result: EvaluateResponse | null;
  /**
   * True when a consequential input changed after this decision was computed.
   * The decision is kept — it is history — but it must not read as current.
   */
  isOutdated: boolean;
  /** Labels of the fields that changed since the decision was computed. */
  outdatedFields: string[];

  submitting: boolean;
  error: Error | null;
  progress: ProgressEntry[];
  elapsedMs: number | null;
  neverRun: boolean;

  evaluate: () => Promise<void>;
  cancel: () => void;
  /**
   * Record a decision produced elsewhere (chat).
   *
   * The decision carries its own `evaluatedRequest`, so no snapshot is passed:
   * the identity comes from what the solver actually received.
   */
  recordDecision: (
    decision: EvaluateResponse,
    source: 'form' | 'chat'
  ) => void;

  /** Chat turns, held here so they persist with the case. */
  persistedTurns: PersistedTurn[];
  setPersistedTurns: (turns: PersistedTurn[]) => void;
  draft: string;
  setDraft: (draft: string) => void;
  /** Non-null when saving or recovering the case failed. */
  persistenceProblem: PersistenceProblem | null;
  dismissPersistenceProblem: () => void;
  projectSave: ProjectSaveState;
  /** Changes when a whole saved project replaces the current draft. */
  hydrationVersion: number;
  evaluationDraft: EvaluationDraft;
  patchEvaluationDraft: (patch: Partial<EvaluationDraft>) => void;
  sizingDraft: SizingDraft;
  patchSizingDraft: (patch: Partial<SizingDraft>) => void;
  /* ------------------------------------------------- model inspection */

  /** The last inspection of the model source, or null if none has run. */
  inspection: ModelInspectionResult | null;
  /** Where each model field's value came from. */
  fieldOrigins: FieldOrigins;
  /** Read the model's published properties and apply the detected ones. */
  inspectModel: (source: string) => Promise<void>;
  inspecting: boolean;
  /** Non-null when the inspection itself failed, as opposed to detecting nothing. */
  inspectError: Error | null;
  /**
   * Record an inspection performed elsewhere (the advisor's `inspect_model` tool),
   * so the form shows the same provenance the conversation established.
   */
  recordInspection: (result: ModelInspectionResult) => void;
  /**
   * Point the case at a different model, clearing everything derived from the old
   * one. A parameter count belongs to the model it was read from.
   */
  changeModel: (patch: Partial<CaseFormState>) => void;

  /** True once a stored case has been read (or found absent). */
  restored: boolean;
  /**
   * The storage key that has been read into state, or `null` when nothing is
   * persisted. Consumers key their own rehydration on this rather than on
   * `restored`, which flips true on the pre-session render too.
   */
  restoredKey: string | null;
}

const CaseContext = createContext<CaseContextValue | null>(null);

const DEFAULT_CASE_ID = 'case-001';

export function CaseProvider({
  children,
  caseId = DEFAULT_CASE_ID,
  initialForm = EMPTY_PROJECT,
}: {
  children: ReactNode;
  caseId?: string;
  /** Explicit initial case for embeddings/tests; the application uses EMPTY_PROJECT. */
  initialForm?: CaseFormState;
}) {
  const { client, config } = useApp();
  const { session } = useAuth();

  const [form, setForm] = useState<CaseFormState>({ ...initialForm, caseId });
  const [activePresetId, setActivePresetId] = useState<string | null>(
    null
  );
  const [decisionRecord, setDecisionRecord] = useState<DecisionRecord | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [neverRun, setNeverRun] = useState(true);
  const [persistedTurns, setPersistedTurns] = useState<PersistedTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [evaluationDraft, setEvaluationDraft] = useState<EvaluationDraft>(EMPTY_EVALUATION);
  const [sizingDraft, setSizingDraft] = useState<SizingDraft>(EMPTY_SIZING);
  const patchSizingDraft = useCallback((next: Partial<SizingDraft>) => {
    setSizingDraft((current) => ({ ...current, ...next }));
  }, []);
  const patchEvaluationDraft = useCallback((next: Partial<EvaluationDraft>) => {
    setEvaluationDraft((current) => ({ ...current, ...next }));
  }, []);
  const [persistenceProblem, setPersistenceProblem] =
    useState<PersistenceProblem | null>(null);
  const [restored, setRestored] = useState(false);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const restoredCloudRevision = useRef<string | null>(null);
  const [inspection, setInspection] = useState<ModelInspectionResult | null>(
    null
  );
  const [fieldOrigins, setFieldOrigins] = useState<FieldOrigins>(
    initialForm === EMPTY_PROJECT ? DEFAULT_FORM_ORIGINS : Object.fromEntries(
      INSPECTABLE_FIELDS.map((field) => [field, 'EXAMPLE'])
    ) as FieldOrigins
  );
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<Error | null>(null);
  const inspectAbortRef = useRef<AbortController | null>(null);
  /**
   * The storage key whose contents have been read into state.
   *
   * The session arrives asynchronously, so the scope changes from "no subject"
   * to a real one after mount. Both the restore and save effects re-run on that
   * change, and effects in one commit see the *old* state: without this guard
   * the save would write default values over the freshly-keyed stored case
   * before the restore's state updates were applied, destroying the user's case.
   */
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The live form, so a resolving request compares against the inputs as they
  // are *now* rather than the ones captured when the closure was created.
  const formRef = useRef(form);
  formRef.current = form;
  // Read inside `recordInspection`, which must know which values the user typed.
  const originsRef = useRef(fieldOrigins);
  originsRef.current = fieldOrigins;

  const scope = useMemo(
    () => ({
      userPoolId: config.userPoolId,
      sub: session?.sub ?? null,
      caseId,
    }),
    [config.userPoolId, session?.sub, caseId]
  );

  /* --------------------------------------------------------- restore */

  useEffect(() => {
    const key = storageKey(scope);
    const { data, problem } = loadCase(scope);
    setRestoredKey(key);
    setPersistenceProblem(problem);
    if (data) {
      restoredCloudRevision.current = data.cloudRevision ?? null;
      setForm({ ...EMPTY_PROJECT, ...data.form, caseId });
      setDecisionRecord(data.decision);
      setPersistedTurns(data.turns);
      setDraft(data.draft);
      setEvaluationDraft(data.evaluationDraft ?? EMPTY_EVALUATION);
      setSizingDraft(data.sizingDraft ?? EMPTY_SIZING);
      // A restored case has a history, so the empty state must not claim
      // nothing has been run.
      setNeverRun(data.decision === null && data.turns.length === 0);
      setActivePresetId(null);
      // A case saved before inspection existed has neither field; its values were
      // all typed or seeded, so they are treated as provided rather than detected.
      setInspection(data.inspection ?? null);
      setFieldOrigins(data.fieldOrigins ?? {});
    } else if (key !== null || restoredKey !== null) {
      restoredCloudRevision.current = null;
      // Switching away from an existing scope starts clean. The first session
      // may arrive after an initial edit; it has no previous user's data to clear.
      if (restoredKey !== null) {
        setForm({ ...initialForm, caseId });
        setDraft('');
        setEvaluationDraft(EMPTY_EVALUATION);
        setSizingDraft(EMPTY_SIZING);
        setNeverRun(true);
        setActivePresetId(null);
        setError(null);
        setInspectError(null);
      }
      setDecisionRecord(null);
      setPersistedTurns([]);
      setInspection(null);
      setFieldOrigins(initialForm === EMPTY_PROJECT ? DEFAULT_FORM_ORIGINS : Object.fromEntries(
        INSPECTABLE_FIELDS.map((field) => [field, 'EXAMPLE'])
      ) as FieldOrigins);
    }
    setRestored(true);
    // Keyed on the scope so signing in as another user reads that user's case.
  }, [scope, initialForm]);

  const projectDocument = useMemo<ProjectDocument>(() => ({
    form, decision: decisionRecord, turns: persistedTurns, draft, inspection, fieldOrigins, evaluationDraft,
    ...(projectFingerprint(sizingDraft) === projectFingerprint(EMPTY_SIZING) ? {} : { sizingDraft }),
  }), [form, decisionRecord, persistedTurns, draft, inspection, fieldOrigins, evaluationDraft, sizingDraft]);
  const applySavedProject = useCallback((document: ProjectDocument) => {
    setForm({ ...EMPTY_PROJECT, ...document.form, caseId });
    setDecisionRecord(document.decision ?? null);
    setPersistedTurns(document.turns ?? []);
    setDraft(document.draft ?? '');
    setEvaluationDraft(document.evaluationDraft ?? EMPTY_EVALUATION);
    setSizingDraft(document.sizingDraft ?? EMPTY_SIZING);
    setInspection(document.inspection ?? null);
    setFieldOrigins(document.fieldOrigins ?? {});
    setNeverRun(!document.decision && !document.turns?.length);
    setActivePresetId(null);
    setError(null);
    setInspectError(null);
    setPersistenceProblem(null);
    setHydrationVersion((value) => value + 1);
  }, [caseId]);
  const projectSave = useProjectSave({
    scope, document: projectDocument,
    restored: restored && restoredKey === storageKey(scope),
    apply: applySavedProject,
  });

  /* ------------------------------------------------------------ save */

  useEffect(() => {
    if (!restored) return;
    /*
     * DO NOT REMOVE THIS GUARD. It is not redundant with `restored`.
     *
     * The Cognito session arrives after mount, so the storage scope changes from
     * "no subject" to a real one. Both the restore and the save effect re-run on
     * that change, and every effect in a single commit sees the *pre-update*
     * state: the restore's `setForm`/`setDecisionRecord` calls are only queued.
     * Without this check the save would then write default values over the
     * freshly-keyed stored case, discarding the user's conversation, decision
     * and draft on every sign-in — and it would present as "persistence just
     * does not work" rather than as a race.
     */
    // State (not a ref written by the restore effect above) proves that the
    // new scope's values have reached this render before anything is saved.
    if (restoredKey !== storageKey(scope)) return;
    const problem = saveCase(scope, {
      form,
      decision: decisionRecord,
      turns: persistedTurns,
      draft,
      inspection,
      fieldOrigins,
      cloudRevision: projectSave.revision ?? restoredCloudRevision.current,
      evaluationDraft,
      sizingDraft,
    });
    // Only raise a save failure; a prior load failure stays visible until
    // dismissed.
    setPersistenceProblem((current) => problem ?? (current?.kind === 'load' ? current : null));
  }, [
    restored,
    restoredKey,
    scope,
    form,
    decisionRecord,
    persistedTurns,
    draft,
    inspection,
    fieldOrigins,
    projectSave.revision,
    evaluationDraft,
    sizingDraft,
  ]);

  /* ------------------------------------------------------------ form */

  const patch = useCallback((next: Partial<CaseFormState>) => {
    setForm((current) => ({ ...current, ...next }));
    setActivePresetId(null);
    // Editing an inspectable field by hand makes it the user's value, not a
    // detected one. Without this a typed correction kept the green "Detected from
    // model" badge and claimed the source said something it did not.
    const touched = INSPECTABLE_FIELDS.filter((name) => name in next);
    if (touched.length > 0) {
      setFieldOrigins((current) => {
        const updated = { ...current };
        for (const name of touched) {
          updated[name] =
            String(next[name] ?? '').trim() === '' ? 'NOT_DETECTED' : 'PROVIDED';
        }
        return updated;
      });
    }
  }, []);

  const applyPreset = useCallback((presetId: string) => {
    const preset = WORKLOAD_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setForm((current) => ({ ...current, ...preset.patch }));
    setActivePresetId(presetId);
  }, []);

  const reset = useCallback(() => {
    setForm({ ...EMPTY_PROJECT, caseId });
    setSizingDraft(EMPTY_SIZING);
    setActivePresetId(null);
    setInspection(null);
    setFieldOrigins(DEFAULT_FORM_ORIGINS);
    setInspectError(null);
  }, [caseId]);

  /* ----------------------------------------------- model inspection */

  const recordInspection = useCallback((result: ModelInspectionResult) => {
    setInspection(result);
    // The next form is computed from the ref rather than inside a `setForm`
    // updater. Calling another setter from within an updater is a side effect in
    // the update phase, and React tore the subtree down instead of re-rendering
    // it -- the whole model section disappeared after an inspection returned.
    const next = {
      ...formRef.current,
      // The current origins decide what survives: a value the user typed is kept,
      // an example or an earlier model's detected value is cleared.
      ...patchFromInspection(result, originsRef.current),
      ...((formRef.current.artifactDigest || formRef.current.hfCommit) &&
        (formRef.current.artifactDigest || formRef.current.hfCommit) !== result.revision
        ? { provideLatencyEvidence: false, latencyEvidence: [] } : {}),
    };
    setForm(next);
    // Origins are judged against the form *after* the detected values land, so a
    // field the inspection could not establish is only "not detected" when it is
    // genuinely empty rather than holding a value the user typed.
    setFieldOrigins(originsFromInspection(result, next));
  }, []);

  const inspectModel = useCallback(
    async (source: string) => {
      inspectAbortRef.current?.abort();
      const controller = new AbortController();
      inspectAbortRef.current = controller;
      setInspecting(true);
      setInspectError(null);
      try {
        const result = source.startsWith('s3://') ? await client.inspectCheckpoint(source, controller.signal) : await client.inspectModel(
          source,
          undefined,
          controller.signal
        );
        // A result with `ok: false` is a reported outcome, not a thrown failure:
        // it names a missing repository or an access requirement, and the panel
        // shows it. Recording it keeps that explanation on screen.
        if (!controller.signal.aborted) recordInspection(result);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setInspectError(
          caught instanceof Error ? caught : new Error(String(caught))
        );
      } finally {
        if (!controller.signal.aborted) setInspecting(false);
      }
    },
    [client, recordInspection]
  );

  const changeModel = useCallback((next: Partial<CaseFormState>) => {
    inspectAbortRef.current?.abort();
    setInspecting(false);
    // Everything derived from the previous model is cleared first, then the new
    // identity applied. Retaining the old parameter count because the new source
    // did not publish one would attribute one model's properties to another.
    setForm((current) => ({
      ...current,
      ...patchAfterModelChange(),
      ...next,
    }));
    setInspection(null);
    setInspectError(null);
    // Any value the new selection brings with it comes from a built-in example,
    // so it is labelled EXAMPLE. Marking everything NOT_DETECTED would have shown
    // "Not detected" beside a populated field, and calling it DETECTED would claim
    // an inspection that never ran -- the exact confusion the review identified.
    const origins = originsAfterModelChange();
    for (const name of INSPECTABLE_FIELDS) {
      if (String(next[name] ?? '').trim() !== '') origins[name] = 'EXAMPLE';
    }
    setFieldOrigins(origins);
    setActivePresetId(null);
  }, []);

  /* ------------------------------------------------------- staleness */

  /** What evaluating the form right now would send. */
  const livePayload = useMemo(() => toEvaluateRequest(form), [form]);

  /**
   * Staleness is judged against the request the solver actually received.
   *
   * A form snapshot cannot do this job: the advisor may have patched the case
   * after the snapshot, and a strictness change may have flipped
   * `assumeChecksCleared`, so the snapshot would describe inputs that were never
   * evaluated — and editing the form back to match it would wrongly un-stale a
   * decision that ran with different inputs.
   */
  const outdatedFields = useMemo(
    () =>
      decisionRecord
        ? evaluatedRequestChanges(decisionRecord.evaluatedRequest, livePayload)
        : [],
    [decisionRecord, livePayload]
  );

  const isOutdated = outdatedFields.length > 0;

  const recordDecision = useCallback(
    (decision: EvaluateResponse, source: 'form' | 'chat') => {
      setDecisionRecord({
        decision,
        evaluatedRequest: decision.evaluatedRequest ?? null,
        evaluatedRequestHash: decision.evaluatedRequestHash ?? null,
        at: Date.now(),
        source,
      });
      setNeverRun(false);
    },
    []
  );

  /* -------------------------------------------------------- evaluate */

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSubmitting(false);
  }, []);

  const evaluate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;


    setSubmitting(true);
    setError(null);
    setProgress([]);
    setElapsedMs(null);

    // The payload this request was issued with. A response arriving after the
    // inputs changed is discarded rather than presented as the recommendation
    // for inputs it never saw.
    const request = toEvaluateRequest(form);

    const onEvent = (event: StreamEvent<EvaluateResponse>) => {
      const message =
        typeof event.message === 'string' && event.message.trim() !== ''
          ? event.message
          : null;
      if (!message) return;
      setProgress((current) => [...current, { at: Date.now(), message }]);
    };

    try {
      let response: EvaluateResponse;
      try {
        response = await client.evaluateStream(
          request,
          onEvent,
          controller.signal
        );
      } catch (streamFailure) {
        const isStreamUnsupported =
          streamFailure instanceof ApiError &&
          streamFailure.code === 'stream_unsupported';
        if (!isStreamUnsupported || controller.signal.aborted) throw streamFailure;
        setProgress((current) => [
          ...current,
          {
            at: Date.now(),
            message:
              'Streaming is unavailable in this browser. Falling back to a single request.',
          },
        ]);
        response = await client.evaluate(request, controller.signal);
      }
      if (controller.signal.aborted) return;

      // Discard a late response for superseded inputs.
      if (!evaluatedRequestMatches(request, toEvaluateRequest(formRef.current))) {
        setProgress((current) => [
          ...current,
          {
            at: Date.now(),
            message:
              'Inputs changed while this evaluation was running, so its result was discarded. Evaluate again.',
          },
        ]);
        return;
      }

      recordDecision(response, 'form');
      setElapsedMs(client.lastElapsedMs);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setDecisionRecord(null);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setNeverRun(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSubmitting(false);
    }
  }, [client, form, recordDecision]);

  const dismissPersistenceProblem = useCallback(
    () => setPersistenceProblem(null),
    []
  );

  const value = useMemo<CaseContextValue>(
    () => ({
      caseId,
      form,
      patch,
      reset,
      applyPreset,
      activePresetId,
      decisionRecord,
      result: decisionRecord?.decision ?? null,
      isOutdated,
      outdatedFields,
      submitting,
      error,
      progress,
      elapsedMs,
      neverRun,
      evaluate,
      cancel,
      recordDecision,
      livePayload,
      persistedTurns,
      setPersistedTurns,
      draft,
      setDraft,
      persistenceProblem,
      dismissPersistenceProblem,
      projectSave,
      hydrationVersion,
      evaluationDraft,
      patchEvaluationDraft,
      sizingDraft,
      patchSizingDraft,
      restored,
      restoredKey,
      inspection,
      fieldOrigins,
      inspectModel,
      inspecting,
      inspectError,
      recordInspection,
      changeModel,
    }),
    [
      caseId,
      form,
      patch,
      reset,
      applyPreset,
      activePresetId,
      decisionRecord,
      isOutdated,
      outdatedFields,
      submitting,
      error,
      progress,
      elapsedMs,
      neverRun,
      evaluate,
      cancel,
      recordDecision,
      livePayload,
      persistedTurns,
      draft,
      persistenceProblem,
      dismissPersistenceProblem,
      projectSave,
      hydrationVersion,
      evaluationDraft,
      patchEvaluationDraft,
      sizingDraft,
      patchSizingDraft,
      restored,
      restoredKey,
      inspection,
      fieldOrigins,
      inspectModel,
      inspecting,
      inspectError,
      recordInspection,
      changeModel,
    ]
  );

  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}

export function useCase(): CaseContextValue {
  const value = useContext(CaseContext);
  if (!value) {
    throw new Error('useCase must be used inside <CaseProvider>.');
  }
  return value;
}
