import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './AppContext';
import {
  clearCase, loadCase, projectDraftFingerprint, type PersistScope, type ProjectDocument,
  type SavedProject,
} from './persistence';

export interface ProjectSaveState {
  saving: boolean;
  loading: boolean;
  ready: boolean;
  dirty: boolean;
  savedAt: string | null;
  savedDocument: ProjectDocument | null;
  revision: string | null;
  error: string | null;
  conflict: boolean;
  save: () => Promise<boolean>;
  reload: () => Promise<void>;
  download: () => void;
  /** Explicit leave-without-saving choice; never deletes the account's project. */
  discardBeforeLeaving: () => boolean;
}

/**
 * The browser is a draft cache. Save acknowledges an authenticated conditional
 * write to the account. A late response never replaces text typed during a load,
 * and edits made during a save remain dirty after that save finishes.
 */
export function useProjectSave({
  scope, document, restored, apply,
}: {
  scope: PersistScope;
  document: ProjectDocument;
  restored: boolean;
  apply: (document: ProjectDocument) => void;
}): ProjectSaveState {
  const { client } = useApp();
  const [saved, setSaved] = useState<SavedProject | null>(null);
  const [revision, setRevision] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const current = useRef(document);
  current.current = document;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const identity = `${scope.userPoolId}:${scope.sub}:${scope.caseId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const fingerprint = projectDraftFingerprint(document);
  const savedFingerprint = saved ? projectDraftFingerprint(saved.document) : null;

  const load = useCallback(async (force: boolean, signal?: AbortSignal) => {
    const requestIdentity = identity;
    const requestGeneration = ++generation.current;
    const before = projectDraftFingerprint(current.current);
    setLoading(true);
    setError(null);
    try {
      const response = await client.getSavedProject(scope.caseId, signal);
      if (signal?.aborted || currentIdentity.current !== requestIdentity ||
          requestGeneration !== generation.current) return;
      if (!response || !('project' in response)) {
        throw new Error('EDDIE did not return a valid saved project.');
      }
      const project = response.project;
      if (response.removed) {
        // Old bookmarks and stale tabs must not restore a removed browser draft.
        window.dispatchEvent(new CustomEvent('eddie:project-removed', {
          detail: { caseId: scope.caseId },
        }));
        setRevision(undefined);
        setConflict(true);
        setError('This project has been removed from your list.');
        return;
      }
      if (project && (!project.document?.form || !Array.isArray(project.document.turns))) {
        throw new Error('The saved project could not be read. Your current draft has been kept.');
      }
      const local = loadCase(scope).data;
      const localHasWork = Boolean(local && (
        local.form.description || local.form.modelName || local.turns.length || local.draft
      ));
      const matchesSaved = project &&
        projectDraftFingerprint(project.document) === projectDraftFingerprint(current.current);
      const basedOnSaved = project && local?.cloudRevision === project.revision;
      const changedWhileLoading = before !== projectDraftFingerprint(current.current);
      if (project && !force && !matchesSaved &&
          (changedWhileLoading || (localHasWork && !basedOnSaved))) {
        setSaved(project);
        setRevision(undefined);
        setConflict(true);
        setError('A saved project and a different browser draft exist. Download your draft before loading the saved version.');
        return;
      }
      setSaved(project);
      setRevision(project?.revision ?? null);
      setConflict(false);
      if (project && (force || (!basedOnSaved && !changedWhileLoading))) apply(project.document);
    } catch (cause) {
      if (signal?.aborted || currentIdentity.current !== requestIdentity) return;
      setError(cause instanceof Error ? cause.message : 'Could not open the saved project.');
    } finally {
      if (!signal?.aborted && currentIdentity.current === requestIdentity &&
          requestGeneration === generation.current) setLoading(false);
    }
  }, [client, scope, identity, apply]);

  useEffect(() => {
    if (!restored || !scope.sub) return;
    const controller = new AbortController();
    setSaved(null);
    setRevision(undefined);
    setConflict(false);
    void load(false, controller.signal);
    return () => { controller.abort(); generation.current += 1; };
  }, [identity, restored, scope.sub, load]);

  const save = useCallback(async () => {
    if (inFlight.current || loading || conflict || !scope.sub) return false;
    if (revision === undefined) {
      await load(false);
      // Loading establishes an acknowledged base. A second explicit save avoids
      // using stale closure state or overwriting a newly discovered cloud version.
      return false;
    }
    const requestIdentity = identity;
    const submitted = current.current;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.saveProject(scope.caseId, submitted, revision);
      if (currentIdentity.current !== requestIdentity) return false;
      if (!response.project?.revision) throw new Error('The save was not confirmed. Your draft has been kept.');
      setSaved(response.project);
      setRevision(response.project.revision);
      setConflict(false);
      window.dispatchEvent(new Event('eddie:project-saved'));
      return projectDraftFingerprint(current.current) === projectDraftFingerprint(submitted);
    } catch (cause) {
      if (currentIdentity.current !== requestIdentity) return false;
      if ((cause as { code?: string }).code === 'save_conflict') setConflict(true);
      setError(cause instanceof Error ? cause.message : 'Save failed. Your draft has been kept.');
      return false;
    } finally {
      inFlight.current = false;
      if (currentIdentity.current === requestIdentity) setSaving(false);
    }
  }, [client, scope.caseId, scope.sub, revision, loading, conflict, identity, load]);

  const download = useCallback(() => {
    const blob = new Blob([JSON.stringify({
      format: 'eddie-project', version: 1, caseId: scope.caseId,
      exportedAt: new Date().toISOString(), document: current.current,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `eddie-${scope.caseId}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [scope.caseId]);

  const discardBeforeLeaving = useCallback(() => {
    // Navigation immediately unmounts this project's provider. Removing only this
    // scoped backup ensures reopening loads the saved version, not the discarded
    // browser edits. A failed removal keeps the current project open.
    const problem = clearCase(scope);
    if (problem) setError(problem.message);
    return problem === null;
  }, [scope]);

  return {
    saving, loading, ready: revision !== undefined || Boolean(error) || conflict,
    dirty: fingerprint !== savedFingerprint,
    savedAt: saved?.savedAt ?? null, savedDocument: saved?.document ?? null,
    revision: revision ?? null, error, conflict, save,
    reload: () => load(true), download, discardBeforeLeaving,
  };
}
