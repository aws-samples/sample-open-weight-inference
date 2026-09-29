import type {
  EvaluatePayloadEcho,
  EvaluateResponse,
  ModelInspectionResult,
} from '../api/types';
import type { CaseChange, CaseFormState } from './caseForm';
import type { FieldOrigins } from './modelInspection';
import type { EvaluationDraft } from './evaluationDraft';
import type { SizingDraft } from './sizingDraft';

/**
 * Optional local draft backup. Explicit project saves and native Advisor sessions
 * use authenticated DynamoDB APIs. Local storage failure must never be presented
 * as a failed server save. No credentials are written into project documents.
 */

const VERSION = 1;
const PREFIX = 'eddie.case';

export interface PersistScope {
  userPoolId: string;
  /** Cognito subject claim. Without it nothing is persisted. */
  sub: string | null;
  caseId: string;
}

/**
 * A decision plus the request that actually produced it.
 *
 * The identity is the solver's own `evaluatedRequestHash`, and staleness is
 * judged by comparing the live form's projected payload against
 * `evaluatedRequest`. A form snapshot was the wrong basis: the advisor can patch
 * the case, and a strictness change can flip stipulation, after any snapshot.
 */
export interface PersistedDecision {
  decision: EvaluateResponse;
  evaluatedRequest: EvaluatePayloadEcho | null;
  evaluatedRequestHash: string | null;
  at: number;
  source: 'form' | 'chat';
}

export interface PersistedTurn {
  id: string;
  prompt: string;
  reply: string | null;
  /** Only the fields the turn changed, for the summary badge. */
  changedFields: string[];
  /** Applied values, so reopening the project does not show empty change labels. */
  changes?: CaseChange[];
  /** Decision reference: the hash, plus the payload so a reload can render it. */
  decision: EvaluateResponse | null;
  toolCallSummary: { name: string; status: string }[];
  truncated: boolean;
  advisorModelId: string | null;
  at: number;
  completionStatus?: 'COMPLETE' | 'CANCELLED' | 'FAILED' | 'INTERRUPTED';
  /** UI save status only; the authenticated conversation already holds this turn. */
  savedToConversation?: boolean;
}

export interface PersistedCase {
  version: number;
  caseId: string;
  savedAt: number;
  form: CaseFormState;
  decision: PersistedDecision | null;
  turns: PersistedTurn[];
  draft: string;
  /**
   * The last model inspection, so a reloaded case still knows which values were
   * detected rather than typed. Without it every field would come back looking
   * like the user had entered it by hand.
   *
   * Optional: a case saved before inspection existed has no such record, and that
   * must load rather than being rejected as a version mismatch.
   */
  inspection?: ModelInspectionResult | null;
  fieldOrigins?: FieldOrigins;
  /** Last cloud revision this local draft was based on. Never an authorization. */
  cloudRevision?: string | null;
  evaluationDraft?: EvaluationDraft;
  sizingDraft?: SizingDraft;
}

export type ProjectDocument = Pick<PersistedCase,
  'form' | 'decision' | 'turns' | 'draft' | 'inspection' | 'fieldOrigins' | 'evaluationDraft' | 'sizingDraft'>;

export interface SavedProject {
  caseId: string;
  revision: string;
  savedAt: string;
  title: string;
  document: ProjectDocument;
}

/** Order-independent comparison for draft changes; not a security hash. */
export function projectFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(projectFingerprint).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${projectFingerprint(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Native chat is saved separately. Keep unsent/legacy text and form edits protected. */
export function projectDraftFingerprint(document: ProjectDocument): string {
  return projectFingerprint({
    ...document,
    turns: document.turns.filter(turn => !turn.savedToConversation),
  });
}

export type PersistenceProblem =
  | { kind: 'save'; message: string }
  | { kind: 'load'; message: string };

function storage(): Storage | null {
  try {
    // Reading must not require spare write capacity. A full store can still
    // recover existing drafts. Write failures are classified at the real write.
    return window.localStorage;
  } catch {
    return null;
  }
}

type HistoryScope = Pick<PersistScope, 'userPoolId' | 'sub'>;
const REMOVED_PREFIX = 'eddie.removed.v1';

export function removedProjectIds(scope: HistoryScope): string[] {
  if (!scope.sub) return [];
  try {
    const parsed: unknown = JSON.parse(
      storage()?.getItem(`${REMOVED_PREFIX}.${scope.userPoolId}.${scope.sub}`) ?? '[]'
    );
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))
      : [];
  } catch {
    return [];
  }
}

