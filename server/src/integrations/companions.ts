import { parse } from "yaml";
import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";

/** Read-only clients for two of your own apps, set up as app widgets in the
 *  apps YAML (type goblinbank or omi, with url and key_env):
 *  - Goblin-Bank: CoinGateway's /api/v1/summary with its read-only Orb key
 *    (scope summary:read). Each person decides what's in it (`share:`), and
 *    no transactions ever leave Goblin-Bank.
 *  - omi-local: the Developer API (/v1/dev/user/...) with a read-only
 *    omi_dev_ key: daily summaries, conversations, memory search.
 *  Every request here is a GET. Omi's action items are NOT read from Omi:
 *  Omi already writes them to CalDAV (UID omi-task-...@omi-local), and Orb
 *  reads every task from that one CalDAV server, so nothing is listed twice. */
export type Companion = { name: string; url: string; keyEnv?: string; page?: string };

/** The first app of a widget type in the apps YAML. */
export function companion(yaml: string, type: "goblinbank" | "omi"): Companion | null {
  let c: any = {}; try { c = parse(yaml || "") || {}; } catch { return null; }
  for (const g of Array.isArray(c.groups) ? c.groups : []) for (const a of Array.isArray(g?.apps) ? g.apps : [])
    if (a?.widget?.type === type) return { name: String(a.name), url: String(a.widget.url || a.url || ""), keyEnv: a.widget.key_env || a.widget.keyEnv, page: pageLabel(a.widget.page, type) };
  return null;
}
/** `page: true` (or a tab name) in a widget turns on that app's full page. */
const pageLabel = (v: unknown, type: string) => v === true ? (type === "goblinbank" ? "Money" : "Omi") : typeof v === "string" && v.trim() ? v.trim().slice(0, 24) : undefined;
/** Every app by name, for the per-app routes. */
export function companionByName(yaml: string, name: string): (Companion & { type: string }) | null {
  for (const type of ["goblinbank", "omi"] as const) { const c = companion(yaml, type); if (c && c.name === name) return { ...c, type }; }
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

// ---- Goblin-Bank ----
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Equity from a balances object, whatever shape the connector gave. */
function equity(b: any): number | null {
  if (!b || typeof b !== "object") return num(b);
  for (const k of ["equity", "total_equity", "portfolio_value", "total", "market_value"]) { const v = num(Number(b[k])); if (v !== null && b[k] !== undefined && b[k] !== null) return v; }
  return null;
}
export type Bill = { date: string; name: string; amount: number; category: string; paidBy: string; person: string };
export type MoneyAlert = { severity: "critical" | "warning" | "info"; kind: string; title: string; detail: string; person: string };
export type MoneyPerson = { name: string; error?: string; netWorth: number | null; subscriptionsMonthly: number | null;
  robinhoodMain: { asOf: string; source: string; equity: number | null } | null; robinhoodAgent: { asOf: string; equity: number | null } | null;
  /** Bills due, alert counts, savings and goal progress: each is null unless that person shares it. Totals only, never transactions. */
  bills: { next7d: number | null; next30d: number | null; next: { name: string; date: string; amount: number | null } | null } | null;
  alerts: { total: number; critical: number; warning: number } | null;
  savings: { total: number | null; free: number | null; earmarked: number | null } | null;
  goals: { name: string; target: number | null; allocated: number | null; pct: number | null }[] | null;
  /** The itemised lists, separate opt-ins in Goblin-Bank (bill_list, alert_list). */
  billList: Bill[] | null; alertList: MoneyAlert[] | null };
const NONE = { bills: null, alerts: null, savings: null, goals: null, billList: null, alertList: null };
const SEV = ["critical", "warning", "info"];
function shareable(g: any): Pick<MoneyPerson, "bills" | "alerts" | "savings" | "goals" | "spending"> {
  return {
    bills: g.bills && typeof g.bills === "object" ? { next7d: num(g.bills.next_7d), next30d: num(g.bills.next_30d),
      next: g.bills.next && typeof g.bills.next === "object" ? { name: String(g.bills.next.name || ""), date: String(g.bills.next.date || ""), amount: num(g.bills.next.amount) } : null } : null,
    alerts: g.alerts && typeof g.alerts === "object" ? { total: Number(g.alerts.total) || 0, critical: Number(g.alerts.critical) || 0, warning: Number(g.alerts.warning) || 0 } : null,
    savings: g.savings && typeof g.savings === "object" ? { total: num(g.savings.total), free: num(g.savings.free), earmarked: num(g.savings.earmarked) } : null,
    spending: g.spending && typeof g.spending === "object" ? { soFar: num(g.spending.so_far), projected: num(g.spending.projected), incomeAvg: num(g.spending.income_avg), pctProjected: num(g.spending.pct_projected), leftAfter: num(g.spending.left_after), confidence: String(g.spending.confidence || "") } : null,
    goals: Array.isArray(g.goals) ? g.goals.slice(0, 12).map((x: any) => ({ name: String(x?.name || ""), target: num(x?.target), allocated: num(x?.allocated), pct: num(x?.pct) })).filter((x: any) => x.name) : null,
  };
}
export async function goblinSummary(c: Companion) {
  return cached(`gb:${c.url}`, 5 * 60000, async () => {
    const body = await get(c, "/api/v1/summary", "the summary");
    const people: MoneyPerson[] = Object.entries(body?.goblins || {}).map(([name, g]: [string, any]) => g?.error ? { name, error: String(g.error), netWorth: null, subscriptionsMonthly: null, robinhoodMain: null, robinhoodAgent: null, ...NONE } : {
      name, netWorth: num(g.net_worth), subscriptionsMonthly: num(g.subscriptions_monthly),
      robinhoodMain: g.robinhood_main ? { asOf: String(g.robinhood_main.as_of || ""), source: String(g.robinhood_main.source || ""), equity: equity(g.robinhood_main.balances) } : null,
      robinhoodAgent: g.robinhood_agent ? { asOf: String(g.robinhood_agent.as_of || ""), equity: equity(g.robinhood_agent.balances) } : null,
      ...shareable(g),
      billList: Array.isArray(g.bill_list) ? g.bill_list.slice(0, 200).map((b: any) => ({ date: String(b?.date || ""), name: String(b?.name || ""), amount: Number(b?.amount) || 0, category: String(b?.category || ""), paidBy: String(b?.paid_by || "me"), person: name })).filter((b: any) => b.name && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) : null,
      alertList: Array.isArray(g.alert_list) ? g.alert_list.slice(0, 50).map((a: any) => ({ severity: (SEV.includes(a?.severity) ? a.severity : "info") as MoneyAlert["severity"], kind: String(a?.kind || ""), title: String(a?.title || ""), detail: String(a?.detail || ""), person: name })).filter((a: any) => a.title) : null,
    });
    const shared = people.filter(p => p.netWorth !== null);
    const bills = people.flatMap(p => p.billList || []).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    const alerts = people.flatMap(p => p.alertList || []).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
    return { people, netWorth: shared.length ? +shared.reduce((a, p) => a + p.netWorth!, 0).toFixed(2) : null, bills, alerts, at: Date.now() };
  });
}

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
