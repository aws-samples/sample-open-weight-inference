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
import { useApp } from './AppContext';
import { useAuth } from '../auth/AuthContext';
import {
  listSavedConversations, rememberRemovedProjects, removedProjectIds, renameConversation,
  type SavedProject,
} from './persistence';

/**
 * Saved conversations, for the sidebar.
 *
 * UXR-01 puts recent conversations in the navigation, which needs two things the old
 * design did not have: a **human title** and a stable id per conversation. The previous
 * shell surfaced `case-001` — a fixed identifier shared by every case, so there was
 * only ever one, and "recent conversations" could not exist.
 *
 * Titles are derived from the first thing the user said, because asking someone to name
 * a conversation before they have had it is a worse experience than showing them what
 * they wrote. A title can be edited; an edited title is never overwritten by derivation.
 *
 * `attentionCount` is read from deployments rather than conversations. It is here
 * because the sidebar badge belongs next to Deployments and the shell should not have to
 * know how to fetch it.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Custom and account-saved titles take precedence over chat title derivation. */
  titleIsCustom: boolean;
  messageCount: number;
}

interface ConversationsValue {
  conversations: ConversationSummary[];
  /** Deployments needing an operator's attention, for the sidebar badge. */
  attentionCount: number;
  refresh: () => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => Promise<void>;
  removedIds: ReadonlySet<string>;
  /** Recorded by the workspace so the sidebar updates without a reload. */
  touch: (id: string, firstMessage: string | null, messageCount: number) => void;
}

const ConversationsContext = createContext<ConversationsValue | null>(null);