/** Cache acknowledged server removals. Server markers remain authoritative. */
export function rememberRemovedProjects(scope: HistoryScope, ids: string[]): void {
  if (!scope.sub || ids.length === 0) return;
  const store = storage();
  if (!store) return;
  try {
    const all = [...new Set([...removedProjectIds(scope), ...ids])];
    store.setItem(`${REMOVED_PREFIX}.${scope.userPoolId}.${scope.sub}`, JSON.stringify(all));
  } catch {
    // A full/unavailable local cache cannot undo an acknowledged account removal.
  }
  for (const caseId of ids) {
    try {
      const key = storageKey({ ...scope, caseId });
      if (key) store.removeItem(key);
      store.removeItem(titleKey(scope.sub, caseId));
    } catch {
      // Lists also filter against the server markers on every account load.
    }
  }
}

/**
 * Storage key. Returns `null` when the scope cannot isolate one user from
 * another — no `sub` means no persistence, rather than a shared bucket.
 */
export function storageKey(scope: PersistScope): string | null {
  if (!scope.sub || scope.sub.trim() === '') return null;
  if (!scope.caseId || scope.caseId.trim() === '') return null;
  return `${PREFIX}.v${VERSION}.${scope.userPoolId}.${scope.sub}.${scope.caseId}`;
}

export function loadCase(
  scope: PersistScope
): { data: PersistedCase | null; problem: PersistenceProblem | null } {
  const key = storageKey(scope);
  if (!key) return { data: null, problem: null };
  if (removedProjectIds(scope).includes(scope.caseId)) return { data: null, problem: null };
  const store = storage();
  if (!store) {
    return {
      data: null,
      problem: {
        kind: 'load',
        message:
          'Local draft backup is unavailable. Use Save project to keep your work in your account.',
      },
    };
  }
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch (cause) {
    return {
      data: null,
      problem: {
        kind: 'load',
        message: `Could not read the saved case. ${
          cause instanceof Error ? cause.message : 'Unknown storage error.'
        }`,
      },
    };
  }
  if (!raw) return { data: null, problem: null };

  try {
    const parsed = JSON.parse(raw) as PersistedCase;
    if (parsed.version !== VERSION) {
      // A shape from an older release is discarded rather than half-read, and
      // the user is told instead of silently starting fresh.
      return {
        data: null,
        problem: {
          kind: 'load',
          message:
            'A saved case from an earlier version of EDDIE was found and could not be read. It has been left untouched and a new case started.',
        },
      };
    }
    return { data: parsed, problem: null };
  } catch (cause) {
    return {
      data: null,
      problem: {
        kind: 'load',
        message: `The saved case could not be parsed, so a new one was started. ${
          cause instanceof Error ? cause.message : ''
        }`.trim(),
      },
    };
  }
}

export function saveCase(
  scope: PersistScope,
  data: Omit<PersistedCase, 'version' | 'savedAt' | 'caseId'>
): PersistenceProblem | null {
  const key = storageKey(scope);
  if (!key) return null;
  // An in-flight chat or save may settle while the removed project unmounts.
  if (removedProjectIds(scope).includes(scope.caseId)) return null;
  const store = storage();
  if (!store) {
    return {
      kind: 'save',
      message:
          'Local draft backup is unavailable. Use Save project to keep your work in your account.',
    };
  }
  const payload: PersistedCase = {
    version: VERSION,
    caseId: scope.caseId,
    savedAt: Date.now(),
    ...data,
  };
  try {
    store.setItem(key, JSON.stringify(payload));
    return null;
  } catch (cause) {
    const quota =
      cause instanceof Error && /quota|exceeded/i.test(cause.message);
    return {
      kind: 'save',
      message: quota
        ? 'Browser storage is full. Save this project to your account or download a copy; starting another conversation does not free space.'
        : `Could not save this case. ${
            cause instanceof Error ? cause.message : 'Unknown storage error.'
          }`,
    };
  }
}

