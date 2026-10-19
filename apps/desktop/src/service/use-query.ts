import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { describeError, log, type PosService } from '@pos/shared';
import { useDataVersion } from '../store/data-version';
import { useService } from './context';

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fn(service)` on mount, when `deps` change, and whenever any write bumps `dataVersion`.
 * Stale responses are ignored; previous data stays visible while refetching (no flicker).
 */
export function useServiceQuery<T>(
  fn: (service: PosService) => Promise<T>,
  deps: DependencyList,
  enabled = true,
): QueryState<T> {
  const service = useService();
  const version = useDataVersion((s) => s.version);
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    run.current += 1;
    const id = run.current;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    fnRef
      .current(service)
      .then((data) => {
        if (id === run.current) setState({ data, error: undefined, loading: false });
      })
      .catch((error: unknown) => {
        log.warn('query.failed', { stale: id !== run.current, error: describeError(error) });
        if (id === run.current) setState((s) => ({ data: s.data, error, loading: false }));
      });
  }, [service, version, tick, enabled, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
