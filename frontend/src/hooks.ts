import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll an async fetcher on an interval for near-live updates (the assignment
 * allows polling or WebSockets; polling keeps the stack simpler and is plenty
 * responsive for a dashboard). Returns data, loading, error and a manual reload.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const savedFetcher = useRef(fetcher);
  savedFetcher.current = fetcher;

  const load = useCallback(async () => {
    try {
      const result = await savedFetcher.current();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => void load(), intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload: load };
}