export function clearCase(scope: PersistScope): PersistenceProblem | null {
  const key = storageKey(scope);
  if (!key) return null;
  try {
    const store = storage();
    if (!store) throw new Error('Browser storage is unavailable.');
    store.removeItem(key);
    return null;
  } catch {
    return {
      kind: 'save',
      message: 'Could not discard the browser draft. Your project has stayed open so you can save it or download a copy.',
    };
  }
}

/** List the case ids stored for this user, for a future case switcher. */
export function listCaseIds(scope: Omit<PersistScope, 'caseId'>): string[] {
  if (!scope.sub) return [];
  const store = storage();
  if (!store) return [];
  const prefix = `${PREFIX}.v${VERSION}.${scope.userPoolId}.${scope.sub}.`;
  const ids: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
  } catch {
    return [];
  }
  return ids.sort();
}

/* ------------------------------------------------------- conversations */

/**
 * Saved conversations for the sidebar, newest first.
 *
 * Built by reading the stored cases rather than a separate index, so a case saved by
 * the previous frontend appears without a migration step. UXR-13 requires that the
 * redesign does not silently lose saved work.
 *
 * Scope includes the user pool and subject, matching the saved-case key and the
 * removal cache. A different account's local drafts never enter this list.
 */
export interface SavedConversation {
  id: string;
  title: string;
  updatedAt: number;
  titleIsCustom: boolean;
  messageCount: number;
}

const TITLE_PREFIX = 'eddie.title';

function titleKey(sub: string, id: string): string {
  return `${TITLE_PREFIX}.v${VERSION}.${sub}.${id}`;
}

export function listSavedConversations(scope: HistoryScope): SavedConversation[] {
  if (!scope.sub) return [];
  const store = storage();
  if (!store) return [];
  const out: SavedConversation[] = [];
  const removed = new Set(removedProjectIds(scope));
  const prefix = `${PREFIX}.v${VERSION}.${scope.userPoolId}.${scope.sub}.`;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      // Keys are `eddie.case.v1.<pool>.<sub>.<caseId>`; only this subject's.
      const parts = key.split('.');
      const caseId = parts[parts.length - 1];
      if (!caseId || removed.has(caseId)) continue;
      let parsed: Partial<PersistedCase> | null = null;
      try {
        parsed = JSON.parse(store.getItem(key) ?? 'null');
      } catch {
        // A corrupt entry is skipped rather than breaking the whole list. The case
        // loader reports the problem when that case is opened.
        continue;
      }
      if (!parsed) continue;
      const custom = store.getItem(titleKey(scope.sub, caseId));
      const firstUserTurn = (parsed.turns ?? []).find((turn) => turn.prompt)?.prompt;
      out.push({
        id: caseId,
        title: custom ?? deriveConversationTitle(firstUserTurn ?? null),
        updatedAt: parsed.savedAt ?? 0,
        titleIsCustom: custom !== null,
        messageCount: (parsed.turns ?? []).length,
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function renameConversation(
  scope: { sub: string | null },
  id: string,
  title: string
): void {
  if (!scope.sub) return;
  try {
    const trimmed = title.trim();
    if (trimmed === '') {
      // Clearing a custom title returns to derivation rather than leaving it blank.
      storage()?.removeItem(titleKey(scope.sub, id));
      return;
    }
    storage()?.setItem(titleKey(scope.sub, id), trimmed);
  } catch {
    /* best effort */
  }
}

/** Duplicated from ConversationsContext to keep this module free of React imports. */
function deriveConversationTitle(firstMessage: string | null): string {
  const text = (firstMessage ?? '').trim().replace(/\s+/g, ' ');
  if (text === '') return 'New conversation';
  const sentence = text.split(/(?<=[.?!])\s/)[0] ?? text;
  const trimmed = sentence.length > 48 ? `${sentence.slice(0, 47)}…` : sentence;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
