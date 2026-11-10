import { parse } from "yaml";
import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";

/** Your own apps set up as app widgets in the apps YAML (type firefly or
 *  omi, with url and key_env). Firefly III's client is in firefly.ts.
 *  - omi-local: the Developer API (/v1/dev/user/...) with a read-only
 *    omi_dev_ key: daily summaries, conversations, memory search.
 *  Every request here is a GET. Omi's action items are NOT read from Omi:
 *  Omi already writes them to CalDAV (UID omi-task-...@omi-local), and Orb
 *  reads every task from that one CalDAV server, so nothing is listed twice. */
export type Companion = { name: string; url: string; keyEnv?: string; page?: string };

/** The first app of a widget type in the apps YAML. */
export function companion(yaml: string, type: "omi" | "firefly"): Companion | null {
  let c: any = {}; try { c = parse(yaml || "") || {}; } catch { return null; }
  for (const g of Array.isArray(c.groups) ? c.groups : []) for (const a of Array.isArray(g?.apps) ? g.apps : [])
    if (a?.widget?.type === type) return { name: String(a.name), url: String(a.widget.url || a.url || ""), keyEnv: a.widget.key_env || a.widget.keyEnv, page: pageLabel(a.widget.page, type) };
  return null;
}
/** `page: true` (or a tab name) in a widget turns on that app's full page. */
const pageLabel = (v: unknown, type: string) => v === true ? ({ firefly: "Money", omi: "Omi" } as Record<string, string>)[type] : typeof v === "string" && v.trim() ? v.trim().slice(0, 24) : undefined;
/** Every app by name, for the per-app routes. */
export function companionByName(yaml: string, name: string): (Companion & { type: string }) | null {
  for (const type of ["omi", "firefly"] as const) { const c = companion(yaml, type); if (c && c.name === name) return { ...c, type }; }
  return null;
}

async function get(c: Companion, path: string, what: string) {
  const base = trimSlash(c.url); if (!base) throw new HttpError(400, `${c.name} has no url in the apps YAML.`);
  const key = secret(c.keyEnv);
  const r = await call(`${base}${path}`, { method: "GET", headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, `${c.name} refused the key${c.keyEnv ? ` in ${c.keyEnv}` : ""} (${r.status}).`);
  if (!r.ok) throw new HttpError(502, `${c.name} answered ${r.status} for ${what}.`);
  return r.body;
}

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const h = cache.get(key); if (h && Date.now() - h.at < ms) return h.v as T;
  const v = await f(); cache.set(key, { at: Date.now(), v }); return v;
}
export const clearCompanionCache = () => cache.clear();

// ---- omi-local ----
export type OmiDay = { date: string; headline: string; overview: string; emoji: string; stats: Record<string, unknown>; decisions: string[]; questions: string[];
  highlights: { topic: string; emoji: string; summary: string }[]; nuggets: string[] };
const day = (s: any): OmiDay => ({ date: String(s?.date || ""), headline: String(s?.headline || ""), overview: String(s?.overview || ""), emoji: String(s?.day_emoji || ""),
  stats: s?.stats || {}, decisions: (s?.decisions_made || []).map((d: any) => String(d?.decision || "")).filter(Boolean).slice(0, 8),
  questions: (s?.unresolved_questions || []).map((q: any) => String(q?.question || "")).filter(Boolean).slice(0, 8),
  highlights: (s?.highlights || []).map((h: any) => ({ topic: String(h?.topic || ""), emoji: String(h?.emoji || ""), summary: String(h?.summary || "") })).filter((h: any) => h.topic || h.summary).slice(0, 8),
  nuggets: (s?.knowledge_nuggets || []).map((k: any) => String(k?.insight || "")).filter(Boolean).slice(0, 8) });
export async function omiDays(c: Companion, limit = 3, date = "", offset = 0) {
  const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(30, limit))), ...(offset > 0 ? { offset: String(Math.min(1000, offset)) } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? { start_date: date, end_date: date } : {}) });
  return cached(`omi:d:${c.url}:${q}`, 10 * 60000, async () => ((await get(c, `/v1/dev/user/daily-summaries?${q}`, "daily summaries"))?.summaries || []).map(day));
}
export async function omiConversations(c: Companion, limit = 5) {
  return cached(`omi:c:${c.url}:${limit}`, 5 * 60000, async () => {
    const list: any[] = (await get(c, `/v1/dev/user/conversations?limit=${Math.max(1, Math.min(25, limit))}`, "conversations")) || [];
    return list.map(x => ({ id: String(x.id || ""), title: String(x.structured?.title || "Conversation"), overview: String(x.structured?.overview || "").slice(0, 400),
      emoji: String(x.structured?.emoji || ""), at: x.started_at || x.created_at || "" }));
  });
}
export async function omiSearchMemories(c: Companion, query: string, limit = 10) {
  const q = query.trim().slice(0, 500); if (!q) throw new HttpError(400, "Search for something.");
  const r = await get(c, `/v1/dev/user/memories/search?query=${encodeURIComponent(q)}&limit=${Math.max(1, Math.min(20, limit))}`, "memory search");
  return (r?.memories || []).map((m: any) => ({ content: String(m.content || m.memory || m.text || ""), category: m.category || "", at: m.created_at || "" })).filter((m: any) => m.content);
}

/** CalDAV items Omi wrote: tasks (its action items), day reviews and
 *  conversation events. Orb shows the tasks, read only, and keeps the
 *  events out of the calendar views (the Omi panel has them). */
export const isOmiTask = (uid?: string) => !!uid && /^omi-task-.*@omi-local$/.test(uid);
export const isOmiEvent = (uid?: string) => !!uid && /^omi-(day|event)-.*@omi-local$/.test(uid);