/** A readable title from the opening message. */
export function deriveTitle(firstMessage: string | null): string {
  const text = (firstMessage ?? '').trim().replace(/\s+/g, ' ');
  if (text === '') return 'New conversation';
  // First sentence or 48 characters, whichever is shorter. Long enough to tell two
  // conversations apart in a sidebar, short enough not to wrap.
  const sentence = text.split(/(?<=[.?!])\s/)[0] ?? text;
  const trimmed = sentence.length > 48 ? `${sentence.slice(0, 47)}…` : sentence;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { client, config } = useApp();
  const { session } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [attentionCount, setAttentionCount] = useState(0);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const removedRef = useRef<ReadonlySet<string>>(new Set());
  const readGeneration = useRef(0);

  const scope = useMemo(
    () => ({ sub: session?.sub ?? null, userPoolId: config.userPoolId }),
    [session?.sub, config.userPoolId]
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;

  const markRemoved = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const removed = new Set([...removedRef.current, ...ids]);
    removedRef.current = removed;
    setRemovedIds(removed);
    rememberRemovedProjects(scope, ids);
    setConversations((current) => current.filter((item) => !removed.has(item.id)));
  }, [scope]);

  const refresh = useCallback(() => {
    setConversations((current) => {
      const combined = new Map(listSavedConversations(scope).map((item) => [item.id, item]));
      for (const item of current) combined.set(item.id, item);
      return [...combined.values()].filter((item) => !removedRef.current.has(item.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, [scope]);

  useEffect(() => {
    const removed = new Set(removedProjectIds(scope));
    removedRef.current = removed;
    setRemovedIds(removed);
    setConversations(listSavedConversations(scope));
    const controller = new AbortController();
    const readSaved = async () => {
      const generation = ++readGeneration.current;
      try {
        const projects: Omit<SavedProject, 'document'>[] = [];
        const removedCaseIds: string[] = [];
        let afterCaseId: string | undefined;
        const cursors = new Set<string>();
        do {
          const response = await client.listSavedProjects(controller.signal, afterCaseId);
          if (controller.signal.aborted || generation !== readGeneration.current || !Array.isArray(response.projects)) return;
          projects.push(...response.projects);
          removedCaseIds.push(...(response.removedCaseIds ?? []));
          afterCaseId = response.nextCaseId ?? undefined;
          if (afterCaseId && cursors.has(afterCaseId)) throw new Error('Project list cursor repeated.');
          if (afterCaseId) cursors.add(afterCaseId);
        } while (afterCaseId);
        markRemoved(removedCaseIds);
        setConversations((current) => {
          const summaries = projects.map((project) => ({
            id: project.caseId, title: project.title, updatedAt: Date.parse(project.savedAt),
            // Opening an empty Advisor must not rename a saved project.
            titleIsCustom: true, messageCount: 0,
          }));
          return [...summaries, ...current.filter((item) => !summaries.some((saved) => saved.id === item.id))]
            .filter((item) => !removedRef.current.has(item.id))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        });
      } catch {
        // Project saving surfaces connection errors with a retry. Navigation
        // retains the local list and never invents a successful cloud read.
      }
    };
    const onRemoved = (event: Event) => {
      const id: unknown = (event as CustomEvent<{ caseId: string }>).detail?.caseId;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) markRemoved([id]);
    };
    const onStorage = () => markRemoved(removedProjectIds(scope));
    void readSaved();
    window.addEventListener('eddie:project-saved', readSaved);
    window.addEventListener('eddie:project-removed', onRemoved);
    window.addEventListener('storage', onStorage);
    return () => {
      controller.abort();
      readGeneration.current += 1;
      window.removeEventListener('eddie:project-saved', readSaved);
      window.removeEventListener('eddie:project-removed', onRemoved);
      window.removeEventListener('storage', onStorage);
    };
  }, [scope, client, markRemoved]);

  const remove = useCallback(async (id: string) => {
    // Read the current saved revision even for browser-only drafts. A project
    // saved by another device must not be removed using an assumed empty base.
    const response = await client.getSavedProject(id);
    if (currentScope.current !== scope) throw new Error('Your account changed. Please try again.');
    if (!response || !('project' in response)) throw new Error('Could not check the project. Please try again.');
    const confirmation = response.removed
      ? { caseId: id, removed: true }
      : await client.removeProject(id, response.project?.revision ?? null);
    if (currentScope.current !== scope) return;
    if (confirmation.caseId !== id || confirmation.removed !== true) {
      throw new Error('Removal was not confirmed. Your project is still in the list.');
    }
    markRemoved([id]);
  }, [client, scope, markRemoved]);

  // Deployments needing attention. Read once on mount and after a refresh rather than
  // polled: an unbounded poll on a navigation badge is exactly the kind of background
  // cost the performance requirements rule out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await client.listDeployments();
        if (cancelled) return;
        const needing = response.deployments.filter((deployment) =>
          ['CLEANUP_INCOMPLETE', 'FAILED'].includes(deployment.state)
        );
        setAttentionCount(needing.length);
      } catch {
        // A failure here must not break navigation. The Deployments page reports the
        // error properly; a badge is not the place to surface it.
        if (!cancelled) setAttentionCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const rename = useCallback(
    (id: string, title: string) => {
      renameConversation(scope, id, title);
      const local = listSavedConversations(scope).find((item) => item.id === id);
      setConversations((current) => current.map((item) => item.id === id ? {
        ...item,
        title: title.trim() || local?.title || deriveTitle(null),
        titleIsCustom: Boolean(title.trim()),
      } : item));
      refresh();
    },
    [scope, refresh]
  );

  const touch = useCallback(
    (id: string, firstMessage: string | null, messageCount: number) => {
      if (removedRef.current.has(id)) return;
      setConversations((current) => {
        const existing = current.find((c) => c.id === id);
        const title =
          existing?.title && (existing.titleIsCustom || !firstMessage?.trim())
            ? existing.title
            : deriveTitle(firstMessage);
        const updated: ConversationSummary = {
          id,
          title,
          updatedAt: Date.now(),
          titleIsCustom: existing?.titleIsCustom ?? false,
          messageCount,
        };
        const rest = current.filter((c) => c.id !== id);
        return [updated, ...rest];
      });
    },
    []
  );

  const value = useMemo(
    () => ({ conversations, attentionCount, refresh, rename, touch, remove, removedIds }),
    [conversations, attentionCount, refresh, rename, touch, remove, removedIds]
  );

  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversations(): ConversationsValue {
  const value = useContext(ConversationsContext);
  if (value === null) {
    throw new Error('useConversations must be used inside ConversationsProvider');
  }
  return value;
}
