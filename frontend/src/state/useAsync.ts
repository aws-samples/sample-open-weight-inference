import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** True once at least one attempt has settled. */
  settled: boolean;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
}

/**
 * Run an async task on mount and whenever `deps` change, exposing explicit
 * loading / error / empty states so no panel can render blank.
 */
export function useAsync<T>(
  task: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[]
): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
    settled: false,
  });
  const [nonce, setNonce] = useState(0);
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    taskRef
      .current(controller.signal)
      .then((data) => {
        if (!active) return;
        setState({ data, loading: false, error: null, settled: true });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (controller.signal.aborted) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
          settled: true,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { ...state, reload };
}
