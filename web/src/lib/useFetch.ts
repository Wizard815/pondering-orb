import { useCallback, useEffect, useState } from "react";
import { get } from "./api";

/** Data from another app through the Orb server (UpstreamManager, Uptime
 *  Kuma, host stats). Refreshes on an interval; keeps the last good answer. */
export function useFetch<T = any>(path: string | null, everyMs = 0) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(!!path), [at, setAt] = useState(0);
  const load = useCallback(async () => {
    if (!path) return; setLoading(true);
    try { setData(await get<T>(path)); setError(""); setAt(Date.now()); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { load(); if (!everyMs) return; const t = setInterval(load, everyMs); return () => clearInterval(t); }, [load, everyMs]);
  return { data, error, loading, reload: load, at };
}
