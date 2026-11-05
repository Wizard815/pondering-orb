/** Thin wrapper over the Orb server API. Errors carry the server's message. */
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `The server answered ${res.status}.`);
  return data as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
