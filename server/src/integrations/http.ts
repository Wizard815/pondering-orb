import { HttpError } from "../records.js";

/** fetch with a timeout and a clear error when the other app is down. */
export async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body, headers: res.headers };
  } catch (e: any) {
    const why = e?.name === "AbortError" ? "timed out" : (e?.cause?.code || e?.message || "failed");
    throw new HttpError(502, `Couldn't reach ${new URL(url).host} (${why}).`);
  } finally { clearTimeout(t); }
}
export const trimSlash = (s: string) => (s || "").replace(/\/+$/, "");
